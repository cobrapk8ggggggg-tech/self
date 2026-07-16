/**
 * tools/executeAction.js — Disor Bot v7.0 "Ironclad" [FIXED]
 * ═══════════════════════════════════════════════════════════
 * إصلاحات:
 * 1. _cleanName — يزيل الأحرف غير المقبولة من Discord بشكل صحيح
 * 2. nested params extraction — يمنع تمرير object بدل string للاسم
 * 3. delete_message / get messages — fetch مع catch صحيح
 * 4. _safePurge user token — تحسين التأخير ومنع التكرار
 * 5. mapPermissionOverwrites — BigInt → Number صحيح
 * 6. findChannel في clear_channel — منع استخدام الاسم كـ ID
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const axios = require('axios');
const { ChannelType, PermissionsBitField, AttachmentBuilder } = require('discord.js');
const { isTextChannel, isVoiceChannel, isCategoryChannel, channelCreateType, isUserRuntime } = require('../discordAdapter');

const {
    _err, _ok,
    findChannel, findCategory, findRole, findMember, findGuild,
} = require('../utils');

// ══════════════════════════════════════════════════════════════
//  SAFE API CALL
// ══════════════════════════════════════════════════════════════

async function safeApiCall(apiCall, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await apiCall();
        } catch (e) {
            if (e.httpStatus === 429 || e.status === 429) {
                const retryAfter = (e.retryAfter || 2) * 1000;
                if (e.global || String(e.message).includes('global')) {
                    throw new Error('Global rate limit exceeded');
                }
                await new Promise(r => setTimeout(r, retryAfter));
                attempt++;
                continue;
            }
            throw e;
        }
    }
    throw new Error('Max retries exceeded');
}

// ══════════════════════════════════════════════════════════════
//  SAFE PURGE — [FIX 3] تحسين user token delay ومنع التكرار
// ══════════════════════════════════════════════════════════════

async function _safePurge(channel, limit, checkFn = null, tokenType = 'bot') {
    let totalDeleted = 0;
    let remaining = limit;
    let beforeId = null;
    const isUserToken = tokenType === 'user';
    // [FIX 3] زيادة التأخير لـ user token لمنع rate limit
    const deleteDelay = isUserToken ? 1200 : 0;

    while (remaining > 0) {
        const toFetch = Math.min(remaining, 100);
        const opts = { limit: toFetch };
        if (beforeId) opts.before = beforeId;

        let fetched;
        try {
            fetched = await channel.messages.fetch(opts);
        } catch (_) {
            break;
        }
        if (!fetched || !fetched.size) break;

        // [FIX 3] استخدام آخر ID بدل أقدم واحد لضمان عدم التكرار
        const sortedIds = [...fetched.keys()].sort();
        beforeId = sortedIds[0]; // أصغر ID = الأقدم

        const toDelete = checkFn ? fetched.filter(checkFn) : fetched;
        if (!toDelete.size) {
            remaining -= fetched.size;
            if (fetched.size < toFetch) break;
            continue;
        }

        if (isUserToken) {
            for (const msg of toDelete.values()) {
                try {
                    await safeApiCall(() => msg.delete());
                    totalDeleted++;
                    if (deleteDelay) await new Promise(r => setTimeout(r, deleteDelay));
                } catch (e) {
                    if (e.httpStatus === 429 || e.status === 429) {
                        const retryAfter = (e.retryAfter || 3) * 1000;
                        await new Promise(r => setTimeout(r, retryAfter));
                        try { await msg.delete(); totalDeleted++; } catch (_) {}
                    }
                }
            }
        } else {
            const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
            const recent = toDelete.filter(m => m.createdTimestamp > cutoff);
            const old    = toDelete.filter(m => m.createdTimestamp <= cutoff);

            if (recent.size > 0) {
                try {
                    if (recent.size > 1) {
                        const deletedMessages = await safeApiCall(() => channel.bulkDelete(recent, true));
                        totalDeleted += deletedMessages.size;
                    } else {
                        await safeApiCall(() => recent.first().delete());
                        totalDeleted += 1;
                    }
                } catch (e) {
                    for (const msg of recent.values()) {
                        try { await msg.delete(); totalDeleted++; } catch (_) {}
                    }
                }
            }

            for (const msg of old.values()) {
                try {
                    await safeApiCall(() => msg.delete());
                    totalDeleted++;
                } catch (e) {
                    if (e.httpStatus === 429 || e.status === 429) {
                        const retryAfter = (e.retryAfter || 1) * 1000;
                        await new Promise(r => setTimeout(r, retryAfter));
                        try { await msg.delete(); totalDeleted++; } catch (_) {}
                    }
                }
                if (!isUserToken) await new Promise(r => setTimeout(r, 300));
            }
        }

        remaining -= fetched.size;
        if (fetched.size < toFetch) break;
    }

    return totalDeleted;
}

// ══════════════════════════════════════════════════════════════
//  clone_server helpers
// ══════════════════════════════════════════════════════════════

// [FIX 1] _cleanName محسّن — يزيل كل الأحرف غير المقبولة من Discord
function _cleanName(name) {
    if (name === null || name === undefined) return 'channel';
    
    // إذا كان object بسبب خطأ في params، نحوّله لـ string أولاً
    if (typeof name === 'object') {
        name = JSON.stringify(name);
    }
    
    return String(name)
        // إزالة Zero-width characters
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // إزالة control characters
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        // [FIX 1] إزالة الرموز الخاصة التي يرفضها Discord في أسماء القنوات
        // Discord يقبل: حروف، أرقام، مسافة، شرطة، شرطة سفلية، نقطة
        // لكن يرفض: معظم Unicode decorative characters عند تفسيرها
        .replace(/[^\p{L}\p{N}\p{M}\s\-_.|()\[\]{}'":،,؟?!@#$&*+=/\\٪%^~`؛;]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim()
        .replace(/^-+|-+$/g, '')
        .slice(0, 100)
        || 'channel';
}

// [FIX 5] mapPermissionOverwrites — تحويل BigInt بشكل صحيح
function mapPermissionOverwrites(channel, targetGuild, roleMap = new Map()) {
    const overwrites = [];
    for (const [, ow] of channel.permissionOverwrites.cache) {
        let id = ow.id;
        if (ow.type === 0 || channel.guild.roles.cache.has(ow.id)) {
            if (ow.id === channel.guild.id) {
                id = targetGuild.id;
            } else {
                const mapped = roleMap.get(ow.id);
                if (!mapped) continue;
                id = mapped.id;
            }
        }
        // [FIX 5] تحويل BigInt لـ Number بأمان
        const allowBits = ow.allow?.bitfield ?? ow.allow?.valueOf?.() ?? 0n;
        const denyBits  = ow.deny?.bitfield  ?? ow.deny?.valueOf?.()  ?? 0n;
        
        overwrites.push({
            id,
            allow: String(allowBits),
            deny:  String(denyBits),
            type:  ow.type,
        });
    }
    return overwrites;
}

function channelTypeForClone(ch, client) {
    if (isCategoryChannel(ch)) return channelCreateType('category', client.__agentTokenType);
    if (isVoiceChannel(ch)) return channelCreateType('voice', client.__agentTokenType);
    if (ch.type === ChannelType.GuildAnnouncement) return ChannelType.GuildAnnouncement;
    if (ch.type === ChannelType.GuildForum) return ChannelType.GuildForum;
    if (ch.type === ChannelType.GuildStageVoice) return ChannelType.GuildStageVoice;
    return channelCreateType('text', client.__agentTokenType);
}

// ══════════════════════════════════════════════════════════════
//  PARAM HELPER
// ══════════════════════════════════════════════════════════════

function getParam(params, ...keys) {
    if (!params || typeof params !== 'object') return undefined;
    for (const k of keys) {
        if (k in params && params[k] !== undefined && params[k] !== null) {
            return params[k];
        }
    }
    return undefined;
}

function requireOneParam(params, actionName, ...keys) {
    const val = getParam(params, ...keys);
    if (val === undefined) {
        const keyList = keys.map(k => `"${k}"`).join(' أو ');
        return _err(`❌ يلزم تحديد ${keyList} لتنفيذ **${actionName}**.`);
    }
    return null;
}

// ══════════════════════════════════════════════════════════════
//  MEDIA HELPERS
// ══════════════════════════════════════════════════════════════

async function _fetchAsAttachment(url, fallbackName = 'image.png') {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000,
        });
        return new AttachmentBuilder(Buffer.from(response.data), { name: fallbackName });
    } catch (_) {
        return null;
    }
}

// ══════════════════════════════════════════════════════════════
//  EXECUTE ACTION
// ══════════════════════════════════════════════════════════════

async function executeAction(guild, channel, action, params, client) {
    // [FIX 2] nested params extraction — أكثر أماناً، يتحقق أن القيمة string وليست object
    if (params && typeof params === 'object') {
        const hasTopLevel = ['name','channel','member','role','content','url'].some(
            k => k in params && params[k] !== undefined && typeof params[k] !== 'object'
        );
        if (!hasTopLevel) {
            for (const key of Object.keys(params)) {
                if (params[key] && typeof params[key] === 'object' && !Array.isArray(params[key])) {
                    const nested = params[key];
                    if (nested.name || nested.channel || nested.member || nested.role || nested.content || nested.new_name) {
                        params = nested;
                        break;
                    }
                }
            }
        }
    }

    const tokenType = client.__agentTokenType || 'bot';
    try {
        if (params.target_guild) {
            const foundGuild = findGuild(client, String(params.target_guild));
            if (!foundGuild) return _err(`❌ ما لقيت سيرفر: **${params.target_guild}**`);
            guild = foundGuild;
            if (!params.channel) channel = null;
        }

        const a = action.toLowerCase().trim();

        // ── أدوات الصور والوسائط ─ـ
        if (a === 'get_server_icon') {
            const guildQuery = getParam(params, 'guild', 'guild_id');
            const targetGuild = guildQuery ? (findGuild(client, String(guildQuery)) || guild) : guild;
            const iconURL = targetGuild.iconURL({ size: 4096, extension: 'png' });
            if (!iconURL) return _err('❌ هذا السيرفر لا يملك أيقونة.');
            const attachment = await _fetchAsAttachment(iconURL, `icon_${targetGuild.id}.png`);
            if (!attachment) return _err('❌ فشل جلب الأيقونة.');
            const result = _ok(`✅ أيقونة سيرفر **${targetGuild.name}**`);
            result.__attachments = [attachment];
            return result;
        }

        if (a === 'get_server_banner') {
            const guildQuery = getParam(params, 'guild', 'guild_id');
            const targetGuild = guildQuery ? (findGuild(client, String(guildQuery)) || guild) : guild;
            const bannerURL = targetGuild.bannerURL({ size: 4096, extension: 'png' });
            if (!bannerURL) return _err('❌ هذا السيرفر لا يملك بانر.');
            const attachment = await _fetchAsAttachment(bannerURL, `banner_${targetGuild.id}.png`);
            if (!attachment) return _err('❌ فشل جلب البانر.');
            const result = _ok(`✅ بانر سيرفر **${targetGuild.name}**`);
            result.__attachments = [attachment];
            return result;
        }

        if (a === 'send_image') {
            const url = getParam(params, 'url', 'image_url', 'link');
            if (!url) return _err('❌ يلزم تحديد "url" لإرسال الصورة.');
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة.');
            }
            const content = String(getParam(params, 'content', 'caption', 'text') || '').trim();
            const attachment = await _fetchAsAttachment(String(url), 'image.png');
            if (!attachment) return _err('❌ فشل جلب الصورة من الرابط.');
            await targetCh.send({ content: content.slice(0, 2000) || undefined, files: [attachment] });
            const result = _ok(`✅ تم إرسال الصورة إلى **#${targetCh.name}**`);
            result.__attachments = [attachment];
            return result;
        }

        // ─ـ قنوات ─ـ
        if (a === 'create_category') {
            const nameRaw = getParam(params, 'name', 'category_name', 'cat_name');
            if (!nameRaw) return _err('❌ يلزم تحديد "name" لإنشاء كاتيجوري.');
            // [FIX 1+2] تأكد أن الاسم string نظيف
            const nameVal = _cleanName(nameRaw);
            const cat = await guild.channels.create({
                name: nameVal,
                type: channelCreateType('category', tokenType),
            });
            return _ok(`✅ تم إنشاء الكاتيجوري **${cat.name}** في **${guild.name}**`);
        }

        if (a === 'create_channel') {
            const nameRaw = getParam(params, 'name', 'channel_name', 'ch_name');
            if (!nameRaw) return _err('❌ يلزم تحديد "name" لإنشاء روم.');
            const nameVal = _cleanName(nameRaw);
            const catVal  = getParam(params, 'category', 'parent', 'cat');
            const catObj  = catVal ? await findCategory(guild, String(catVal)) : null;
            const typeVal = String(getParam(params, 'type', 'channel_type') || 'text').toLowerCase();
            const chType  = channelCreateType(typeVal === 'voice' ? 'voice' : 'text', tokenType);
            const ch      = await guild.channels.create({
                name  : nameVal,
                type  : chType,
                parent: catObj || null,
            });
            const loc = catObj ? ` تحت **${catObj.name}**` : '';
            return _ok(`✅ تم إنشاء الروم **${ch.name}**${loc} في **${guild.name}**`);
        }

        if (a === 'delete_channel') {
            const err = requireOneParam(params, 'delete_channel', 'name', 'channel', 'channel_name');
            if (err) return err;
            const chVal = getParam(params, 'name', 'channel', 'channel_name');
            const ch = await findChannel(guild, String(chVal));
            if (!ch) return _err(`❌ ما لقيت روم: **${chVal}**`);
            const name = ch.name;
            await ch.delete();
            return _ok(`✅ تم حذف الروم **${name}**`);
        }

        if (a === 'rename_channel') {
            const err = requireOneParam(params, 'rename_channel', 'channel', 'name', 'channel_name');
            if (err) return err;
            const chVal  = getParam(params, 'channel', 'name', 'channel_name');
            const newRaw = getParam(params, 'new_name', 'newName', 'name_to');
            if (!newRaw) return _err('❌ يلزم تحديد "new_name" لتغيير اسم الروم.');
            const newName = _cleanName(newRaw);
            const ch = await findChannel(guild, String(chVal));
            if (!ch) return _err(`❌ ما لقيت روم: **${chVal}**`);
            const old = ch.name;
            await ch.edit({ name: newName });
            return _ok(`✅ تم تغيير اسم **${old}** → **${newName}**`);
        }

        if (a === 'clear_channel') {
            const chVal = getParam(params, 'channel', 'name', 'channel_name');
            let targetCh = null;
            if (chVal) {
                const chQ = String(chVal).trim();
                // [FIX 4] أولاً نبحث بالاسم/ID عبر findChannel
                const found = await findChannel(guild, chQ);
                if (found && isTextChannel(found)) {
                    targetCh = found;
                } else if (/^\d{17,20}$/.test(chQ)) {
                    // [FIX 4] نستخدم fetch بالـ ID فقط إذا كان رقماً حقيقياً
                    try {
                        const fetched = await client.channels.fetch(chQ);
                        if (fetched && isTextChannel(fetched)) targetCh = fetched;
                    } catch (_) {}
                }
                if (!targetCh) return _err(`❌ ما لقيت قناة نصية: **${chQ}**`);
            } else {
                targetCh = channel;
            }

            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة (channel).');
            }

            const limit = Number(getParam(params, 'limit', 'count') || 100);
            let checkFn = null;
            if (params.before) {
                const beforeId = String(params.before).trim();
                if (!/^\d{17,20}$/.test(beforeId)) {
                    return _err("❌ قيمة 'before' يجب أن تكون ID رقمي صحيح.");
                }
                checkFn = (msg) => msg.id < beforeId;
            }

            const deleted = await _safePurge(targetCh, Math.min(limit, 500), checkFn, tokenType);
            return _ok(`✅ تم حذف **${deleted}** رسالة من **#${targetCh.name}**`);
        }

        if (a === 'delete_member_messages') {
            const memberVal = getParam(params, 'member', 'user', 'member_id', 'user_id');
            const memberQ   = String(memberVal || '').trim();
            if (!memberQ) return _err('❌ حدد العضو (member).');
            
            let member   = await findMember(guild, memberQ, client);
            let memberId = member?.id;

            if (!memberId) {
                // إذا كان ID رقمي، جرب fetch مباشر
                if (/^\d{17,20}$/.test(memberQ)) {
                    try {
                        member   = await guild.members.fetch(memberQ);
                        memberId = member.id;
                    } catch (_) {
                        memberId = memberQ; // استخدمه كـ ID مباشرة
                    }
                } else {
                    return _err(`❌ ما لقيت العضو: **${memberQ}**`);
                }
            }

            const chVal = getParam(params, 'channel', 'name', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const chQ   = String(chVal).trim();
                const found = await findChannel(guild, chQ);
                if (found && isTextChannel(found)) {
                    targetCh = found;
                } else if (/^\d{17,20}$/.test(chQ)) {
                    try {
                        const fetched = await client.channels.fetch(chQ);
                        if (fetched && isTextChannel(fetched)) targetCh = fetched;
                    } catch (_) {
                        return _err(`❌ ما لقيت قناة: **${chQ}**`);
                    }
                } else {
                    return _err(`❌ ما لقيت قناة: **${chQ}**`);
                }
            }

            if (!targetCh) return _err('❌ حدد القناة (channel) صراحة.');

            const limit   = Number(getParam(params, 'limit', 'count') || 100);
            const checkFn = (msg) => msg.author?.id === String(memberId);
            const deleted  = await _safePurge(targetCh, Math.min(limit, 500), checkFn, tokenType);
            const displayName = member?.displayName || `ID:${memberId}`;
            return _ok(`✅ تم حذف **${deleted}** رسالة للعضو **${displayName}**`);
        }

        if (a === 'delete_member_messages_all_channels') {
            const memberVal = getParam(params, 'member', 'user', 'member_id', 'user_id');
            const memberQ   = String(memberVal || '').trim();
            if (!memberQ) return _err('❌ حدد العضو (member).');
            
            const member   = await findMember(guild, memberQ, client).catch(() => null);
            const memberId = member?.id || (/^\d{17,20}$/.test(memberQ) ? memberQ : null);
            if (!memberId) return _err(`❌ ما لقيت العضو: **${memberQ}**`);

            const perChannelLimit = Math.min(Number(getParam(params, 'limit_per_channel', 'limit') || 100), 500);
            let totalDeleted = 0;
            let scannedChannels = 0;
            const failures = [];

            for (const ch of guild.channels.cache.values()) {
                if (!isTextChannel(ch)) continue;
                scannedChannels++;
                try {
                    totalDeleted += await _safePurge(ch, perChannelLimit, msg => msg.author?.id === String(memberId), tokenType);
                    await new Promise(r => setTimeout(r, 750));
                } catch (e) {
                    failures.push(`${ch.name}: ${e.message}`);
                }
            }
            return _ok(
                `✅ تم حذف **${totalDeleted}** رسالة للعضو من **${scannedChannels}** قناة.`,
                { deleted: totalDeleted, channels: scannedChannels, failures: failures.slice(0, 5) }
            );
        }

        // ─ـ رتب ─ـ
        if (a === 'create_role') {
            const nameRaw = getParam(params, 'name', 'role_name');
            if (!nameRaw) return _err('❌ يلزم تحديد "name" لإنشاء رتبة.');
            const nameVal = String(nameRaw).trim().slice(0, 100);
            let color = 0;
            try {
                const colorRaw = getParam(params, 'color', 'colour');
                if (colorRaw) color = parseInt(String(colorRaw).replace('#', ''), 16) || 0;
            } catch (_) {}
            
            const role = await guild.roles.create({
                name       : nameVal,
                color      : color,
                permissions: getParam(params, 'perms', 'permissions')
                    ? new PermissionsBitField(
                        Object.entries(getParam(params, 'perms', 'permissions'))
                            .filter(([, v]) => v)
                            .map(([k]) => k)
                      )
                    : 0n,
            });
            const posVal = getParam(params, 'position', 'pos');
            if (posVal && Number(posVal) > 0) {
                try { await guild.roles.setPosition(role, Number(posVal)); } catch (_) {}
            }
            return _ok(`✅ تم إنشاء الرتبة **${role.name}** في **${guild.name}**`);
        }

        if (a === 'delete_role') {
            const err = requireOneParam(params, 'delete_role', 'name', 'role', 'role_name');
            if (err) return err;
            const roleVal = getParam(params, 'name', 'role', 'role_name');
            const role = await findRole(guild, String(roleVal));
            if (!role) return _err(`❌ ما لقيت رتبة: **${roleVal}**`);
            const name = role.name;
            await role.delete();
            return _ok(`✅ تم حذف الرتبة **${name}**`);
        }

        if (a === 'edit_role') {
            const err = requireOneParam(params, 'edit_role', 'name', 'role', 'role_name');
            if (err) return err;
            const roleVal = getParam(params, 'name', 'role', 'role_name');
            const role = await findRole(guild, String(roleVal));
            if (!role) return _err(`❌ ما لقيت رتبة: **${roleVal}**`);
            const kw = {};
            const newName = getParam(params, 'new_name', 'newName');
            if (newName) kw.name = String(newName).trim().slice(0, 100);
            const colorVal = getParam(params, 'color', 'colour');
            if (colorVal) kw.color = parseInt(String(colorVal).replace('#', ''), 16);
            const permsVal = getParam(params, 'perms', 'permissions');
            if (permsVal) {
                kw.permissions = new PermissionsBitField(
                    Object.entries(permsVal).filter(([, v]) => v).map(([k]) => k),
                );
            }
            await role.edit(kw);
            return _ok(`✅ تم تعديل الرتبة **${role.name}**`);
        }

        if (a === 'grant_role') {
            const errM = requireOneParam(params, 'grant_role', 'member', 'user', 'member_id');
            if (errM) return errM;
            const errR = requireOneParam(params, 'grant_role', 'role', 'role_name');
            if (errR) return errR;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const roleVal   = getParam(params, 'role', 'role_name');
            const member = await findMember(guild, String(memberVal), client);
            const role   = await findRole(guild, String(roleVal));
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            if (!role)   return _err(`❌ ما لقيت الرتبة: **${roleVal}**`);
            await member.roles.add(role);
            return _ok(`✅ أعطيت **${member.displayName}** رتبة **${role.name}**`);
        }

        if (a === 'revoke_role') {
            const errM = requireOneParam(params, 'revoke_role', 'member', 'user', 'member_id');
            if (errM) return errM;
            const errR = requireOneParam(params, 'revoke_role', 'role', 'role_name');
            if (errR) return errR;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const roleVal   = getParam(params, 'role', 'role_name');
            const member = await findMember(guild, String(memberVal), client);
            const role   = await findRole(guild, String(roleVal));
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            if (!role)   return _err(`❌ ما لقيت الرتبة: **${roleVal}**`);
            await member.roles.remove(role);
            return _ok(`✅ سحبت رتبة **${role.name}** من **${member.displayName}**`);
        }

        if (a === 'set_role_color') {
            const err = requireOneParam(params, 'set_role_color', 'role', 'role_name');
            if (err) return err;
            const roleVal  = getParam(params, 'role', 'role_name');
            const role     = await findRole(guild, String(roleVal));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${roleVal}**`);
            const colorVal = getParam(params, 'color', 'colour') || '#99AAB5';
            const colorInt = parseInt(String(colorVal).replace('#', ''), 16);
            await role.edit({ color: colorInt });
            return _ok(`🎨 تم تغيير لون رتبة **${role.name}**`);
        }

        if (a === 'set_role_mentionable') {
            const err = requireOneParam(params, 'set_role_mentionable', 'role', 'role_name');
            if (err) return err;
            const roleVal    = getParam(params, 'role', 'role_name');
            const role       = await findRole(guild, String(roleVal));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${roleVal}**`);
            const mentionable = getParam(params, 'mentionable', 'mention') !== false;
            await role.edit({ mentionable: Boolean(mentionable) });
            return _ok(`✅ رتبة **${role.name}** ${mentionable ? 'قابلة للمنشن' : 'غير قابلة للمنشن'}`);
        }

        if (a === 'remove_role_from_all') {
            const err = requireOneParam(params, 'remove_role_from_all', 'role', 'role_name');
            if (err) return err;
            const roleVal = getParam(params, 'role', 'role_name');
            const role    = await findRole(guild, String(roleVal));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${roleVal}**`);
            let count = 0;
            for (const mem of role.members.values()) {
                await mem.roles.remove(role, getParam(params, 'reason') || 'Remove role from all');
                count++;
            }
            return _ok(`✅ تم سحب رتبة **${role.name}** من **${count}** عضو`);
        }

        if (a === 'add_role_to_bots') {
            const err = requireOneParam(params, 'add_role_to_bots', 'role', 'role_name');
            if (err) return err;
            const roleVal = getParam(params, 'role', 'role_name');
            const role    = await findRole(guild, String(roleVal));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${roleVal}**`);
            let count = 0;
            for (const mem of guild.members.cache.values()) {
                if (mem.user.bot && !mem.roles.cache.has(role.id)) {
                    await mem.roles.add(role);
                    count++;
                }
            }
            return _ok(`🤖 تم إعطاء رتبة **${role.name}** إلى **${count}** بوت`);
        }

        // ─ـ أعضاء ─ـ
        if (a === 'kick_member') {
            const err = requireOneParam(params, 'kick_member', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const member = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            const name = member.displayName;
            await member.kick(getParam(params, 'reason') || '—');
            return _ok(`✅ تم كيك **${name}**`);
        }

        if (a === 'ban_member') {
            const err = requireOneParam(params, 'ban_member', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const member = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            const name = member.displayName;
            await member.ban({ reason: getParam(params, 'reason') || '—', deleteMessageDays: 0 });
            return _ok(`✅ تم بان **${name}**`);
        }

        if (a === 'unban_member') {
            const err = requireOneParam(params, 'unban_member', 'user', 'member', 'user_id');
            if (err) return err;
            const userVal = getParam(params, 'user', 'member', 'user_id');
            const user = await client.users.fetch(String(userVal)).catch(() => null);
            if (!user) return _err(`❌ ما لقيت المستخدم: **${userVal}**`);
            await guild.members.unban(user, getParam(params, 'reason') || '—');
            return _ok(`✅ تم فك الحظر عن **${user.username}**`);
        }

        if (a === 'timeout_member') {
            const err = requireOneParam(params, 'timeout_member', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const member    = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            const minutes = Math.max(1, Math.min(Number(getParam(params, 'minutes', 'duration') || 10), 40320));
            const until   = new Date(Date.now() + minutes * 60000);
            await member.timeout(until, getParam(params, 'reason') || '—');
            return _ok(`⏳ تم تايم آوت **${member.displayName}** لمدة **${minutes}** دقيقة`);
        }

        if (a === 'remove_timeout') {
            const err = requireOneParam(params, 'remove_timeout', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const member    = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            await member.timeout(null, getParam(params, 'reason') || '—');
            return _ok(`✅ تم إزالة التايم آوت عن **${member.displayName}**`);
        }

        if (a === 'change_nickname') {
            const err = requireOneParam(params, 'change_nickname', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const newNick   = getParam(params, 'nickname', 'nick', 'new_nickname', 'new_name');
            const member    = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            const old = member.displayName;
            await member.setNickname(newNick ? String(newNick).slice(0, 32) : null);
            return _ok(`✅ تم تغيير نكنيم **${old}** → **${newNick || '(مسح)'}**`);
        }

        if (a === 'move_member') {
            const errM = requireOneParam(params, 'move_member', 'member', 'user', 'member_id');
            if (errM) return errM;
            const errC = requireOneParam(params, 'move_member', 'channel', 'voice_channel');
            if (errC) return errC;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const chVal     = getParam(params, 'channel', 'voice_channel');
            const member    = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            const vc = await findChannel(guild, String(chVal));
            if (!vc || !isVoiceChannel(vc)) return _err(`❌ ما لقيت فويس: **${chVal}**`);
            await member.voice.setChannel(vc);
            return _ok(`✅ تم نقل **${member.displayName}** إلى **${vc.name}**`);
        }

        if (a === 'voice_mute') {
            const err = requireOneParam(params, 'voice_mute', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const member    = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            const mute = getParam(params, 'mute', 'muted') !== false;
            await member.voice.setMute(Boolean(mute));
            return _ok(`🔇 تم ${mute ? 'كتم' : 'إلغاء كتم'} **${member.displayName}**`);
        }

        if (a === 'voice_deafen') {
            const err = requireOneParam(params, 'voice_deafen', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const member    = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            const deafen = getParam(params, 'deafen', 'deafened') !== false;
            await member.voice.setDeaf(Boolean(deafen));
            return _ok(`🔕 ${deafen ? 'إسكات السماع' : 'إلغاء إسكات'} **${member.displayName}**`);
        }

        if (a === 'disconnect_member') {
            const err = requireOneParam(params, 'disconnect_member', 'member', 'user', 'member_id');
            if (err) return err;
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            const member    = await findMember(guild, String(memberVal), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${memberVal}**`);
            await member.voice.disconnect();
            return _ok(`📤 تم فصل **${member.displayName}** من الفويس`);
        }

        // ─ـ رسائل ─ـ
        if (a === 'send_message') {
            const chVal = getParam(params, 'channel', 'channel_name', 'name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة (channel).');
            const content = String(getParam(params, 'content', 'message', 'text') || '').trim();
            if (!content) return _err('❌ محتوى الرسالة فارغ.');
            
            let sent;
            const replyTo = getParam(params, 'reply_to', 'reply_to_message');
            if (replyTo) {
                const replyId = String(replyTo).trim();
                // [FIX] استخدام try/catch بدل .catch مباشرة على Promise
                let ref = null;
                try { ref = await targetCh.messages.fetch(replyId); } catch (_) {}
                
                if (!ref && getParam(params, 'reply_channel')) {
                    const replyCh = await findChannel(guild, String(getParam(params, 'reply_channel')));
                    if (replyCh && isTextChannel(replyCh)) {
                        try { ref = await replyCh.messages.fetch(replyId); targetCh = replyCh; } catch (_) {}
                    }
                }
                if (!ref) {
                    for (const g of client.guilds.cache.values()) {
                        for (const ch of g.channels.cache.values()) {
                            if (!isTextChannel(ch)) continue;
                            try { ref = await ch.messages.fetch(replyId); if (ref) { targetCh = ch; break; } } catch (_) {}
                        }
                        if (ref) break;
                    }
                }
                if (!ref) return _err('❌ لم أجد رسالة reply_to. تأكد من ID الرسالة.');
                sent = await ref.reply(content.slice(0, 2000));
            } else {
                sent = await targetCh.send(content.slice(0, 2000));
            }
            return _ok(`✅ تم إرسال الرسالة في **#${targetCh.name}**`, { message_id: sent.id, replied_to: replyTo || null });
        }

        if (a === 'mention_everyone') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            const extra = String(getParam(params, 'content', 'message', 'text') || '').trim();
            const text  = extra ? `@everyone ${extra}` : '@everyone';
            const sent  = await targetCh.send({
                content        : text.slice(0, 2000),
                allowedMentions: { parse: ['everyone'] },
            });
            return _ok(`✅ تم إرسال منشن @everyone في **#${targetCh.name}**`, { message_id: sent.id });
        }

        if (a === 'react_message') {
            const chVal = getParam(params, 'channel', 'channel_name');
            const msgId = getParam(params, 'message_id', 'msg_id');
            const emoji = getParam(params, 'emoji', 'reaction') || '✅';
            if (!msgId) return _err('❌ يلزم تحديد "message_id" للتفاعل.');
            const targetCh = chVal ? await findChannel(guild, String(chVal)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            // [FIX] try/catch بدل .catch
            let msg = null;
            try { msg = await targetCh.messages.fetch(String(msgId)); } catch (_) {}
            if (!msg) return _err('❌ لم أجد الرسالة.');
            await msg.react(String(emoji));
            return _ok(`✅ تم وضع التفاعل على الرسالة في #${targetCh.name}`);
        }

        if (a === 'edit_own_message') {
            const chVal   = getParam(params, 'channel', 'channel_name');
            const msgId   = getParam(params, 'message_id', 'msg_id');
            const content = getParam(params, 'content', 'message', 'text');
            if (!msgId) return _err('❌ يلزم تحديد "message_id" لتعديل الرسالة.');
            const targetCh = chVal ? await findChannel(guild, String(chVal)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            let msg = null;
            try { msg = await targetCh.messages.fetch(String(msgId)); } catch (_) {}
            if (!msg) return _err('❌ لم أجد الرسالة.');
            if (msg.author.id !== client.user.id) return _err('❌ لا أستطيع تعديل رسالة ليست لي.');
            await msg.edit(String(content || '').slice(0, 2000));
            return _ok(`✅ تم تعديل رسالتي في #${targetCh.name}`);
        }

        if (a === 'delete_message') {
            const chVal = getParam(params, 'channel', 'channel_name');
            const msgId = getParam(params, 'message_id', 'msg_id');
            if (!msgId) return _err('❌ يلزم تحديد "message_id" لحذف الرسالة.');
            const targetCh = chVal ? await findChannel(guild, String(chVal)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            // [FIX] try/catch بدل .catch
            let msg = null;
            try { msg = await targetCh.messages.fetch(String(msgId)); } catch (_) {}
            if (!msg) return _err('❌ لم أجد الرسالة.');
            await msg.delete();
            return _ok(`🗑️ تم حذف الرسالة من #${targetCh.name}`);
        }

        if (a === 'forward_message') {
            const msgId     = getParam(params, 'message_id', 'msg_id');
            if (!msgId) return _err('❌ يلزم تحديد "message_id" لتحويل الرسالة.');
            const fromChVal = getParam(params, 'from_channel', 'source_channel');
            const toChVal   = getParam(params, 'to_channel', 'target_channel');
            const fromCh    = fromChVal ? await findChannel(guild, String(fromChVal)) : channel;
            const toCh      = toChVal   ? await findChannel(guild, String(toChVal))   : channel;
            if (!fromCh || !toCh || !isTextChannel(fromCh) || !isTextChannel(toCh))
                return _err('❌ حدد قنوات نصية صحيحة.');
            let msg = null;
            try { msg = await fromCh.messages.fetch(String(msgId)); } catch (_) {}
            if (!msg) return _err('❌ لم أجد الرسالة الأصلية.');
            let sent;
            try {
                sent = await msg.forward(toCh);
            } catch (_) {
                sent = await toCh.send({ content: `Forwarded from ${msg.url}\n${String(msg.content || '').slice(0, 1800)}` });
            }
            return _ok(`📨 تم تحويل الرسالة إلى #${toCh.name}`, { message_id: sent?.id || null });
        }

        if (a === 'send_dm') {
            const userVal = getParam(params, 'user', 'member', 'user_id', 'member_id');
            if (!userVal) return _err('❌ يلزم تحديد "user" لإرسال رسالة خاصة.');
            const user = await client.users.fetch(String(userVal).trim()).catch(() => null);
            if (!user) return _err('❌ لم أجد المستخدم لإرسال الخاص.');
            const content = getParam(params, 'content', 'message', 'text');
            if (!content) return _err('❌ محتوى الرسالة فارغ.');
            const sent = await user.send(String(content).slice(0, 2000));
            return _ok(`📩 تم إرسال رسالة خاصة إلى ${user.username}`, { message_id: sent.id });
        }

        if (a === 'pin_message') {
            const chVal = getParam(params, 'channel', 'channel_name');
            const msgId = getParam(params, 'message_id', 'msg_id');
            if (!msgId) return _err('❌ يلزم تحديد "message_id" لتثبيت الرسالة.');
            const targetCh = chVal ? await findChannel(guild, String(chVal)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            let msg = null;
            try { msg = await targetCh.messages.fetch(String(msgId)); } catch (_) {}
            if (!msg) return _err('❌ لم أجد الرسالة.');
            await msg.pin();
            return _ok(`📌 تم تثبيت الرسالة في **#${targetCh.name}**`);
        }

        if (a === 'unpin_message') {
            const chVal = getParam(params, 'channel', 'channel_name');
            const msgId = getParam(params, 'message_id', 'msg_id');
            if (!msgId) return _err('❌ يلزم تحديد "message_id" لإلغاء التثبيت.');
            const targetCh = chVal ? await findChannel(guild, String(chVal)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            let msg = null;
            try { msg = await targetCh.messages.fetch(String(msgId)); } catch (_) {}
            if (!msg) return _err('❌ لم أجد الرسالة.');
            await msg.unpin();
            return _ok(`📌 تم إلغاء تثبيت الرسالة من **#${targetCh.name}**`);
        }

        // ─ـ صلاحيات القنوات ─ـ
        if (a === 'set_channel_permissions') {
            const chVal = getParam(params, 'channel', 'channel_name', 'name');
            if (!chVal) return _err('❌ يلزم تحديد "channel" لتعديل صلاحيات القناة.');
            const chObj = await findChannel(guild, String(chVal));
            if (!chObj) return _err(`❌ ما لقيت القناة: **${chVal}**`);

            let target = null;
            const roleVal   = getParam(params, 'role', 'role_name');
            const memberVal = getParam(params, 'member', 'user', 'member_id');
            if (roleVal) {
                target = await findRole(guild, String(roleVal));
                if (!target) return _err(`❌ ما لقيت الرتبة: **${roleVal}**`);
            } else if (memberVal) {
                target = await findMember(guild, String(memberVal), client);
                if (!target) {
                    try { target = await guild.members.fetch(String(memberVal).trim()); } catch (_) {
                        return _err(`❌ ما لقيت العضو: **${memberVal}**`);
                    }
                }
            } else {
                return _err('❌ حدد role أو member لتعديل صلاحيات القناة.');
            }

            const permMap = getParam(params, 'perms', 'permissions') || {};
            if (typeof permMap !== 'object') return _err('❌ perms يجب أن يكون كائن {permission: true/false/null}.');
            const owKwargs = {};
            for (const [key, val] of Object.entries(permMap)) {
                owKwargs[key] = val === null ? null : Boolean(val);
            }
            await chObj.permissionOverwrites.edit(target, owKwargs);
            const targetName = target.displayName || target.name || String(target.id);
            return _ok(`✅ تم تعديل صلاحيات **${targetName}** في **#${chObj.name}**`);
        }

        // ─ـ ثريد وإعلانات ─ـ
        if (a === 'create_thread') {
            const nameRaw = getParam(params, 'name', 'thread_name');
            if (!nameRaw) return _err('❌ يلزم تحديد "name" لإنشاء ثريد.');
            const nameVal  = String(nameRaw).trim().slice(0, 100);
            const chVal    = getParam(params, 'channel', 'channel_name');
            let targetCh   = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة لإنشاء الثريد.');
            const thread = await targetCh.threads.create({
                name               : nameVal,
                autoArchiveDuration: Number(getParam(params, 'auto_archive_duration', 'archive_duration') || 1440),
                type               : channelCreateType('thread', tokenType),
            });
            return _ok(`✅ تم إنشاء الثريد **${thread.name}** في **#${targetCh.name}**`, { thread_id: thread.id });
        }

        if (a === 'slowmode') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة للسلو مود.');
            const seconds = Number(getParam(params, 'seconds', 'duration', 'time') || 0);
            await targetCh.setRateLimitPerUser(seconds);
            return _ok(seconds === 0
                ? `✅ تم إيقاف السلو مود في **#${targetCh.name}**`
                : `✅ سلو مود **${seconds}** ثانية في **#${targetCh.name}**`
            );
        }

        if (a === 'lock_channel') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة لقفلها.');
            await targetCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
            return _ok(`🔒 تم قفل الكتابة في **#${targetCh.name}**`);
        }

        if (a === 'unlock_channel') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة لفتحها.');
            await targetCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
            return _ok(`🔓 تم فتح الكتابة في **#${targetCh.name}**`);
        }

        if (a === 'set_channel_topic') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            const topic = getParam(params, 'topic', 'description');
            if (topic === undefined) return _err('❌ يلزم تحديد "topic".');
            await targetCh.setTopic(String(topic).slice(0, 1024));
            return _ok(`✅ تم تعديل وصف **#${targetCh.name}**`);
        }

        if (a === 'create_invite') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && (isTextChannel(found) || isVoiceChannel(found))) targetCh = found;
            }
            if (!targetCh) return _err('❌ حدد قناة صحيحة لإنشاء الدعوة.');
            const invite = await targetCh.createInvite({
                maxAge : Number(getParam(params, 'max_age', 'expires') || 86400),
                maxUses: Number(getParam(params, 'max_uses', 'uses') || 0),
                unique : true,
            });
            return _ok(`✅ تم إنشاء دعوة: ${invite.url}`, { url: invite.url });
        }

        if (a === 'archive_channel') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة لأرشفتها.');
            await targetCh.setName(`archived-${targetCh.name}`.slice(0, 100));
            await targetCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
            return _ok(`🗄️ تم أرشفة **#${targetCh.name}**`);
        }

        if (a === 'nuke_channel') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            const oldName = targetCh.name;
            const newCh   = await targetCh.clone();
            await newCh.setPosition(targetCh.position);
            await targetCh.delete();
            return _ok(`💥 تم تنظيف قناة **#${oldName}** بإعادة إنشائها`, { channel_id: newCh.id });
        }

        if (a === 'create_announcement') {
            const nameRaw = getParam(params, 'name', 'channel_name') || 'announcements';
            const nameVal = _cleanName(nameRaw);
            const ch = await guild.channels.create({ name: nameVal, type: channelCreateType('text', tokenType) });
            await ch.setTopic(String(getParam(params, 'topic', 'description') || 'قناة إعلانات السيرفر').slice(0, 1024));
            return _ok(`📢 تم إنشاء قناة إعلانات **#${ch.name}**`, { channel_id: ch.id });
        }

        if (a === 'start_events') {
            const chVal   = getParam(params, 'channel', 'channel_name');
            const targetCh = chVal ? (await findChannel(guild, String(chVal)) || channel) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة فعاليات نصية صحيحة.');
            const { runEventSeries } = require('../accountAgent');
            const result = await runEventSeries(client, guild, targetCh, { agentId: client.__agentId || 'default' }, {
                gameName: getParam(params, 'game', 'game_name') || null,
                count   : Number(getParam(params, 'count', 'number') || 1),
                minutes : Number(getParam(params, 'minutes', 'duration') || 0),
                first   : true,
            });
            return _ok(`🎮 ${result.msg}`, { games: result.results.map(g => ({ name: g.name, command: g.command })) });
        }

        // ─ـ clone_server ─ـ
        if (a === 'clone_server') {
            let sourceGuild = guild;
            if (params.source_guild) {
                const found = findGuild(client, String(params.source_guild));
                if (!found) return _err(`❌ ما لقيت سيرفر مصدر: **${params.source_guild}**`);
                sourceGuild = found;
            }
            let target = guild;
            if (params.target_guild) {
                const found = findGuild(client, String(params.target_guild));
                if (!found) return _err(`❌ ما لقيت سيرفر هدف: **${params.target_guild}**`);
                target = found;
            }
            if (sourceGuild.id === target.id) return _err('❌ المصدر والهدف لا يمكن أن يكونا نفس السيرفر.');

            const includeRoles      = getParam(params, 'include_roles', 'roles') !== false;
            const includeCategories = getParam(params, 'include_categories', 'categories') !== false;
            const includeChannels   = getParam(params, 'include_channels', 'channels') !== false;

            let createdRoles = 0, createdCategories = 0, createdChannels = 0;
            const errors = [];
            const roleMap = new Map();
            const catMap  = new Map();

            if (includeRoles) {
                const sortedRoles = [...sourceGuild.roles.cache.values()]
                    .filter(r => r.name !== '@everyone')
                    .sort((a, b) => b.position - a.position);
                for (const r of sortedRoles) {
                    try {
                        const newRole = await target.roles.create({
                            name       : String(r.name).slice(0, 100),
                            color      : r.color,
                            permissions: r.permissions,
                            hoist      : r.hoist,
                            mentionable: r.mentionable,
                            reason     : `Clone from ${sourceGuild.name}`,
                        });
                        roleMap.set(r.id, newRole);
                        createdRoles++;
                    } catch (e) {
                        errors.push(`رتبة ${r.name}: ${e.message}`);
                    }
                }
                if (roleMap.size > 0) {
                    try {
                        const botMember = await target.members.fetchMe();
                        const myTop     = botMember.roles.highest.position;
                        const positions = [];
                        let pos = Math.max(1, myTop - 1);
                        for (const r of sortedRoles) {
                            const newRole = roleMap.get(r.id);
                            if (!newRole || pos < 1) break;
                            positions.push({ role: newRole, position: pos });
                            pos--;
                        }
                        if (positions.length) await target.roles.setPositions(positions);
                    } catch (e) {
                        errors.push(`ترتيب الرتب: ${e.message}`);
                    }
                }
            }

            if (includeCategories) {
                const sortedCats = [...sourceGuild.channels.cache.values()]
                    .filter(c => isCategoryChannel(c))
                    .sort((a, b) => a.position - b.position);
                for (const cat of sortedCats) {
                    try {
                        const newCat = await target.channels.create({
                            name                : _cleanName(cat.name),
                            type                : channelTypeForClone(cat, client),
                            permissionOverwrites: mapPermissionOverwrites(cat, target, roleMap),
                            position            : cat.position,
                        });
                        catMap.set(cat.id, newCat);
                        createdCategories++;
                    } catch (e) {
                        errors.push(`كاتيجوري ${cat.name}: ${e.message}`);
                    }
                }
            }

            if (includeChannels) {
                const sortedChs = [...sourceGuild.channels.cache.values()]
                    .filter(c => !isCategoryChannel(c))
                    .sort((a, b) => a.position - b.position);
                for (const ch of sortedChs) {
                    try {
                        const targetCat = (includeCategories && ch.parentId) ? (catMap.get(ch.parentId) || null) : null;
                        const opts = {
                            name                : _cleanName(ch.name),
                            type                : channelTypeForClone(ch, client),
                            parent              : targetCat,
                            permissionOverwrites: includeRoles ? mapPermissionOverwrites(ch, target, roleMap) : [],
                            position            : ch.position,
                        };
                        if (isTextChannel(ch)) {
                            Object.assign(opts, {
                                topic           : ch.topic ? String(ch.topic).slice(0, 1024) : null,
                                nsfw            : ch.nsfw,
                                rateLimitPerUser: ch.rateLimitPerUser,
                            });
                        } else if (isVoiceChannel(ch)) {
                            Object.assign(opts, {
                                bitrate  : Math.min(ch.bitrate || 64000, target.maximumBitrate || 96000),
                                userLimit: ch.userLimit,
                            });
                        }
                        await target.channels.create(opts);
                        createdChannels++;
                    } catch (e) {
                        errors.push(`روم ${ch.name}: ${e.message}`);
                    }
                }
            }

            const parts = [];
            if (includeRoles)      parts.push(`الرتب: ${createdRoles}`);
            if (includeCategories) parts.push(`الكاتيجوريات: ${createdCategories}`);
            if (includeChannels)   parts.push(`الرومات: ${createdChannels}`);
            const doneParts = parts.join(' | ') || 'لم يُطلب نسخ أي عنصر';
            const status    = errors.length ? 'مع أخطاء' : 'بنجاح';
            let summary = `✅ ${status} استنساخ **${sourceGuild.name}** → **${target.name}**\n${doneParts}`;
            if (errors.length) summary += `\n⚠️ فشل (${errors.length}): ` + errors.slice(0, 5).join('، ');
            return { ok: !errors.length || (createdRoles + createdCategories + createdChannels) > 0, msg: summary };
        }

        // ─ـ Webhook, DM, Poll ─ـ
        if (a === 'create_webhook') {
            const chVal   = getParam(params, 'channel', 'channel_name');
            const nameVal = String(getParam(params, 'name', 'webhook_name') || 'Disor Webhook').slice(0, 80);
            let targetCh  = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة لإنشاء الويبهوك.');
            const wh = await targetCh.createWebhook({ name: nameVal });
            return _ok(`🔗 تم إنشاء ويبهوك **${wh.name}** في **#${targetCh.name}**`, { url: wh.url, id: wh.id });
        }

        if (a === 'send_webhook_message') {
            const whUrl   = String(getParam(params, 'webhook_url', 'url') || '');
            const content = String(getParam(params, 'content', 'message', 'text') || '').trim();
            const whName  = String(getParam(params, 'username', 'name') || 'Webhook');
            if (!whUrl)   return _err('❌ يجب تحديد webhook_url.');
            if (!content) return _err('❌ محتوى الرسالة فارغ.');
            const resp = await axios.post(whUrl, { content: content.slice(0, 2000), username: whName }, { timeout: 10000 });
            if ([200, 204].includes(resp.status)) return _ok(`✅ تم إرسال الرسالة عبر الويبهوك`);
            return _err(`❌ فشل إرسال الويبهوك: ${resp.status}`);
        }

        if (a === 'mass_dm') {
            const content    = String(getParam(params, 'content', 'message', 'text') || '').trim();
            if (!content) return _err('❌ محتوى الرسالة فارغ.');
            const roleFilter = getParam(params, 'role', 'role_name');
            let members      = [...guild.members.cache.values()];
            if (roleFilter) {
                const roleObj = await findRole(guild, String(roleFilter));
                if (!roleObj) return _err(`❌ ما لقيت الرتبة: **${roleFilter}**`);
                members = [...roleObj.members.values()];
            }
            let sentCount = 0, failedCount = 0;
            const limit   = Math.min(Number(getParam(params, 'limit', 'count') || 50), members.length);
            for (const mem of members.slice(0, limit)) {
                if (mem.user.bot) continue;
                try {
                    await mem.send(content.slice(0, 2000));
                    sentCount++;
                    await new Promise(r => setTimeout(r, 1000));
                } catch (_) { failedCount++; }
            }
            return _ok(`📨 تم إرسال DM إلى **${sentCount}** عضو (${failedCount} فشل)`);
        }

        if (a === 'poll') {
            const chVal = getParam(params, 'channel', 'channel_name');
            let targetCh = channel;
            if (chVal) {
                const found = await findChannel(guild, String(chVal));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة للتصويت.');
            const question = String(getParam(params, 'question', 'title') || 'تصويت').trim();
            const options  = Array.isArray(getParam(params, 'options', 'choices'))
                ? getParam(params, 'options', 'choices')
                : ['✅ نعم', '❌ لا'];
            if (options.length < 2) return _err('❌ يجب توفير قائمة خيارات بعنصرين على الأقل.');
            const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
            const lines = [`📊 **${question}**\n`];
            for (let i = 0; i < Math.min(options.length, 10); i++) lines.push(`${numberEmojis[i]} ${options[i]}`);
            const pollMsg = await targetCh.send(lines.join('\n'));
            for (let i = 0; i < Math.min(options.length, 10); i++) await pollMsg.react(numberEmojis[i]);
            return _ok(`✅ تم إنشاء التصويت في **#${targetCh.name}**`, { message_id: pollMsg.id });
        }

        return _err(`⚠️ عملية غير معروفة: **${action}**`);

    } catch (e) {
        if (e.code === 50013) return _err(`⛔ البوت لا يملك الصلاحية لتنفيذ **${action}**.`);
        if (e.status === 429 || e.httpStatus === 429) return _err(`⏳ Rate Limit أثناء **${action}**. حاول مرة أخرى.`);
        console.error(`[executeAction error] ${action}:`, e);
        return _err(`❌ خطأ في **${action}**: ${String(e.message || e).slice(0, 200)}`);
    }
}

module.exports = { _safePurge, safeApiCall, executeAction };
