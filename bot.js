/**
 * bot.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * مدير تشغيل عدة وكلاء مستقلين
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { ObjectId } = require('mongodb');
const { USER_TOKEN, DEEPSEEK_TOKEN, connectMongo } = require('./config');
const { startAgentRuntime } = require('./agentRuntime');

const LIFECYCLE = Object.freeze({
    STARTING   : 'starting',
    RUNNING    : 'running',
    STOPPING   : 'stopping',
    STOPPED    : 'stopped',
    RESTARTING : 'restarting',
    FAILED     : 'failed',
});

const runtimes = new Map();
const reconnectTimers = new Map();

async function logAgent(agentId, type, message, extra = {}) {
    const cfg = require('./config');
    try {
        await cfg.logs_col.insertOne({
            agent_id  : String(agentId),
            type,
            message,
            extra,
            created_at: new Date(),
        });
    } catch (e) {
        console.error(`[AgentLog ${agentId}]`, e.message);
    }
}

async function setAgentStatus(agentId, status, extra = {}) {
    const cfg = require('./config');
    await cfg.agents_col.updateOne(
        { _id: new ObjectId(agentId) },
        { $set: { status, status_reason: extra.reason || '', updated_at: new Date() } },
    );
}

async function cleanupRuntime(agentId) {
    const id = String(agentId);
    const timer = reconnectTimers.get(id);
    if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(id);
    }
    const runtime = runtimes.get(id);
    if (runtime) {
        try {
            runtime.stop();
        } catch (_) {}
        runtimes.delete(id);
    }
}

async function scheduleReconnect(agentId, reason = 'unexpected disconnect') {
    const id = String(agentId);
    if (reconnectTimers.has(id)) return;
    await logAgent(id, 'reconnect_scheduled', reason);
    const timer = setTimeout(async () => {
        reconnectTimers.delete(id);
        const cfg = require('./config');
        const agent = await cfg.agents_col.findOne({ _id: new ObjectId(id) });
        if (!agent || agent.status === LIFECYCLE.STOPPED || agent.status === LIFECYCLE.STOPPING) return;
        await restartAgent(id, reason);
    }, 10_000);
    reconnectTimers.set(id, timer);
}

async function startAgent(agent) {
    const id = String(agent._id || agent.id || 'default');
    if (runtimes.has(id)) return runtimes.get(id);
    try {
        await setAgentStatus(id, LIFECYCLE.STARTING);
        await logAgent(id, 'starting', 'بدء تشغيل الوكيل');
        const runtime = await startAgentRuntime({
            ...agent,
            onReady: async () => {
                await setAgentStatus(id, LIFECYCLE.RUNNING);
                await logAgent(id, 'running', 'تم اتصال الوكيل');
            },
            onError: async (err) => {
                await logAgent(id, 'error', err?.message || String(err));
            },
            onUnexpectedDisconnect: async (reason) => {
                await scheduleReconnect(id, reason);
            },
        });
        runtimes.set(id, runtime);
        return runtime;
    } catch (e) {
        await cleanupRuntime(id);
        await setAgentStatus(id, LIFECYCLE.FAILED, { reason: e.message });
        await logAgent(id, 'failed', e.message);
        console.error(`[Agent ${id}] start failed:`, e);
        return null;
    }
}

async function stopAgent(agentId) {
    const id = String(agentId);
    try {
        await setAgentStatus(id, LIFECYCLE.STOPPING);
        await logAgent(id, 'stopping', 'بدء إيقاف الوكيل');
        await cleanupRuntime(id);
        await setAgentStatus(id, LIFECYCLE.STOPPED);
        await logAgent(id, 'stopped', 'تم إيقاف الوكيل');
        return true;
    } catch (e) {
        await setAgentStatus(id, LIFECYCLE.FAILED, { reason: e.message });
        await logAgent(id, 'failed', e.message);
        return false;
    }
}

async function restartAgent(agentId, reason = 'restart requested') {
    const id = String(agentId);
    const cfg = require('./config');
    try {
        await setAgentStatus(id, LIFECYCLE.RESTARTING, { reason });
        await logAgent(id, 'restarting', reason);
        await cleanupRuntime(id);
        const fresh = await cfg.agents_col.findOne({ _id: new ObjectId(id) });
        if (!fresh) throw new Error('الوكيل غير موجود');
        return await startAgent({ ...fresh, status: LIFECYCLE.RUNNING });
    } catch (e) {
        await cleanupRuntime(id);
        await setAgentStatus(id, LIFECYCLE.FAILED, { reason: e.message });
        await logAgent(id, 'failed', e.message);
        return null;
    }
}

async function ensureLegacyDefaultAgent() {
    const cfg = require('./config');
    const count = await cfg.agents_col.countDocuments();
    if (count > 0) return;
    if (!USER_TOKEN || !DEEPSEEK_TOKEN) return;
    await cfg.agents_col.insertOne({
        name          : 'default',
        discord_token : USER_TOKEN,
        deepseek_token: DEEPSEEK_TOKEN,
        personality   : '',
        status        : LIFECYCLE.RUNNING,
        token_type    : 'bot',
        legacy        : true,
        created_at    : new Date(),
        updated_at    : new Date(),
    });
}

async function createAgent({ name, discord_token, deepseek_token, personality = '', token_type = 'bot' }) {
    const cfg = require('./config');
    const doc = { name, discord_token, deepseek_token, personality, token_type, status: LIFECYCLE.STOPPED, created_at: new Date(), updated_at: new Date() };
    const res = await cfg.agents_col.insertOne(doc);
    return { ...doc, _id: res.insertedId };
}

async function deleteAgent(agentId) {
    await cleanupRuntime(agentId);
    const cfg = require('./config');
    await cfg.agents_col.deleteOne({ _id: new ObjectId(agentId) });
    await logAgent(agentId, 'delete', 'تم حذف الوكيل');
}

async function bootAgents() {
    await connectMongo();
    await ensureLegacyDefaultAgent();
    const cfg = require('./config');
    const agents = await cfg.agents_col.find({ status: LIFECYCLE.RUNNING }).toArray();
    for (const agent of agents) {
        startAgent(agent);
    }
    console.log(`✅ Agent manager ready — running ${agents.length} agents`);
}

module.exports = {
    LIFECYCLE,
    runtimes,
    startAgent,
    stopAgent,
    restartAgent,
    createAgent,
    deleteAgent,
    setAgentStatus,
    bootAgents,
};

if (require.main === module) {
    bootAgents().catch((err) => {
        console.error('❌ فشل تشغيل مدير الوكلاء:', err);
        process.exit(1);
    });
}
