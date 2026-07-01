/**
 * tools/readTools.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * جميع أدوات القراءة (القديمة + الجديدة)
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { ChannelType } = require('discord.js');

const {
    _err,
    findChannel, findRole, findMember, findGuild,
} = require('../utils');

// ══════════════════════════════════════════════════════════════
//  READ TOOLS — أدوات القراءة
// ══════════════════════════════════════════════════════════════

/**
 * يجيب قائمة القنوات في السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolGetChannels(guild) {
    const rows = [];
    for (const ch of guild.channels.cache.values()) {
        if (ch.type === ChannelType.GuildCategory) continue;
        rows.push({
            id      : ch.id,
            name    : ch.name,
            type    : ch.type === ChannelType.GuildText ? 'text' : 'voice',
            category: ch.parent ? ch.parent.name : null,
        });
    }
    return { channels: rows };
}

/**
 * يجيب قائمة الكاتيجوريات في السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolGetCategories(guild) {
    const cats = guild.channels.cache
        .filter(ch => ch.type === ChannelType.GuildCategory)
        .map(c => ({ id: c.id, name: c.name, position: c.position }));
    return { categories: [...cats] };
}

/**
 * يجيب قائمة الرتب في السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolGetRoles(guild) {
    const roles = guild.roles.cache.map(r => ({
        id      : r.id,
        name    : r.name,
        color   : r.hexColor,
        position: r.position,
        perms   : r.permissions.toArray(),
    }));
    return { roles };
}

/**
 * يجيب قائمة الأعضاء (مع خيار بحث)
 * @param {import('discord.js').Guild} guild
 * @param {string|null} query
 * @returns {object}
 */
function toolGetMembers(guild, query = null) {
    let members = [...guild.members.cache.values()];
    if (query) {
        const ql = query.toLowerCase();
        members  = members.filter(m =>
            m.user.username.toLowerCase().includes(ql) ||
            (m.nickname && m.nickname.toLowerCase().includes(ql)) ||
            (m.user.globalName && m.user.globalName.toLowerCase().includes(ql)),
        );
    }
    return {
        members: members.slice(0, 60).map(m => ({
            id         : m.id,
            username   : m.user.username,
            global_name: m.user.globalName || null,
            nickname   : m.nickname || null,
            display    : m.displayName,
            roles      : m.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
            bot        : m.user.bot,
        })),
    };
}

/**
 * يجيب معلومات السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
function toolServerInfo(guild) {
    const nonCatChannels = guild.channels.cache.filter(c => c.type !== ChannelType.GuildCategory);
    return {
        name        : guild.name,
        id          : guild.id,
        member_count: guild.memberCount,
        owner_id    : guild.ownerId,
        created_at  : guild.createdAt.toISOString().slice(0, 10),
        boost_level : guild.premiumTier,
        boosts      : guild.premiumSubscriptionCount,
        channels    : nonCatChannels.size,
        categories  : guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size,
        roles       : guild.roles.cache.size,
        icon_url    : guild.iconURL() || null,
        description : guild.description || null,
    };
}

/**
 * يجيب قائمة جميع السيرفرات التي البوت فيها — owner only
 * @param {import('discord.js').Client} client
 * @returns {object}
 */
function toolListAllGuilds(client) {
    const rows = [];
    for (const g of client.guilds.cache.values()) {
        const botMember = g.members.cache.get(client.user.id);
        const isAdmin   = Boolean(botMember && botMember.permissions.has('Administrator'));
        rows.push({
            id          : g.id,
            name        : g.name,
            member_count: g.memberCount,
            owner_id    : g.ownerId,
            bot_is_admin: isAdmin,
            channels    : g.channels.cache.filter(c => c.type !== ChannelType.GuildCategory).size,
            roles       : g.roles.cache.size,
        });
    }
    return { guilds: rows, total: rows.length };
}

/**
 * يجيب رسائل القناة
 * @param {import('discord.js').TextChannel} channel
 * @param {number} limit
 * @param {string|null} memberId
 * @returns {Promise<object>}
 */
async function toolGetMessages(channel, limit = 100, memberId = null) {
    const msgs    = [];
    const fetched = await channel.messages.fetch({ limit: Math.min(limit, 500) });
    for (const msg of fetched.values()) {
        if (memberId && msg.author.id !== String(memberId)) continue;
        msgs.push({
            id        : msg.id,
            author    : msg.author.displayName || msg.author.username,
            author_id : msg.author.id,
            content   : msg.content.slice(0, 500),
            time      : msg.createdAt.toISOString().slice(0, 16).replace('T', ' '),
        });
    }
    return { messages: msgs, count: msgs.length };
}

