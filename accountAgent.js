'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { isTextChannel, isUserRuntime } = require('./discordAdapter');
const { runAgent } = require('./tools');
const { buildBotContext, db_load_channel_session, db_save_channel_session, getAccessLevel } = require('./utils');

const DEFAULT_ACCOUNT_SETTINGS = Object.freeze({
    dm_channel_id: null,
    mention_channel_id: null,
    event_channel_id: null,
    deliveries_channel_id: '1302635629108269177',
    event_role_id: '1339697461878456381',
    mode: 'manual',
    manual_default_count: 1,
    manual_default_minutes: 0,
    auto_min_messages_10m: 3,
    auto_inactivity_minutes: 20,
    auto_run_count: 3,
    auto_run_minutes: 0,
    schedule_slots: [],
    event_wait_ms: 10000,
    first_event_announces_everyone: true,
    games: [
        { name: 'مافيا', command: '+مافيا', bot_id: '1508592252220477651', first_reward: '5m', reward: '1m' },
        { name: 'الجاسوس', command: '+الجاسوس', bot_id: '1508592252220477651', first_reward: '5m', reward: '1m' },
        { name: 'محبس', command: '+محبس', bot_id: '1508592252220477651', first_reward: '5m', reward: '1m' },
        { name: 'روليت', command: '.روليت', bot_id: '1006332825571692544', first_reward: '5m', reward: '1m' },
        { name: 'لغم', command: '.لغم', bot_id: '1006332825571692544', first_reward: '5m', reward: '1m' },
        { name: 'غميضه', command: '.غميضه', bot_id: '1006332825571692544', first_reward: '5m', reward: '1m' },
        { name: 'حجرة', command: '.حجرة', bot_id: '1006332825571692544', first_reward: '5m', reward: '1m' },
        { name: 'سباق', command: '.سباق', bot_id: '1006332825571692544', first_reward: '5m', reward: '1m' },
        { name: 'كراسي', command: '.كراسي', bot_id: '1006332825571692544', first_reward: '5m', reward: '1m' },
    ],
});

const WIN_RE = /(فاز|فوز|فوزي|فائزة|فائز|الفائز|الفائزة|ربح|نتيجة|انتهت|انتهى)/i;
const bridge = new Map();
const memory = new Map();
const activity = new Map();
const autoLocks = new Map();
const scheduledLoops = new Map();


