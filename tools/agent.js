/**
 * tools/agent.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * استخراج JSON + حلقة الوكيل runAgent
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { ChannelType } = require('discord.js');
const { isTextChannel } = require('../discordAdapter');

const {
    _err,
    findChannel, findGuild,
    toolAllowedForAccess, executeAllowedForAccess,
    _stream_ds,
} = require('../utils');

const { buildSystem } = require('./systemPrompt');

const {
    toolGetChannels,
    toolGetCategories,
    toolGetRoles,
    toolGetMembers,
    toolServerInfo,
    toolListAllGuilds,
    toolGetMessages,
    toolGetAuditLog,
    toolGetInvites,
    toolGetEmojis,
    toolGetStickers,
    toolGetBans,
    toolGetPinnedMessages,
    toolGetVoiceStates,
    toolSearchMessages,
    toolModerationOverview,
    toolRecentJoins,
    toolInactiveMembers,
    toolRoleMembers,
    toolChannelPermissions,
    toolGetWebhooks,
    toolGetScheduledEvents,
    toolGetThreads,
    toolGetNitroBoosters,
    toolGetBotList,
    toolGetMemberInfo,
    toolGetBotCommands,
    toolAnalyzeBot,
} = require('./readTools');

const { executeAction } = require('./executeAction');

// ══════════════════════════════════════════════════════════════
//  JSON EXTRACTION — استخراج JSON من النصوص
// ══════════════════════════════════════════════════════════════

/**
 * يستخرج JSON objects من النص (نفس منطق Python)
 * @param {string} text
 * @returns {object[]}
 */