/**
 * يجيب سجل التدقيق
 * @param {import('discord.js').Guild} guild
 * @param {number} limit
 * @param {string|null} action
 * @returns {Promise<object>}
 */
async function toolGetAuditLog(guild, limit = 20, action = null) {
    const entries = [];
    try {
        const kwargs = { limit: Math.min(Number(limit), 100) };
        if (action) {
            // محاولة تحويل الـ action string إلى enum value
            const { AuditLogEvent } = require('discord.js');
            const actionKey = Object.keys(AuditLogEvent).find(
                k => k.toLowerCase() === action.toLowerCase().trim(),
            );
            if (actionKey) kwargs.type = AuditLogEvent[actionKey];
        }
        const logs = await guild.fetchAuditLogs(kwargs);
        for (const entry of logs.entries.values()) {
            entries.push({
                id        : entry.id,
                action    : String(entry.action),
                user      : entry.executor?.displayName || null,
                user_id   : entry.executor?.id || null,
                target    : entry.target ? String(entry.target.id || entry.target) : null,
                reason    : entry.reason || null,
                created_at: entry.createdAt.toISOString().slice(0, 16).replace('T', ' '),
            });
        }
    } catch (e) {
        if (e.code === 50013) return _err("⛔ البوت لا يملك صلاحية 'عرض سجل التدقيق'.");
        return _err(`❌ فشل جلب سجل التدقيق: ${e.message}`);
    }
    return { audit_log: entries, count: entries.length };
}

/**
 * يجيب دعوات السيرفر
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<object>}
 */
async function toolGetInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        return {
            invites: invites.map(inv => ({
                code      : inv.code,
                url       : inv.url,
                channel   : inv.channel?.name || null,
                inviter   : inv.inviter?.displayName || null,
                uses      : inv.uses,
                max_uses  : inv.maxUses,
                expires_at: inv.expiresAt ? inv.expiresAt.toISOString().slice(0, 16).replace('T', ' ') : null,
            })).slice(0, 100),
            count: invites.size,
        };
    } catch (e) {
        return _err("⛔ البوت لا يملك صلاحية 'إدارة السيرفر' لعرض الدعوات.");
    }
}

/** يجيب الإيموجيات */
function toolGetEmojis(guild) {
    const emojis = guild.emojis.cache.map(e => ({
        id       : e.id,
        name     : e.name,
        animated : e.animated,
        available: e.available,
        url      : e.url,
    }));
    return { emojis, count: emojis.length };
}

/** يجيب الملصقات */
function toolGetStickers(guild) {
    const stickers = guild.stickers.cache.map(s => ({
        id         : s.id,
        name       : s.name,
        description: s.description || null,
        emoji      : s.tags || null,
        url        : s.url,
    }));
    return { stickers, count: stickers.length };
}

/** يجيب قائمة المحظورين */
async function toolGetBans(guild, limit = 100) {
    const bans = [];
    try {
        const fetched = await guild.bans.fetch({ limit: Math.min(Number(limit), 1000) });
        for (const ban of fetched.values()) {
            bans.push({
                user_id : ban.user.id,
                username: ban.user.username,
                display : ban.user.displayName || ban.user.username,
                reason  : ban.reason || null,
            });
        }
    } catch (e) {
        return _err("⛔ البوت لا يملك صلاحية 'حظر الأعضاء' لعرض البانات.");
    }
    return { bans, count: bans.length };
}

/** يجيب الرسائل المثبتة في القناة */
async function toolGetPinnedMessages(channel) {
    const pins = await channel.messages.fetchPinned();
    return {
        pinned_messages: [...pins.values()].slice(0, 50).map(msg => ({
            id        : msg.id,
            author    : msg.author.displayName || msg.author.username,
            author_id : msg.author.id,
            content   : msg.content.slice(0, 500),
            created_at: msg.createdAt.toISOString().slice(0, 16).replace('T', ' '),
            jump_url  : msg.url,
        })),
        count: pins.size,
    };
}

/** يجيب حالات الفويس في السيرفر */
function toolGetVoiceStates(guild) {
    const rows = [];
    for (const vc of guild.channels.cache.values()) {
        if (vc.type !== ChannelType.GuildVoice) continue;
        for (const member of vc.members.values()) {
            const vs = member.voice;
            rows.push({
                member_id : member.id,
                display   : member.displayName,
                channel_id: vc.id,
                channel   : vc.name,
                muted     : Boolean(vs && (vs.mute || vs.selfMute)),
                deafened  : Boolean(vs && (vs.deaf || vs.selfDeaf)),
                streaming : Boolean(vs && vs.streaming),
            });
        }
    }
    return { voice_states: rows, count: rows.length };
}