function humanizeDisplayName(name) {
    const raw = String(name || '').trim();
    const compact = raw
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[._~`^*|\[\]{}()<>،,؛:;!؟?\-_=+]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (/^s\s*u\s*k\s*u\s*n\s*a$/i.test(compact)) return 'سوكونا';
    return compact || raw || 'صاحب الحساب';
}

function mergeSettings(doc) {
    return { ...DEFAULT_ACCOUNT_SETTINGS, ...(doc?.account || {}) };
}

async function getAccountSettings(agentId, guildId) {
    const cfg = require('./config');
    const doc = await cfg.settings_col.findOne({ agent_id: String(agentId), guild_id: String(guildId) }).catch(() => null);
    return mergeSettings(doc);
}

async function updateAccountSettings(agentId, guildId, patch) {
    const cfg = require('./config');
    await cfg.settings_col.updateOne(
        { agent_id: String(agentId), guild_id: String(guildId) },
        { $set: Object.fromEntries(Object.entries(patch).map(([k, v]) => [`account.${k}`, v])), $setOnInsert: { created_at: new Date() } },
        { upsert: true },
    );
}

function startHumanTyping(channel, text) {
    const length = String(text || '').length;
    const delay = Math.min(12000, Math.max(800, length * 45));
    let stopped = false;
    const tick = () => { if (!stopped && channel?.sendTyping) channel.sendTyping().catch(() => {}); };
    tick();
    const timer = setInterval(tick, 7000);
    return new Promise(resolve => setTimeout(() => { stopped = true; clearInterval(timer); resolve(); }, delay));
}

async function forwardMessage(client, message, targetChannelId, kind) {
    const target = await client.channels.fetch(String(targetChannelId)).catch(() => null);
    if (!target || !isTextChannel(target)) return false;
    const emb = new EmbedBuilder()
        .setTitle(kind === 'dm' ? '📩 رسالة خاصة للحساب' : '🔔 منشن/رد على الحساب')
        .setDescription((message.content || '—').slice(0, 3900))
        .addFields(
            { name: 'المرسل', value: `${message.author.tag || message.author.username} (${message.author.id})`, inline: false },
            { name: 'الأصل', value: message.url || `${message.channel?.id || 'DM'} / ${message.id}`, inline: false },
            { name: 'المرفقات', value: message.attachments?.size ? message.attachments.map(a => `[${a.name}](${a.url})`).join('\n').slice(0, 900) : 'لا يوجد', inline: false },
            { name: 'طريقة التحكم', value: 'رد على هذه الرسالة لإرسال رد مباشر. ابدأ بـ `!noreply` للإرسال بدون Reply، أو `!ai` للرد بالذكاء، أو `!ai !noreply` للذكاء بدون Reply.', inline: false },
        )
        .setTimestamp();
    const sent = await target.send({ embeds: [emb], components: safeRows(kind) }).catch(() => null);
    if (!sent) return false;
    bridge.set(sent.id, { kind, source_channel_id: message.channel.id, source_message_id: message.id, guild_id: message.guild?.id || null, author_id: message.author.id, created_at: Date.now() });
    return true;
}

function safeRows(kind) {
    try {
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`acct:${kind}:ai_reply`).setLabel('AI Reply').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`acct:${kind}:ai_noreply`).setLabel('AI No Reply').setStyle(ButtonStyle.Secondary),
        )];
    } catch (_) { return []; }
}

async function generateAiReply({ client, runtime, sourceMessage, controlMessage, replyMode }) {
    const guild = sourceMessage.guild || controlMessage.guild;
    const channel = sourceMessage.channel;
    const userInfo = `[معلومات المستخدم]\n  الاسم: ${sourceMessage.author.username}\n  الـ ID: ${sourceMessage.author.id}\n  المصدر: ${sourceMessage.guild ? '#' + sourceMessage.channel.name : 'DM'}\n`;
    const botContext = guild ? await buildBotContext(client, guild, channel, runtime.agentId, runtime.allowed_channels_cache) : '[DM Context]';
    const key = `${runtime.agentId}:${guild?.id || 'dm'}:${channel.id}`;
    let cs = memory.get(key) || await db_load_channel_session(guild?.id || 'dm', channel.id, runtime.agentId) || { session_id: null, parent_message_id: null, mode: 'account', thinking: false };
    const result = await runAgent(guild, channel, sourceMessage.content || '', userInfo, botContext, humanizeDisplayName(client.user.displayName || client.user.username), cs.session_id, cs.parent_message_id, guild?.id || 'dm', 'account', false, 'owner', client, runtime);
    cs = { ...cs, session_id: result.newSid, parent_message_id: result.newPmid };
    memory.set(key, cs);
    if (result.newSid) await db_save_channel_session(guild?.id || 'dm', channel.id, result.newSid, result.newPmid, 'account', false, runtime.agentId).catch(() => {});
    const text = result.reply || 'تمام';
    await startHumanTyping(channel, text);
    return replyMode === 'reply' ? sourceMessage.reply(text.slice(0, 2000)) : channel.send(text.slice(0, 2000));
}

async function handleAccountInteraction(client, interaction, runtime) {
    const meta = bridge.get(interaction.message?.id);
    if (!meta || !interaction.customId?.startsWith('acct:')) return false;
    const sourceChannel = await client.channels.fetch(meta.source_channel_id).catch(() => null);
    const sourceMessage = await sourceChannel?.messages?.fetch?.(meta.source_message_id).catch(() => null);
    if (!sourceMessage) {
        await interaction.reply({ content: '❌ لم أجد الرسالة الأصلية.', ephemeral: true }).catch(() => {});
        return true;
    }
    await interaction.deferReply({ ephemeral: true }).catch(() => {});
    const replyMode = interaction.customId.endsWith('ai_noreply') ? 'send' : 'reply';
    await generateAiReply({ client, runtime, sourceMessage, controlMessage: interaction.message, replyMode });
    await interaction.editReply({ content: '✅ تم إرسال رد الذكاء الاصطناعي.' }).catch(() => {});
    return true;
}

async function handleControlReply(client, message, runtime) {
    if (!message.reference?.messageId || message.author.id === client.user.id) return false;
    const ref = await message.fetchReference().catch(() => null);
    const meta = ref ? bridge.get(ref.id) : null;
    if (!meta) return false;
    const sourceChannel = await client.channels.fetch(meta.source_channel_id).catch(() => null);
    const sourceMessage = await sourceChannel?.messages?.fetch?.(meta.source_message_id).catch(() => null);
    if (!sourceMessage) return false;
    const raw = String(message.content || '').trim();
    const noReply = /^!ai\s+!noreply|^!noreply/i.test(raw);
    const ai = raw.startsWith('!ai');
    if (ai) await generateAiReply({ client, runtime, sourceMessage, controlMessage: message, replyMode: noReply ? 'send' : 'reply' });
    else {
        const text = raw.replace(/^!ai\s+!noreply\s*/i, '').replace(/^!noreply\s*/i, '').trim();
        if (!text) return true;
        await startHumanTyping(sourceMessage.channel, text);
        if (noReply) await sourceMessage.channel.send(text.slice(0, 2000));
        else await sourceMessage.reply(text.slice(0, 2000));
    }
    await message.react('☑️').catch(() => {});
    return true;
}

async function trackGameMessage(client, message, runtime) {
    if (!message.guild || !message.author?.bot) return false;
    const settings = await getAccountSettings(runtime.agentId, message.guild.id);
    if (!settings.games.some(g => String(g.bot_id) === String(message.author.id))) return false;
    if (!WIN_RE.test(message.content || '')) return false;
    const deliveries = await client.channels.fetch(settings.deliveries_channel_id).catch(() => null);
    if (!deliveries || !isTextChannel(deliveries)) return false;
    const forwarded = await message.forward(deliveries).catch(() => null);
    await remember(runtime.agentId, message.guild.id, { type: 'game_result', bot_id: message.author.id, message_id: message.id, forwarded_id: forwarded?.id || null, content: (message.content || '').slice(0, 500) });
    return true;
}

async function remember(agentId, guildId, event) {
    const cfg = require('./config');
    await cfg.logs_col.insertOne({ agent_id: String(agentId), guild_id: String(guildId), type: 'account_memory', message: event.type, extra: event, created_at: new Date() }).catch(() => {});
}

async function startEvent(client, guild, channel, runtime, gameName = null, first = false) {
    const settings = await getAccountSettings(runtime.agentId, guild.id);
    const games = settings.games;
    const last = await require('./config').logs_col.find({ agent_id: String(runtime.agentId), guild_id: String(guild.id), type: 'account_memory', message: 'event_start' }).sort({ created_at: -1 }).limit(3).toArray().catch(() => []);
    const recent = new Set(last.map(x => x.extra?.game));
    const game = games.find(g => gameName && g.name.includes(gameName)) || games.find(g => !recent.has(g.name)) || games[0];
    const reward = first ? game.first_reward : game.reward;
    const mention = first && settings.first_event_announces_everyone ? '@everyone' : `<@&${settings.event_role_id}>`;
    const allowedMentions = first && settings.first_event_announces_everyone ? { parse: ['everyone'] } : { roles: [settings.event_role_id], parse: [] };
    await channel.send({ content: `# ${game.name} ${reward}\n${mention}`, allowedMentions });
    await new Promise(r => setTimeout(r, Number(settings.event_wait_ms || 40000)));
    await channel.send(game.command);
    await remember(runtime.agentId, guild.id, { type: 'event_start', game: game.name, command: game.command, bot_id: game.bot_id, channel_id: channel.id, by: client.user.id });
    return game;
}

async function runEventSeries(client, guild, channel, runtime, options = {}) {
    const settings = await getAccountSettings(runtime.agentId, guild.id);
    const minutesLimit = Math.max(0, Number(options.minutes || settings.manual_default_minutes || 0));
    const fallbackCount = minutesLimit ? 50 : (settings.manual_default_count || 1);
    const countLimit = Math.max(1, Math.min(Number(options.count || fallbackCount), 50));
    const startedAt = Date.now();
    const results = [];
    const key = `${runtime.agentId}:${guild.id}:${channel.id}:series`;
    if (autoLocks.get(key)) return { ok: false, msg: 'هناك سلسلة فعاليات تعمل بالفعل لهذه القناة.', results };
    autoLocks.set(key, true);
    try {
        for (let i = 0; i < countLimit; i++) {
            if (minutesLimit && Date.now() - startedAt >= minutesLimit * 60 * 1000) break;
            const game = await startEvent(client, guild, channel, runtime, options.gameName || null, i === 0 && Boolean(options.first));
            results.push(game);
            if (i < countLimit - 1) await new Promise(r => setTimeout(r, Number(settings.event_wait_ms || 10000)));
        }
        return { ok: true, msg: `تم تشغيل ${results.length} فعالية.`, results };
    } finally {
        autoLocks.delete(key);
    }
}

function parseScheduleSlot(slot) {
    const m = String(slot || '').match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})(?:#(\d+))?$/);
    if (!m) return null;
    const start = Number(m[1]) * 60 + Number(m[2]);
    const end = Number(m[3]) * 60 + Number(m[4]);
    return { start, end, count: Number(m[5] || 0) };
}

