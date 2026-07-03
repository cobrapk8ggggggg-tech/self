/**
 * tools/executeAction.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * دالة _safePurge + دالة executeAction الرئيسية
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const axios = require('axios');
const { ChannelType, PermissionsBitField } = require('discord.js');
const { isTextChannel, isVoiceChannel, isCategoryChannel, channelCreateType, isUserRuntime } = require('../discordAdapter');

const {
    _err, _ok,
    findChannel, findCategory, findRole, findMember, findGuild,
} = require('../utils');

// ══════════════════════════════════════════════════════════════
//  SAFE PURGE — حذف آمن مع retry عند 429
// ══════════════════════════════════════════════════════════════

/**
 * wrapper آمن لـ bulkDelete/purge — يتعامل مع 429 بشكل صحيح
 * @param {import('discord.js').TextChannel} channel
 * @param {number} limit
 * @param {Function|null} checkFn - دالة فلترة اختيارية
 * @returns {Promise<number>} عدد الرسائل المحذوفة
 */
async function _safePurge(channel, limit, checkFn = null) {
    const fetchLimit = Math.min(limit, 100);
    let totalDeleted = 0;
    let remaining    = Math.min(limit, 500);

    while (remaining > 0) {
        const toFetch = Math.min(remaining, 100);
        let fetched;
        try {
            fetched = await channel.messages.fetch({ limit: toFetch });
        } catch (_) {
            break;
        }
        if (!fetched.size) break;

        const toDelete = checkFn
            ? fetched.filter(checkFn)
            : fetched;

        if (!toDelete.size) break;

        // discord.js bulkDelete يعمل فقط على رسائل أحدث من 14 يوم
        const recent = toDelete.filter(m =>
            Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000,
        );

        try {
            if (recent.size > 1) {
                const deleted = await channel.bulkDelete(recent, true);
                totalDeleted += deleted.size;
            } else if (recent.size === 1) {
                await recent.first().delete();
                totalDeleted += 1;
            }
        } catch (e) {
            if (e.status === 429 || (e.httpStatus === 429)) {
                const retryAfter = (e.retryAfter || 2) * 1000;
                await new Promise(r => setTimeout(r, retryAfter));
                // إعادة المحاولة
                try {
                    if (recent.size > 1) {
                        const deleted = await channel.bulkDelete(recent, true);
                        totalDeleted += deleted.size;
                    } else if (recent.size === 1) {
                        await recent.first().delete();
                        totalDeleted += 1;
                    }
                } catch (_) {}
            }
            break;
        }

        remaining -= toFetch;
        if (fetched.size < toFetch) break; // انتهت الرسائل
    }
    return totalDeleted;
}