/** يبحث في رسائل القناة */
async function toolSearchMessages(channel, query, limit = 200) {
    const ql      = String(query).toLowerCase().trim();
    const matches = [];
    const fetched = await channel.messages.fetch({ limit: Math.min(Number(limit), 1000) });
    for (const msg of fetched.values()) {
        if (ql && msg.content.toLowerCase().includes(ql)) {
            matches.push({
                id        : msg.id,
                author    : msg.author.displayName || msg.author.username,
                author_id : msg.author.id,
                content   : msg.content.slice(0, 500),
                time      : msg.createdAt.toISOString().slice(0, 16).replace('T', ' '),
                jump_url  : msg.url,
            });
        }
        if (matches.length >= 50) break;
    }
    return { matches, count: matches.length };
}

/** يجيب نظرة عامة على إدارة السيرفر */
function toolModerationOverview(guild, client) {
    const botMember = guild.members.cache.get(client.user.id);
    return {
        server                  : guild.name,
        members                 : guild.memberCount,
        roles                   : guild.roles.cache.size,
        text_channels           : guild.channels.cache.filter(c => c.type === ChannelType.GuildText).size,
        voice_channels          : guild.channels.cache.filter(c => c.type === ChannelType.GuildVoice).size,
        categories              : guild.channels.cache.filter(c => c.type === ChannelType.GuildCategory).size,
        boost_level             : guild.premiumTier,
        bot_top_role            : botMember?.roles.highest.name || null,
        bot_permissions         : botMember?.permissions.toArray() || [],
        verification_level      : String(guild.verificationLevel),
        explicit_content_filter : String(guild.explicitContentFilter),
    };
}

/** يجيب أحدث الأعضاء انضماماً */
function toolRecentJoins(guild, limit = 20) {
    const members = [...guild.members.cache.values()]
        .filter(m => m.joinedAt)
        .sort((a, b) => b.joinedAt - a.joinedAt)
        .slice(0, Math.min(Number(limit), 100));
    return {
        recent_joins: members.map(m => ({
            id       : m.id,
            display  : m.displayName,
            username : m.user.username,
            joined_at: m.joinedAt.toISOString().slice(0, 16).replace('T', ' '),
        })),
        count: members.length,
    };
}

/** يجيب الأعضاء غير النشطين (حسب تاريخ الانضمام) */
function toolInactiveMembers(guild, days = 30, limit = 50) {
    const cutoff = new Date(Date.now() - Math.max(1, Number(days)) * 86400000);
    const rows   = [];
    for (const m of guild.members.cache.values()) {
        if (m.user.bot) continue;
        if (m.joinedAt && m.joinedAt < cutoff) {
            rows.push({
                id       : m.id,
                display  : m.displayName,
                username : m.user.username,
                joined_at: m.joinedAt.toISOString().slice(0, 16).replace('T', ' '),
                roles    : m.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
            });
        }
        if (rows.length >= Math.min(Number(limit), 100)) break;
    }
    return { inactive_members: rows, count: rows.length, days };
}

/** يجيب أعضاء رتبة محددة */
function toolRoleMembers(guild, role, limit = 100) {
    const roleObj = findRole(guild, String(role));
    if (!roleObj) return _err(`ما لقيت رتبة: ${role}`);
    const members = [...roleObj.members.values()].slice(0, Math.min(Number(limit), 500));
    return {
        role   : roleObj.name,
        members: members.map(m => ({ id: m.id, display: m.displayName, username: m.user.username })),
        count  : members.length,
    };
}

/** يجيب صلاحيات القنوات */
function toolChannelPermissions(guild, channelName = null) {
    const ch = channelName ? findChannel(guild, String(channelName)) : null;
    if (channelName && !ch) return _err(`ما لقيت قناة: ${channelName}`);
    const channels = ch ? [ch] : [...guild.channels.cache.values()].slice(0, 50);
    const rows     = channels.map(channel => {
        const overwrites = [];
        for (const [targetId, ow] of channel.permissionOverwrites.cache) {
            const target = guild.roles.cache.get(targetId) || guild.members.cache.get(targetId);
            overwrites.push({
                target: target?.name || target?.displayName || String(targetId),
                type  : guild.roles.cache.has(targetId) ? 'role' : 'member',
                allow : ow.allow.toArray(),
                deny  : ow.deny.toArray(),
            });
        }
        return { id: channel.id, name: channel.name, type: String(channel.type), overwrites };
    });
    return { channel_permissions: rows, count: rows.length };
}

// ══════════════════════════════════════════════════════════════
//  NEW READ TOOLS — 10 أدوات جديدة
// ══════════════════════════════════════════════════════════════