function extractJsonObjects(text) {
    const objects = [];

    // أولاً: استخراج من كتل ```json ... ```
    const codeBlockRegex = /```json\s*([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        const block = match[1].trim();
        try {
            const obj = JSON.parse(block);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                objects.push(obj);
            }
        } catch (_) {
            // محاولة استخراج JSON objects منفردة من الكتلة
            const nestedRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
            let nm;
            while ((nm = nestedRegex.exec(block)) !== null) {
                try {
                    const o = JSON.parse(nm[0]);
                    if (o && typeof o === 'object') objects.push(o);
                } catch (_) {}
            }
        }
    }

    // ثانياً: استخراج من باقي النص (بعد إزالة كتل الكود)
    const cleaned = text.replace(/```json\s*[\s\S]*?```/g, '');
    const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
    let om;
    while ((om = objRegex.exec(cleaned)) !== null) {
        try {
            const obj = JSON.parse(om[0]);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                // تجنب التكرار
                const str = JSON.stringify(obj);
                if (!objects.some(o => JSON.stringify(o) === str)) {
                    objects.push(obj);
                }
            }
        } catch (_) {}
    }

    return objects;
}

// ══════════════════════════════════════════════════════════════
//  AGENT LOOP — حلقة الوكيل
// ══════════════════════════════════════════════════════════════

const MAX_STEPS = 12;

/**
 * يشغّل Agent Loop الكامل
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').TextChannel} channel
 * @param {string} userMsg
 * @param {string} userInfo
 * @param {string} botContext
 * @param {string} botName
 * @param {string|null} sessionId
 * @param {string|null} parentMessageId
 * @param {string} guildId
 * @param {string} mode
 * @param {boolean} thinking
 * @param {string} accessLevel
 * @param {import('discord.js').Client} client
 * @returns {Promise<{reply: string, newSid: string, newPmid: string|null, filesToSend: string[]}>}
 */
async function runAgent(
    guild, channel, userMsg, userInfo, botContext, botName,
    sessionId, parentMessageId, guildId,
    mode = 'default', thinking = false, accessLevel = 'member',
    client,
    runtime = {},
) {
    const system    = buildSystem(botName, mode, thinking, accessLevel, runtime.personality || '');
    let curSid      = sessionId;
    let curPmid     = parentMessageId;
    let curPrompt   = (
        `${system}\n\n` +
        `[مستوى صلاحية المستخدم داخل البوت: ${accessLevel}]\n\n` +
        `${botContext}\n\n${userInfo}\n\nUser: ${userMsg}`
    );

    for (let step = 0; step < MAX_STEPS; step++) {
        console.log(`[Agent ${step + 1}/${MAX_STEPS}] mode=${mode} thinking=${thinking} access=${accessLevel}`);

        let raw;
        try {
            const dsResult = await _stream_ds(curPrompt, guildId, curSid, curPmid, mode, thinking, runtime.deepseekToken, runtime.agentId || 'default');
            raw     = dsResult.fullText;
            curSid  = dsResult.sessionId;
            curPmid = dsResult.newParentMessageId;
        } catch (e) {
            return {
                reply      : `⚠️ خطأ في الاتصال بالنموذج: ${e.message}`,
                newSid     : curSid,
                newPmid    : curPmid,
                filesToSend: [],
            };
        }

        console.log(`  raw: ${raw.slice(0, 300)}`);

        const jsonObjects    = extractJsonObjects(raw);
        const allResults     = [];
        const filesToSend    = [];
        let finalReplyText   = null;

        for (const obj of jsonObjects) {
            // ── رد نهائي بدون أداة ──
            if (obj.reply && !obj.tool && !obj.file && !obj.action) {
                finalReplyText = obj.reply;
                continue;
            }

            // ── أداة file (الصيغة المباشرة) ──
            if (obj.file && typeof obj.file === 'object' && obj.file.name && obj.file.content) {
                const safeName = path.basename(obj.file.name) || 'output.txt';
                try {
                    const tmpPath = path.join(os.tmpdir(), `disor_${Date.now()}_${safeName}`);
                    fs.writeFileSync(tmpPath, String(obj.file.content), 'utf8');
                    filesToSend.push(tmpPath);
                    allResults.push(`[FILE_CREATED: ${safeName}]`);
                    if (obj.reply) finalReplyText = obj.reply;
                } catch (e) {
                    allResults.push(`[FILE_ERROR: ${e.message}]`);
                }
                continue;
            }

            // ── أداة file (عبر tool: "file") ──
            if (obj.tool === 'file') {
                const p = obj.params || {};
                if (p.name && p.content) {
                    const safeName = path.basename(p.name) || 'output.txt';
                    try {
                        const tmpPath = path.join(os.tmpdir(), `disor_${Date.now()}_${safeName}`);
                        fs.writeFileSync(tmpPath, String(p.content), 'utf8');
                        filesToSend.push(tmpPath);
                        allResults.push(`[FILE_CREATED: ${safeName}]`);
                        if (obj.reply) finalReplyText = obj.reply;
                    } catch (e) {
                        allResults.push(`[FILE_ERROR: ${e.message}]`);
                    }
                }
                continue;
            }

            const tool   = obj.tool || '';
            const params = (typeof obj.params === 'object' && obj.params) ? obj.params : {};

            // ── أداة execute ──
            if (tool === 'execute') {
                const actionName = obj.action || '';
                const { allowed, reason } = executeAllowedForAccess(actionName, accessLevel, params);
                let result;
                if (!allowed) {
                    result = _err(reason);
                } else {
                    result = await executeAction(guild, channel, actionName, params, client);
                }
                allResults.push(`[TOOL_RESULT: ${actionName}]\n${JSON.stringify(result, null, 2)}`);
                continue;
            }

            // ── أدوات القراءة ──
            const readTools = [
                'get_channels', 'get_categories', 'get_roles', 'get_members', 'server_info', 'list_all_guilds',
                'get_messages', 'get_audit_log', 'get_invites', 'get_emojis', 'get_stickers', 'get_bans',
                'get_pinned_messages', 'get_voice_states', 'search_messages',
                'moderation_overview', 'recent_joins', 'inactive_members', 'role_members', 'channel_permissions',
                'get_webhooks', 'get_scheduled_events', 'get_threads', 'get_nitro_boosters',
                'get_bot_list', 'get_member_info', 'get_bot_commands', 'analyze_bot',
            ];

            if (readTools.includes(tool)) {
                if (!toolAllowedForAccess(tool, accessLevel)) {
                    const result = _err('⛔ هذه الأداة غير متاحة لمستواك.');
                    allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result)}`);
                    continue;
                }

                // دعم target_guild للـ owner فقط
                let targetGuild = guild;
                if (params.target_guild) {
                    if (accessLevel !== 'owner') {
                        const result = _err('⛔ الأدمن يستطيع قراءة السيرفر الحالي فقط.');
                        allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result)}`);
                        continue;
                    }
                    const foundG = findGuild(client, String(params.target_guild));
                    if (foundG) {
                        targetGuild = foundG;
                    } else {
                        const result = _err(`ما لقيت سيرفر: ${params.target_guild}`);
                        allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result)}`);
                        continue;
                    }
                }

                let result;
                try {
                    // تحديد القناة الهدف للأدوات التي تحتاجها
                    const getTargetCh = () => {
                        if (params.channel) {
                            const found = findChannel(targetGuild, String(params.channel));
                            if (found && isTextChannel(found)) return found;
                        }
                        return channel;
                    };

                    switch (tool) {
                        case 'get_channels':
                            result = toolGetChannels(targetGuild); break;
                        case 'get_categories':
                            result = toolGetCategories(targetGuild); break;
                        case 'get_roles':
                            result = toolGetRoles(targetGuild); break;
                        case 'get_members':
                            result = toolGetMembers(targetGuild, params.query || null); break;
                        case 'server_info':
                            result = toolServerInfo(targetGuild); break;
                        case 'list_all_guilds':
                            result = toolListAllGuilds(client); break;
                        case 'get_messages':
                            result = await toolGetMessages(getTargetCh(), Number(params.limit || 100), params.member_id || null); break;
                        case 'get_audit_log':
                            result = await toolGetAuditLog(targetGuild, Number(params.limit || 20), params.action || null); break;
                        case 'get_invites':
                            result = await toolGetInvites(targetGuild); break;
                        case 'get_emojis':
                            result = toolGetEmojis(targetGuild); break;
                        case 'get_stickers':
                            result = toolGetStickers(targetGuild); break;
                        case 'get_bans':
                            result = await toolGetBans(targetGuild, Number(params.limit || 100)); break;
                        case 'get_pinned_messages':
                            result = await toolGetPinnedMessages(getTargetCh()); break;
                        case 'get_voice_states':
                            result = toolGetVoiceStates(targetGuild); break;
                        case 'search_messages':
                            result = await toolSearchMessages(getTargetCh(), params.query || '', Number(params.limit || 200)); break;
                        case 'moderation_overview':
                            result = toolModerationOverview(targetGuild, client); break;
                        case 'recent_joins':
                            result = toolRecentJoins(targetGuild, Number(params.limit || 20)); break;
                        case 'inactive_members':
                            result = toolInactiveMembers(targetGuild, Number(params.days || 30), Number(params.limit || 50)); break;
                        case 'role_members':
                            result = toolRoleMembers(targetGuild, params.role || '', Number(params.limit || 100)); break;
                        case 'channel_permissions':
                            result = toolChannelPermissions(targetGuild, params.channel || null); break;
                        case 'get_webhooks':
                            result = await toolGetWebhooks(targetGuild); break;
                        case 'get_scheduled_events':
                            result = await toolGetScheduledEvents(targetGuild); break;
                        case 'get_threads':
                            result = await toolGetThreads(targetGuild, params.channel || null); break;
                        case 'get_nitro_boosters':
                            result = toolGetNitroBoosters(targetGuild); break;
                        case 'get_bot_list':
                            result = toolGetBotList(targetGuild); break;
                        case 'get_member_info':
                            result = await toolGetMemberInfo(targetGuild, String(params.member || '')); break;
                        case 'get_bot_commands':
                            result = await toolGetBotCommands(targetGuild, String(params.bot || params.bot_id || ''), getTargetCh(), Number(params.limit || 300)); break;
                        case 'analyze_bot':
                            result = await toolAnalyzeBot(targetGuild, String(params.bot || params.bot_id || ''), getTargetCh()); break;
                        default:
                            result = _err(`أداة غير مُنفَّذة: ${tool}`);
                    }
                } catch (e) {
                    console.error(`[Tool error] ${tool}:`, e);
                    result = _err(`❌ خطأ في تنفيذ الأداة ${tool}: ${String(e.message).slice(0, 200)}`);
                }

                allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result, null, 2)}`);
                continue;
            }

            allResults.push(`[UNKNOWN_TOOL: ${tool}]`);
        }

        // ── إذا وجد رد نهائي → نرجعه ──
        if (finalReplyText) {
            return {
                reply      : finalReplyText,
                newSid     : curSid,
                newPmid    : curPmid,
                filesToSend: filesToSend,
            };
        }

        // ── إذا لا توجد نتائج أدوات → النص الخام هو الرد ──
        if (!allResults.length) {
            return {
                reply      : raw,
                newSid     : curSid,
                newPmid    : curPmid,
                filesToSend: filesToSend,
            };
        }

        // ── نكمل الحلقة بنتائج الأدوات ──
        const combined = allResults.join('\n');
        curPrompt      = `نتائج الأوامر:\n${combined}\n\nاستمر في التنفيذ أو قدم الرد النهائي.`;
    }

    return {
        reply      : '✅ تم.',
        newSid     : curSid,
        newPmid    : curPmid,
        filesToSend: [],
    };
}

// ══════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════
module.exports = {
    extractJsonObjects,
    runAgent,
};