function mapPermissionOverwrites(channel, targetGuild, roleMap = new Map()) {
    const overwrites = [];
    for (const [, ow] of channel.permissionOverwrites.cache) {
        let id = ow.id;
        if (ow.type === 0 || channel.guild.roles.cache.has(ow.id)) {
            if (ow.id === channel.guild.id) id = targetGuild.id;
            else id = roleMap.get(ow.id)?.id || ow.id;
        }
        overwrites.push({ id, allow: ow.allow.bitfield, deny: ow.deny.bitfield, type: ow.type });
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
//  EXECUTE ACTION — الأداة الرئيسية للتنفيذ
// ══════════════════════════════════════════════════════════════

/**
 * ينفّذ إجراءً على Discord
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').TextChannel} channel
 * @param {string} action
 * @param {object} params
 * @param {import('discord.js').Client} client
 * @returns {Promise<object>}
 */
async function executeAction(guild, channel, action, params, client) {
    try {
        // ── دعم target_guild ──
        if (params.target_guild) {
            const foundGuild = findGuild(client, String(params.target_guild));
            if (!foundGuild) return _err(`❌ ما لقيت سيرفر: **${params.target_guild}**`);
            guild = foundGuild;
            if (!params.channel) channel = null;
        }

        const a = action.toLowerCase().trim();

        // ────────────────────────────────
        //  قنوات
        // ────────────────────────────────
        if (a === 'create_category') {
            const cat = await guild.channels.create({ name: params.name, type: channelCreateType('category', client.__agentTokenType) });
            return _ok(`✅ تم إنشاء الكاتيكوري **${cat.name}** في **${guild.name}**`);
        }

        if (a === 'create_channel') {
            const catObj = params.category ? findCategory(guild, String(params.category)) : null;
            const type   = (params.type || 'text').toLowerCase();
            const chType = channelCreateType(type === 'voice' ? 'voice' : 'text', client.__agentTokenType);
            const ch     = await guild.channels.create({
                name  : params.name,
                type  : chType,
                parent: catObj || null,
            });
            const loc = catObj ? ` تحت **${catObj.name}**` : '';
            return _ok(`✅ تم إنشاء الروم **${ch.name}**${loc} في **${guild.name}**`);
        }

        if (a === 'delete_channel') {
            const ch = findChannel(guild, String(params.name));
            if (!ch) return _err(`❌ ما لقيت روم: **${params.name}**`);
            const name = ch.name;
            await ch.delete();
            return _ok(`✅ تم حذف الروم **${name}**`);
        }

        if (a === 'rename_channel') {
            const ch = findChannel(guild, String(params.channel));
            if (!ch) return _err(`❌ ما لقيت روم: **${params.channel}**`);
            const old = ch.name;
            await ch.edit({ name: params.new_name });
            return _ok(`✅ تم تغيير اسم **${old}** → **${params.new_name}**`);
        }

        // ── clear_channel (مُصلح) ──
        if (a === 'clear_channel') {
            let targetCh = null;
            if (params.channel) {
                const chQ  = String(params.channel);
                const found = findChannel(guild, chQ);
                if (found && isTextChannel(found)) {
                    targetCh = found;
                } else {
                    try {
                        const fetched = await client.channels.fetch(chQ);
                        if (fetched && isTextChannel(fetched)) targetCh = fetched;
                    } catch (_) {
                        return _err(`❌ ما لقيت قناة نصية: **${chQ}**`);
                    }
                }
            } else {
                targetCh = channel;
            }

            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة (channel).');
            }

            const limit = Number(params.limit || 100);
            let checkFn = null;

            if (params.before) {
                let beforeId;
                try {
                    beforeId = String(params.before).trim();
                } catch (_) {
                    return _err("❌ قيمة 'before' يجب أن تكون ID رقمي صحيح.");
                }
                checkFn = (msg) => msg.id < beforeId;
            }

            const deleted = await _safePurge(targetCh, Math.min(limit, 500), checkFn);
            return _ok(`✅ تم حذف **${deleted}** رسالة من **#${targetCh.name}**`);
        }

        // ── delete_member_messages (مُصلح) ──
        if (a === 'delete_member_messages') {
            const memberQ = String(params.member || '');
            let member    = await findMember(guild, memberQ, client);
            let memberId  = null;

            if (!member) {
                // محاولة fetch
                try {
                    member   = await guild.members.fetch(memberQ.trim());
                    memberId = member.id;
                } catch (_) {
                    // العضو ربما غادر — نستخدم ID مباشرة
                    memberId = memberQ.trim();
                    if (!memberId) return _err(`❌ ما لقيت العضو: **${memberQ}**`);
                }
            } else {
                memberId = member.id;
            }

            // جلب القناة الهدف
            let targetCh = null;
            if (params.channel) {
                const chQ  = String(params.channel);
                const found = findChannel(guild, chQ);
                if (found && isTextChannel(found)) {
                    targetCh = found;
                } else {
                    try {
                        const fetched = await client.channels.fetch(chQ);
                        if (fetched && isTextChannel(fetched)) targetCh = fetched;
                    } catch (_) {
                        return _err(`❌ ما لقيت قناة: **${chQ}**`);
                    }
                }
            } else {
                targetCh = channel;
            }

            if (!targetCh) return _err('❌ حدد القناة (channel) صراحة.');

            const limit   = Number(params.limit || 100);
            const checkFn = (msg) => msg.author.id === String(memberId);
            const deleted  = await _safePurge(targetCh, Math.min(limit, 500), checkFn);
            const displayName = member?.displayName || `ID:${memberId}`;
            return _ok(`✅ تم حذف **${deleted}** رسالة للعضو **${displayName}**`);
        }


        if (a === 'delete_member_messages_all_channels') {
            const memberQ = String(params.member || '').trim();
            if (!memberQ) return _err('❌ حدد العضو (member).');
            const member = await findMember(guild, memberQ, client).catch(() => null);
            const memberId = member?.id || memberQ;
            const perChannelLimit = Math.min(Number(params.limit_per_channel || 100), 500);
            let totalDeleted = 0;
            let scannedChannels = 0;
            const failures = [];
            for (const ch of guild.channels.cache.values()) {
                if (!isTextChannel(ch)) continue;
                scannedChannels++;
                try {
                    totalDeleted += await _safePurge(ch, perChannelLimit, msg => msg.author?.id === String(memberId));
                    await new Promise(r => setTimeout(r, 750));
                } catch (e) {
                    failures.push(`${ch.name}: ${e.message}`);
                }
            }
            return _ok(`✅ تم حذف **${totalDeleted}** رسالة للعضو من **${scannedChannels}** قناة ممكنة.`, { deleted: totalDeleted, channels: scannedChannels, failures: failures.slice(0, 5) });
        }

        // ────────────────────────────────
        //  رتب
        // ────────────────────────────────
        if (a === 'create_role') {
            let color;
            try {
                // discord.js v14 يقبل hex string مباشرة
                color = params.color ? parseInt(String(params.color).replace('#', ''), 16) : 0;
            } catch (_) {
                color = 0;
            }
            const role = await guild.roles.create({
                name       : params.name,
                color      : color,
                permissions: params.perms
                    ? new PermissionsBitField(Object.entries(params.perms).filter(([, v]) => v).map(([k]) => k))
                    : 0n,
            });
            if (params.position && Number(params.position) > 0) {
                try {
                    await guild.roles.setPosition(role, Number(params.position));
                } catch (_) {}
            }
            return _ok(`✅ تم إنشاء الرتبة **${role.name}** في **${guild.name}**`);
        }

        if (a === 'delete_role') {
            const role = findRole(guild, String(params.name));
            if (!role) return _err(`❌ ما لقيت رتبة: **${params.name}**`);
            const name = role.name;
            await role.delete();
            return _ok(`✅ تم حذف الرتبة **${name}**`);
        }

        if (a === 'edit_role') {
            const role = findRole(guild, String(params.name));
            if (!role) return _err(`❌ ما لقيت رتبة: **${params.name}**`);
            const kw = {};
            if (params.new_name) kw.name  = params.new_name;
            if (params.color)    kw.color = parseInt(String(params.color).replace('#', ''), 16);
            if (params.perms) {
                kw.permissions = new PermissionsBitField(
                    Object.entries(params.perms).filter(([, v]) => v).map(([k]) => k),
                );
            }
            await role.edit(kw);
            return _ok(`✅ تم تعديل الرتبة **${role.name}**`);
        }

        if (a === 'grant_role') {
            const member = await findMember(guild, String(params.member), client);
            const role   = findRole(guild, String(params.role));
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            if (!role)   return _err(`❌ ما لقيت الرتبة: **${params.role}**`);
            await member.roles.add(role);
            return _ok(`✅ أعطيت **${member.displayName}** رتبة **${role.name}**`);
        }

        if (a === 'revoke_role') {
            const member = await findMember(guild, String(params.member), client);
            const role   = findRole(guild, String(params.role));
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            if (!role)   return _err(`❌ ما لقيت الرتبة: **${params.role}**`);
            await member.roles.remove(role);
            return _ok(`✅ سحبت رتبة **${role.name}** من **${member.displayName}**`);
        }

        if (a === 'set_role_color') {
            const role = findRole(guild, String(params.role));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${params.role}**`);
            const colorInt = parseInt(String(params.color || '#99AAB5').replace('#', ''), 16);
            await role.edit({ color: colorInt });
            return _ok(`🎨 تم تغيير لون رتبة **${role.name}**`);
        }

        if (a === 'set_role_mentionable') {
            const role = findRole(guild, String(params.role));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${params.role}**`);
            const mentionable = Boolean(params.mentionable !== false);
            await role.edit({ mentionable });
            return _ok(`✅ رتبة **${role.name}** ${mentionable ? 'قابلة للمنشن' : 'غير قابلة للمنشن'}`);
        }

        if (a === 'remove_role_from_all') {
            const role = findRole(guild, String(params.role));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${params.role}**`);
            let count = 0;
            for (const mem of role.members.values()) {
                await mem.roles.remove(role, params.reason || 'Remove role from all');
                count++;
            }
            return _ok(`✅ تم سحب رتبة **${role.name}** من **${count}** عضو`);
        }

        if (a === 'add_role_to_bots') {
            const role = findRole(guild, String(params.role));
            if (!role) return _err(`❌ ما لقيت الرتبة: **${params.role}**`);
            let count = 0;
            for (const mem of guild.members.cache.values()) {
                if (mem.user.bot && !mem.roles.cache.has(role.id)) {
                    await mem.roles.add(role);
                    count++;
                }
            }
            return _ok(`🤖 تم إعطاء رتبة **${role.name}** إلى **${count}** بوت`);
        }

        // ────────────────────────────────
        //  أعضاء
        // ────────────────────────────────
        if (a === 'kick_member') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            const name = member.displayName;
            await member.kick(params.reason || '—');
            return _ok(`✅ تم كيك **${name}**`);
        }

        if (a === 'ban_member') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            const name = member.displayName;
            await member.ban({ reason: params.reason || '—', deleteMessageDays: 0 });
            return _ok(`✅ تم بان **${name}**`);
        }

        if (a === 'unban_member') {
            const user = await client.users.fetch(String(params.user));
            await guild.members.unban(user, params.reason || '—');
            return _ok(`✅ تم فك الحظر عن **${user.username}**`);
        }

        if (a === 'timeout_member') {
            const member  = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            const minutes = Math.max(1, Math.min(Number(params.minutes || 10), 40320));
            const until   = new Date(Date.now() + minutes * 60000);
            await member.timeout(until, params.reason || '—');
            return _ok(`⏳ تم تايم آوت **${member.displayName}** لمدة **${minutes}** دقيقة`);
        }

        if (a === 'remove_timeout') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            await member.timeout(null, params.reason || '—');
            return _ok(`✅ تم إزالة التايم آوت عن **${member.displayName}**`);
        }

        if (a === 'change_nickname') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            const old = member.displayName;
            await member.setNickname(params.nickname || null);
            return _ok(`✅ تم تغيير نكنيم **${old}** → **${params.nickname || '(مسح)'}**`);
        }

        if (a === 'move_member') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            const vc = findChannel(guild, String(params.channel));
            if (!vc || !isVoiceChannel(vc)) {
                return _err(`❌ ما لقيت فويس: **${params.channel}**`);
            }
            await member.voice.setChannel(vc);
            return _ok(`✅ تم نقل **${member.displayName}** إلى **${vc.name}**`);
        }

        if (a === 'voice_mute') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            const mute = Boolean(params.mute !== false);
            await member.voice.setMute(mute);
            return _ok(`🔇 تم ${mute ? 'كتم' : 'إلغاء كتم'} **${member.displayName}**`);
        }

        if (a === 'voice_deafen') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            const deafen = Boolean(params.deafen !== false);
            await member.voice.setDeaf(deafen);
            return _ok(`🔕 ${deafen ? 'إسكات السماع' : 'إلغاء إسكات'} **${member.displayName}**`);
        }

        if (a === 'disconnect_member') {
            const member = await findMember(guild, String(params.member), client);
            if (!member) return _err(`❌ ما لقيت العضو: **${params.member}**`);
            await member.voice.disconnect();
            return _ok(`📤 تم فصل **${member.displayName}** من الفويس`);
        }

        // ────────────────────────────────
        //  رسائل ومنشن
        // ────────────────────────────────
        if (a === 'send_message') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة (channel).');
            }
            const content = String(params.content || '').trim();
            if (!content) return _err('❌ محتوى الرسالة فارغ.');
            let sent;
            if (params.reply_to) {
                const replyId = String(params.reply_to);
                let ref = await targetCh.messages.fetch(replyId).catch(() => null);
                if (!ref && params.reply_channel) {
                    const replyCh = findChannel(guild, String(params.reply_channel)) || await client.channels.fetch(String(params.reply_channel)).catch(() => null);
                    if (replyCh && isTextChannel(replyCh)) {
                        targetCh = replyCh;
                        ref = await replyCh.messages.fetch(replyId).catch(() => null);
                    }
                }
                if (!ref) {
                    for (const g of client.guilds.cache.values()) {
                        for (const ch of g.channels.cache.values()) {
                            if (!isTextChannel(ch)) continue;
                            ref = await ch.messages.fetch(replyId).catch(() => null);
                            if (ref) { targetCh = ch; break; }
                        }
                        if (ref) break;
                    }
                }
                if (!ref) return _err('❌ لم أجد رسالة reply_to. تأكد من ID الرسالة وأن الحساب يرى القناة.');
                sent = await ref.reply(content.slice(0, 2000));
            } else {
                sent = await targetCh.send(content.slice(0, 2000));
            }
            return _ok(`✅ تم إرسال الرسالة في **#${targetCh.name}** (${guild.name})`, { message_id: sent.id, replied_to: params.reply_to || null });
        }

        if (a === 'mention_everyone') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة.');
            }
            const extra = String(params.content || '').trim();
            const text  = extra ? `@everyone ${extra}` : '@everyone';
            const { AllowedMentionTypes } = require('discord.js');
            const sent = await targetCh.send({
                content         : text.slice(0, 2000),
                allowedMentions : { parse: ['everyone'] },
            });
            return _ok(`✅ تم إرسال منشن @everyone في **#${targetCh.name}**`, { message_id: sent.id });
        }


        if (a === 'react_message') {
            let targetCh = params.channel ? findChannel(guild, String(params.channel)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            const msg = await targetCh.messages.fetch(String(params.message_id || '')).catch(() => null);
            if (!msg) return _err('❌ لم أجد الرسالة.');
            await msg.react(String(params.emoji || '✅'));
            return _ok(`✅ تم وضع التفاعل على الرسالة في #${targetCh.name}`);
        }

        if (a === 'edit_own_message') {
            let targetCh = params.channel ? findChannel(guild, String(params.channel)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            const msg = await targetCh.messages.fetch(String(params.message_id || '')).catch(() => null);
            if (!msg) return _err('❌ لم أجد الرسالة.');
            if (msg.author.id !== client.user.id) return _err('❌ لا أستطيع تعديل رسالة ليست لي.');
            await msg.edit(String(params.content || '').slice(0, 2000));
            return _ok(`✅ تم تعديل رسالتي في #${targetCh.name}`);
        }

        if (a === 'delete_message') {
            let targetCh = params.channel ? findChannel(guild, String(params.channel)) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة نصية صحيحة.');
            const msg = await targetCh.messages.fetch(String(params.message_id || '')).catch(() => null);
            if (!msg) return _err('❌ لم أجد الرسالة.');
            await msg.delete();
            return _ok(`🗑️ تم حذف الرسالة من #${targetCh.name}`);
        }

        if (a === 'forward_message') {
            const fromCh = params.from_channel ? findChannel(guild, String(params.from_channel)) : channel;
            const toCh = params.to_channel ? findChannel(guild, String(params.to_channel)) : channel;
            if (!fromCh || !toCh || !isTextChannel(fromCh) || !isTextChannel(toCh)) return _err('❌ حدد قنوات نصية صحيحة.');
            const msg = await fromCh.messages.fetch(String(params.message_id || '')).catch(() => null);
            if (!msg) return _err('❌ لم أجد الرسالة الأصلية.');
            const sent = await msg.forward(toCh).catch(async () => toCh.send({ content: `Forwarded from ${msg.url}\n${String(msg.content || '').slice(0, 1800)}` }));
            return _ok(`📨 تم تحويل الرسالة إلى #${toCh.name}`, { message_id: sent?.id || null });
        }

        if (a === 'send_dm') {
            const userId = String(params.user || params.member || '').trim();
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) return _err('❌ لم أجد المستخدم لإرسال الخاص.');
            const sent = await user.send(String(params.content || '').slice(0, 2000));
            return _ok(`📩 تم إرسال رسالة خاصة إلى ${user.username}`, { message_id: sent.id });
        }

        if (a === 'pin_message') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة.');
            }
            const msg = await targetCh.messages.fetch(String(params.message_id));
            await msg.pin();
            return _ok(`📌 تم تثبيت الرسالة في **#${targetCh.name}**`);
        }

        if (a === 'unpin_message') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة.');
            }
            const msg = await targetCh.messages.fetch(String(params.message_id));
            await msg.unpin();
            return _ok(`📌 تم إلغاء تثبيت الرسالة من **#${targetCh.name}**`);
        }

        // ────────────────────────────────
        //  صلاحيات القنوات (مُصلح)
        // ────────────────────────────────
        if (a === 'set_channel_permissions') {
            const chObj = findChannel(guild, String(params.channel || ''));
            if (!chObj) return _err(`❌ ما لقيت القناة: **${params.channel}**`);

            let target = null;
            if (params.role) {
                target = findRole(guild, String(params.role));
                if (!target) return _err(`❌ ما لقيت الرتبة: **${params.role}**`);
            } else if (params.member) {
                target = await findMember(guild, String(params.member), client);
                if (!target) {
                    try {
                        target = await guild.members.fetch(String(params.member).trim());
                    } catch (_) {
                        return _err(`❌ ما لقيت العضو: **${params.member}**`);
                    }
                }
            } else {
                return _err('❌ حدد role أو member لتعديل صلاحيات القناة.');
            }

            const permMap = params.perms || {};
            if (typeof permMap !== 'object') {
                return _err('❌ يجب أن تكون perms عبارة عن كائن JSON {permission: true/false/null}.');
            }

            // بناء الـ overwrites: true=سماح، false=منع، null=إزالة
            const owKwargs = {};
            for (const [key, val] of Object.entries(permMap)) {
                owKwargs[key] = val === null ? null : Boolean(val);
            }

            await chObj.permissionOverwrites.edit(target, owKwargs);
            const targetName = target.displayName || target.name || String(target.id);
            return _ok(`✅ تم تعديل صلاحيات **${targetName}** في **#${chObj.name}**`);
        }

        // ────────────────────────────────
        //  ثريد وإعلانات وقنوات متفرقة
        // ────────────────────────────────
        if (a === 'create_thread') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة لإنشاء الثريد.');
            }
            const thread = await targetCh.threads.create({
                name                : params.name,
                autoArchiveDuration : Number(params.auto_archive_duration || 1440),
                type                : channelCreateType('thread', client.__agentTokenType),
            });
            return _ok(`✅ تم إنشاء الثريد **${thread.name}** في **#${targetCh.name}**`, { thread_id: thread.id });
        }

        if (a === 'slowmode') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة للسلو مود.');
            }
            const seconds = Number(params.seconds || 0);
            await targetCh.setRateLimitPerUser(seconds);
            if (seconds === 0) return _ok(`✅ تم إيقاف السلو مود في **#${targetCh.name}**`);
            return _ok(`✅ سلو مود **${seconds}** ثانية في **#${targetCh.name}**`);
        }

        if (a === 'lock_channel') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة لقفلها.');
            }
            await targetCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
            return _ok(`🔒 تم قفل الكتابة في **#${targetCh.name}**`);
        }

        if (a === 'unlock_channel') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة لفتحها.');
            }
            await targetCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
            return _ok(`🔓 تم فتح الكتابة في **#${targetCh.name}**`);
        }

        if (a === 'set_channel_topic') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة.');
            }
            await targetCh.setTopic(String(params.topic || '').slice(0, 1024));
            return _ok(`✅ تم تعديل وصف **#${targetCh.name}**`);
        }

        if (a === 'create_invite') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && (isTextChannel(found) || isVoiceChannel(found))) {
                    targetCh = found;
                }
            }
            if (!targetCh) return _err('❌ حدد قناة صحيحة لإنشاء الدعوة.');
            const invite = await targetCh.createInvite({
                maxAge : Number(params.max_age || 86400),
                maxUses: Number(params.max_uses || 0),
                unique : true,
            });
            return _ok(`✅ تم إنشاء دعوة للقناة **${targetCh.name}**: ${invite.url}`, { url: invite.url });
        }

        if (a === 'archive_channel') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة لأرشفتها.');
            }
            await targetCh.setName(`archived-${targetCh.name}`.slice(0, 100));
            await targetCh.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
            return _ok(`🗄️ تم أرشفة **#${targetCh.name}**`);
        }

        if (a === 'nuke_channel') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة لإعادة إنشائها.');
            }
            const oldName = targetCh.name;
            const newCh   = await targetCh.clone();
            await newCh.setPosition(targetCh.position);
            await targetCh.delete();
            return _ok(`💥 تم تنظيف قناة **#${oldName}** بإعادة إنشائها`, { channel_id: newCh.id });
        }

        if (a === 'create_announcement') {
            const name = params.name || 'announcements';
            const ch   = await guild.channels.create({ name, type: channelCreateType('text', client.__agentTokenType) });
            await ch.setTopic(params.topic || 'قناة إعلانات السيرفر');
            return _ok(`📢 تم إنشاء قناة إعلانات **#${ch.name}**`, { channel_id: ch.id });
        }


        if (a === 'start_events') {
            const targetCh = params.channel ? (findChannel(guild, String(params.channel)) || channel) : channel;
            if (!targetCh || !isTextChannel(targetCh)) return _err('❌ حدد قناة فعاليات نصية صحيحة.');
            const { runEventSeries } = require('../accountAgent');
            const result = await runEventSeries(client, guild, targetCh, { agentId: client.__agentId || 'default' }, {
                gameName: params.game || params.game_name || null,
                count: Number(params.count || 1),
                minutes: Number(params.minutes || 0),
                first: true,
            });
            return _ok(`🎮 ${result.msg}`, { games: result.results.map(g => ({ name: g.name, command: g.command })) });
        }

        // ────────────────────────────────
        //  clone_server
        // ────────────────────────────────
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
            if (sourceGuild.id === target.id) {
                return _err('❌ المصدر والهدف لا يمكن أن يكونا نفس السيرفر.');
            }

            let createdRoles = 0, createdCategories = 0, createdChannels = 0;
            const errors     = [];
            const roleMap    = new Map();
            const catMap     = new Map();

            // نسخ الرتب
            const sortedRoles = [...sourceGuild.roles.cache.values()]
                .filter(r => r.name !== '@everyone')
                .sort((a, b) => b.position - a.position);
            for (const r of sortedRoles) {
                try {
                    const newRole = await target.roles.create({
                        name       : r.name,
                        color      : r.color,
                        permissions: r.permissions,
                        hoist      : r.hoist,
                        mentionable: r.mentionable,
                        reason     : `Clone role from ${sourceGuild.name}`,
                    });
                    await newRole.setPosition(Math.min(r.position, target.roles.cache.size - 1)).catch(() => {});
                    roleMap.set(r.id, newRole);
                    createdRoles++;
                } catch (e) {
                    errors.push(`رتبة ${r.name}: ${e.message}`);
                }
            }

            // نسخ الكاتيجوريات
            const sortedCats = [...sourceGuild.channels.cache.values()]
                .filter(c => isCategoryChannel(c))
                .sort((a, b) => a.position - b.position);
            for (const cat of sortedCats) {
                try {
                    const newCat = await target.channels.create({ name: cat.name, type: channelTypeForClone(cat, client), permissionOverwrites: mapPermissionOverwrites(cat, target, roleMap), position: cat.position });
                    catMap.set(cat.id, newCat);
                    createdCategories++;
                } catch (e) {
                    errors.push(`كاتيكوري ${cat.name}: ${e.message}`);
                }
            }

            // نسخ القنوات
            const sortedChannels = [...sourceGuild.channels.cache.values()]
                .filter(c => !isCategoryChannel(c))
                .sort((a, b) => a.position - b.position);
            for (const ch of sortedChannels) {
                try {
                    const targetCat = ch.parentId ? catMap.get(ch.parentId) || null : null;
                    if (isTextChannel(ch)) {
                        await target.channels.create({
                            name           : ch.name,
                            type           : channelTypeForClone(ch, client),
                            parent         : targetCat,
                            topic          : ch.topic || null,
                            nsfw           : ch.nsfw,
                            rateLimitPerUser: ch.rateLimitPerUser,
                            permissionOverwrites: mapPermissionOverwrites(ch, target, roleMap),
                            position       : ch.position,
                        });
                    } else if (isVoiceChannel(ch)) {
                        await target.channels.create({
                            name     : ch.name,
                            type     : channelTypeForClone(ch, client),
                            parent   : targetCat,
                            bitrate  : Math.min(ch.bitrate || 64000, target.maximumBitrate || 96000),
                            userLimit: ch.userLimit,
                            permissionOverwrites: mapPermissionOverwrites(ch, target, roleMap),
                            position : ch.position,
                        });
                    }
                    createdChannels++;
                } catch (e) {
                    errors.push(`روم ${ch.name}: ${e.message}`);
                }
            }

            let summary = (
                `✅ تم استنساخ **${sourceGuild.name}** → **${target.name}**\n` +
                `الرتب: ${createdRoles} | الكاتيكوريات: ${createdCategories} | الرومات: ${createdChannels} | الصلاحيات والترتيب: مفعلة`
            );
            if (errors.length) {
                summary += `\n⚠️ بعض العناصر فشلت (${errors.length}): ` + errors.slice(0, 5).join('، ');
            }
            return { ok: !errors.length || createdChannels > 0, msg: summary };
        }

        // ────────────────────────────────
        //  أدوات Webhook، DM، Poll
        // ────────────────────────────────
        if (a === 'create_webhook') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة لإنشاء الويبهوك.');
            }
            const wh = await targetCh.createWebhook({ name: params.name || 'Disor Webhook' });
            return _ok(`🔗 تم إنشاء ويبهوك **${wh.name}** في **#${targetCh.name}**`, { url: wh.url, id: wh.id });
        }

        if (a === 'send_webhook_message') {
            const whUrl   = String(params.webhook_url || '');
            const content = String(params.content || '').trim();
            const whName  = String(params.username || 'Webhook');
            if (!whUrl)   return _err('❌ يجب تحديد webhook_url.');
            if (!content) return _err('❌ محتوى الرسالة فارغ.');
            const resp = await axios.post(
                whUrl,
                { content: content.slice(0, 2000), username: whName },
                { timeout: 10000 },
            );
            if ([200, 204].includes(resp.status)) {
                return _ok(`✅ تم إرسال الرسالة عبر الويبهوك باسم **${whName}**`);
            }
            return _err(`❌ فشل إرسال الويبهوك: ${resp.status}`);
        }

        if (a === 'mass_dm') {
            const content     = String(params.content || '').trim();
            const roleFilter  = params.role;
            if (!content) return _err('❌ محتوى الرسالة فارغ.');
            let members       = [...guild.members.cache.values()];
            if (roleFilter) {
                const roleObj = findRole(guild, String(roleFilter));
                if (!roleObj) return _err(`❌ ما لقيت الرتبة: **${roleFilter}**`);
                members = [...roleObj.members.values()];
            }
            let sentCount = 0, failedCount = 0;
            const limit   = Math.min(Number(params.limit || 50), members.length);
            for (const mem of members.slice(0, limit)) {
                if (mem.user.bot) continue;
                try {
                    await mem.send(content.slice(0, 2000));
                    sentCount++;
                    await new Promise(r => setTimeout(r, 1000)); // تفادي rate limit
                } catch (_) {
                    failedCount++;
                }
            }
            return _ok(`📨 تم إرسال DM إلى **${sentCount}** عضو (${failedCount} فشل)`);
        }

        if (a === 'poll') {
            let targetCh = channel;
            if (params.channel) {
                const found = findChannel(guild, String(params.channel));
                if (found && isTextChannel(found)) targetCh = found;
            }
            if (!targetCh || !isTextChannel(targetCh)) {
                return _err('❌ حدد قناة نصية صحيحة للتصويت.');
            }
            const question = String(params.question || 'تصويت').trim();
            const options  = Array.isArray(params.options) ? params.options : ['✅ نعم', '❌ لا'];
            if (options.length < 2) return _err('❌ يجب توفير قائمة خيارات (options) بعنصرين على الأقل.');

            const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
            const lines        = [`📊 **${question}**\n`];
            for (let i = 0; i < Math.min(options.length, 10); i++) {
                lines.push(`${numberEmojis[i]} ${options[i]}`);
            }
            const pollMsg = await targetCh.send(lines.join('\n'));
            for (let i = 0; i < Math.min(options.length, 10); i++) {
                await pollMsg.react(numberEmojis[i]);
            }
            return _ok(`✅ تم إنشاء التصويت في **#${targetCh.name}**`, { message_id: pollMsg.id });
        }

        return _err(`⚠️ عملية غير معروفة: **${action}**`);

    } catch (e) {
        if (e.code === 50013) {
            return _err(`⛔ البوت لا يملك الصلاحية لتنفيذ **${action}**. تحقق من رتبته وصلاحياته.`);
        }
        if (e.status === 429 || e.httpStatus === 429) {
            return _err(`⏳ تجاوز حد المعدل (Rate Limit) أثناء **${action}**. حاول مرة أخرى.`);
        }
        console.error(`[executeAction error] ${action}:`, e);
        return _err(`❌ خطأ غير متوقع في **${action}**: ${String(e.message || e).slice(0, 200)}`);
    }
}

// ══════════════════════════════════════════════════════════════
//  Exports
// ══════════════════════════════════════════════════════════════
module.exports = {
    _safePurge,
    executeAction,
};