async function maybeScheduledEvent(client, message, runtime) {
    if (!message.guild || message.author?.bot) return false;
    const settings = await getAccountSettings(runtime.agentId, message.guild.id);
    if (settings.mode !== 'schedule') return false;
    const slots = Array.isArray(settings.schedule_slots) ? settings.schedule_slots : [];
    if (!slots.length) return false;
    const now = new Date();
    const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
    const active = slots.map(parseScheduleSlot).find(s => s && minute >= s.start && minute <= s.end);
    if (!active) return false;
    const channelId = settings.event_channel_id || message.channel.id;
    const stamp = now.toISOString().slice(0, 10) + ':' + active.start + '-' + active.end;
    const key = `${runtime.agentId}:${message.guild.id}:${channelId}:schedule:${stamp}`;
    if (scheduledLoops.get(key)) return false;
    scheduledLoops.set(key, true);
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !isTextChannel(channel)) return false;
    const minutes = Math.max(1, active.end - active.start);
    runEventSeries(client, message.guild, channel, runtime, { count: active.count || settings.auto_run_count || 50, minutes, first: true }).catch(() => {});
    return true;
}

function rememberActivity(agentId, message) {
    if (!message.guild || message.author?.bot) return;
    const key = `${agentId}:${message.guild.id}:${message.channel.id}`;
    const now = Date.now();
    const list = (activity.get(key) || []).filter(ts => now - ts < 10 * 60 * 1000);
    list.push(now);
    activity.set(key, list);
}