/** يجيب كل webhooks في السيرفر */
async function toolGetWebhooks(guild) {
    try {
        const webhooks = await guild.fetchWebhooks();
        return {
            webhooks: webhooks.map(wh => ({
                id        : wh.id,
                name      : wh.name,
                channel   : wh.channel?.name || null,
                url       : wh.url,
                created_by: wh.owner?.displayName || null,
            })),
            count: webhooks.size,
        };
    } catch (e) {
        return _err("⛔ البوت لا يملك صلاحية 'إدارة الويبهوكس'.");
    }
}

/** يجيب الفعاليات المجدولة في السيرفر */
async function toolGetScheduledEvents(guild) {
    try {
        const events = await guild.scheduledEvents.fetch();
        return {
            events: events.map(ev => ({
                id         : ev.id,
                name       : ev.name,
                description: ev.description || null,
                status     : String(ev.status),
                start_time : ev.scheduledStartAt?.toISOString().slice(0, 16).replace('T', ' ') || null,
                end_time   : ev.scheduledEndAt?.toISOString().slice(0, 16).replace('T', ' ') || null,
                subscribers: ev.userCount || 0,
                creator    : ev.creator?.displayName || null,
            })),
            count: events.size,
        };
    } catch (e) {
        return _err(`❌ فشل جلب الفعاليات: ${e.message}`);
    }
}

/** يجيب الثريدات النشطة في السيرفر أو في قناة محددة */
async function toolGetThreads(guild, channelName = null) {
    try {
        let threads = [];
        if (channelName) {
            const ch = findChannel(guild, channelName);
            if (!ch || ch.type !== ChannelType.GuildText) {
                return _err(`ما لقيت قناة نصية: ${channelName}`);
            }
            threads = [...ch.threads.cache.values()];
        } else {
            for (const ch of guild.channels.cache.values()) {
                if (ch.type === ChannelType.GuildText && ch.threads) {
                    threads.push(...ch.threads.cache.values());
                }
            }
        }
        return {
            threads: threads.slice(0, 100).map(t => ({
                id      : t.id,
                name    : t.name,
                parent  : t.parent?.name || null,
                archived: t.archived,
                locked  : t.locked,
                messages: t.messageCount || 0,
                members : t.memberCount || 0,
            })),
            count: threads.length,
        };
    } catch (e) {
        return _err(`❌ خطأ في جلب الثريدات: ${e.message}`);
    }
}

/** يجيب قائمة الأعضاء الذين يبوستون السيرفر */
function toolGetNitroBoosters(guild) {
    const boosters = guild.members.cache.filter(m => m.premiumSince).values();
    const rows     = [];
    for (const m of boosters) {
        rows.push({
            id            : m.id,
            display       : m.displayName,
            username      : m.user.username,
            boosting_since: m.premiumSince ? m.premiumSince.toISOString().slice(0, 10) : null,
        });
    }
    return {
        boosters    : rows,
        count       : rows.length,
        boost_level : guild.premiumTier,
        total_boosts: guild.premiumSubscriptionCount,
    };
}

/** يجيب قائمة البوتات الموجودة في السيرفر — owner only */
function toolGetBotList(guild) {
    const bots = guild.members.cache.filter(m => m.user.bot).map(b => ({
        id      : b.id,
        username: b.user.username,
        display : b.displayName,
        roles   : b.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
        joined  : b.joinedAt ? b.joinedAt.toISOString().slice(0, 10) : null,
    }));
    return { bots, count: bots.length };
}

/** يجيب معلومات تفصيلية عن عضو واحد */
async function toolGetMemberInfo(guild, memberQuery) {
    let member = await findMember(guild, memberQuery);
    if (!member) {
        try {
            member = await guild.members.fetch(String(memberQuery).trim());
        } catch (_) {
            return _err(`ما لقيت العضو: ${memberQuery}`);
        }
    }
    const perms = member.permissions;
    return {
        id             : member.id,
        username       : member.user.username,
        global_name    : member.user.globalName || null,
        nickname       : member.nickname || null,
        display        : member.displayName,
        bot            : member.user.bot,
        joined_at      : member.joinedAt ? member.joinedAt.toISOString().slice(0, 16).replace('T', ' ') : null,
        created_at     : member.user.createdAt.toISOString().slice(0, 16).replace('T', ' '),
        premium_since  : member.premiumSince ? member.premiumSince.toISOString().slice(0, 10) : null,
        roles          : member.roles.cache.filter(r => r.name !== '@everyone').map(r => r.name),
        top_role       : member.roles.highest.name,
        is_admin       : perms.has('Administrator'),
        key_permissions: perms.toArray().slice(0, 20),
        avatar         : member.displayAvatarURL() || null,
        timed_out_until: member.communicationDisabledUntil
            ? member.communicationDisabledUntil.toISOString().slice(0, 16).replace('T', ' ')
            : null,
    };
}

// ══════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════
module.exports = {
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
};