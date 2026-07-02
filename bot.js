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

const runtimes = new Map();

async function logAgent(agentId, type, message) {
    const cfg = require('./config');
    try {
        await cfg.logs_col.insertOne({ agent_id: String(agentId), type, message, created_at: new Date() });
    } catch (e) {
        console.error(`[AgentLog ${agentId}]`, e.message);
    }
}

async function startAgent(agent) {
    const id = String(agent._id || agent.id || 'default');
    if (runtimes.has(id)) return runtimes.get(id);
    try {
        const runtime = await startAgentRuntime(agent);
        runtimes.set(id, runtime);
        await logAgent(id, 'start', 'تم تشغيل الوكيل');
        return runtime;
    } catch (e) {
        await logAgent(id, 'error', e.message);
        console.error(`[Agent ${id}] start failed:`, e);
        return null;
    }
}

async function stopAgent(agentId) {
    const id = String(agentId);
    const runtime = runtimes.get(id);
    if (!runtime) return false;
    try {
        runtime.stop();
        runtimes.delete(id);
        await logAgent(id, 'stop', 'تم إيقاف الوكيل');
        return true;
    } catch (e) {
        await logAgent(id, 'error', e.message);
        return false;
    }
}

async function ensureLegacyDefaultAgent() {
    const cfg = require('./config');
    const count = await cfg.agents_col.countDocuments();
    if (count > 0) return;
    if (!USER_TOKEN || !DEEPSEEK_TOKEN) return;
    await cfg.agents_col.insertOne({
        name: 'default',
        discord_token: USER_TOKEN,
        deepseek_token: DEEPSEEK_TOKEN,
        personality: '',
        status: 'running',
        token_type: 'bot',
        created_at: new Date(),
        updated_at: new Date(),
    });
}

async function createAgent({ name, discord_token, deepseek_token, personality = '', token_type = 'bot' }) {
    const cfg = require('./config');
    const doc = { name, discord_token, deepseek_token, personality, token_type, status: 'stopped', created_at: new Date(), updated_at: new Date() };
    const res = await cfg.agents_col.insertOne(doc);
    return { ...doc, _id: res.insertedId };
}

async function deleteAgent(agentId) {
    await stopAgent(agentId);
    const cfg = require('./config');
    await cfg.agents_col.deleteOne({ _id: new ObjectId(agentId) });
    await logAgent(agentId, 'delete', 'تم حذف الوكيل');
}

async function setAgentStatus(agentId, status) {
    const cfg = require('./config');
    await cfg.agents_col.updateOne({ _id: new ObjectId(agentId) }, { $set: { status, updated_at: new Date() } });
}

async function bootAgents() {
    await connectMongo();
    await ensureLegacyDefaultAgent();
    const cfg = require('./config');
    const agents = await cfg.agents_col.find({ status: 'running' }).toArray();
    for (const agent of agents) {
        startAgent(agent);
    }
    console.log(`✅ Agent manager ready — running ${agents.length} agents`);
}

module.exports = {
    runtimes,
    startAgent,
    stopAgent,
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