async function maybeAutoEvent(client, message, runtime) {
    if (!message.guild || message.author?.bot) return false;
    const settings = await getAccountSettings(runtime.agentId, message.guild.id);
    if (settings.mode !== 'auto') return false;
    const channelId = settings.event_channel_id || message.channel.id;
    const key = `${runtime.agentId}:${message.guild.id}:${channelId}`;
    const last = await require('./config').logs_col.findOne({ agent_id: String(runtime.agentId), guild_id: String(message.guild.id), type: 'account_memory', message: 'event_start' }, { sort: { created_at: -1 } }).catch(() => null);
    const inactiveMs = Number(settings.auto_inactivity_minutes || 20) * 60 * 1000;
    if (last?.created_at && Date.now() - new Date(last.created_at).getTime() < inactiveMs) return false;
    const recentCount = (activity.get(key) || []).filter(ts => Date.now() - ts < 10 * 60 * 1000).length;
    if (recentCount > Number(settings.auto_min_messages_10m || 3)) return false;
    if (autoLocks.get(key)) return false;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !isTextChannel(channel)) return false;
    autoLocks.set(key, true);
    runEventSeries(client, message.guild, channel, runtime, { count: settings.auto_run_count || 3, minutes: settings.auto_run_minutes || 0, first: !last }).catch(() => {}).finally(() => autoLocks.delete(key));
    return true;
}

async function summarizeMemory(agentId, guildId, limit = 10) {
    const cfg = require('./config');
    const rows = await cfg.logs_col.find({ agent_id: String(agentId), guild_id: String(guildId), type: 'account_memory' }).sort({ created_at: -1 }).limit(limit).toArray().catch(() => []);
    return rows.map(r => ({ at: r.created_at, kind: r.message, ...r.extra }));
}

module.exports = { humanizeDisplayName, getAccountSettings, updateAccountSettings, forwardMessage, handleAccountInteraction, handleControlReply, trackGameMessage, startEvent, runEventSeries, startHumanTyping, rememberActivity, maybeAutoEvent, maybeScheduledEvent, summarizeMemory, DEFAULT_ACCOUNT_SETTINGS };