/**
 * bot.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * الملف الرئيسي: إنشاء Client، أحداث ready/messageCreate،
 * أوامر Slash، وبدء التشغيل
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// ══════════════════════════════════════════════════════════════
//  استيراد المكتبات والوحدات
// ══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    Partials,
    SlashCommandBuilder,
    REST,
    Routes,
    ChannelType,
    InteractionType,
    ApplicationCommandOptionType,
    ApplicationCommandType,
} = require('discord.js');
const axios = require('axios');

// استيراد ملفات المشروع
const {
    USER_TOKEN,
    BOT_OWNER_ID,
    MAX_CHANNELS_PER_GUILD,
    MAX_ATTACHMENT_BYTES,
    TEXT_EXTENSIONS,
    TEXT_CONTENT_TYPES,
    connectMongo,
    channel_sessions,
    allowed_channels_cache,
    sessionLock,
    db, // not used directly but needed for initial connect
} = require('./config');

const {
    _err,
    _ok,
    is_text_attachment,
    fetchTextAttachment,
    get_allowed_channels,
    add_allowed_channel,
    remove_allowed_channel,
    db_load_channel_session,
    db_save_channel_session,
    db_reset_channel_session,
    get_control_role,
    set_control_role,
    get_pow_provider,
    set_pow_provider,
    findChannel,
    findCategory,
    findRole,
    findMember,
    findGuild,
    getAccessLevel,
    isBotOwner,
    looks_like_internal_prompt_request,
    buildBotContext,
} = require('./utils');

const {
    runAgent,
} = require('./tools');

const {
    createDiscordClient,
    normalizeTokenType,
    isTextChannel,
} = require('./discordAdapter');

const { dashboardCommands, isDashboardCommand } = require('./managerDashboard');

// ══════════════════════════════════════════════════════════════
//  إنشاء Client
// ══════════════════════════════════════════════════════════════
async function startAgentRuntime(agentConfig) {
const agentId = String(agentConfig._id || agentConfig.id || 'default');
const agentName = agentConfig.name || agentId;
const tokenType = normalizeTokenType(agentConfig.token_type || agentConfig.tokenType || 'bot');
const discordToken = agentConfig.discord_token || agentConfig.discordToken || USER_TOKEN;
const deepseekToken = agentConfig.deepseek_token || agentConfig.deepseekToken;
if (!deepseekToken) throw new Error('deepseek_token مفقود لهذا الوكيل');
const personality = agentConfig.personality || '';
const channel_sessions = new Map();
const allowed_channels_cache = new Map();
const sessionLock = new (require('./config').SimpleLock)();
let intentionalStop = false;
const client = createDiscordClient(tokenType);
client.__agentTokenType = tokenType;
client.__agentId = agentId;

// ══════════════════════════════════════════════════════════════
//  حدث READY
// ══════════════════════════════════════════════════════════════
client.once('ready', async () => {

    const botName = client.user.displayName || client.user.username;
    console.log(`✅ ${botName} (${client.user.id}) ready`);
    console.log(`📡 Guilds (${client.guilds.cache.size}): ${client.guilds.cache.map(g => g.name).join(', ')}`);

    if (agentConfig.onReady) await agentConfig.onReady();

    // تسجيل أوامر السلاش للبوتات فقط؛ حسابات user لا تدعم application commands
    if (tokenType !== 'bot') return;

    try {
        // Bot Agent يسجل نقطة دخول Dashboard كواجهة فقط؛ التنفيذ الحقيقي يبقى في Manager Runtime.
        const commands = dashboardCommands();

        const rest = new REST({ version: '10' }).setToken(discordToken);

        console.log('⏳ جاري تسجيل واجهة Dashboard للوكيل...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands.map(cmd => cmd.toJSON()) },
        );
        console.log('✅ Agent dashboard UI synced');
    } catch (err) {
        console.error('❌ فشل تسجيل أوامر السلاش:', err);
    }
});

// ══════════════════════════════════════════════════════════════
//  حدث INTERACTION (للأوامر + Autocomplete)
// ══════════════════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
    // ── Autocomplete ──
    if (interaction.isAutocomplete()) {
        if (!interaction.guild) return;
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'قناة') {
            const guild = interaction.guild;
            const current = focused.value.toLowerCase();
            const choices = guild.channels.cache
                .filter(ch => isTextChannel(ch) && ch.name.toLowerCase().includes(current))
                .first(25)
                .map(ch => ({ name: `#${ch.name}`, value: ch.id }));
            await interaction.respond(choices);
        }
        return;
    }

    // ── Dashboard UI delegation ──
    // Agent Runtime لا ينفذ أي إدارة محليًا. Bot Agent مجرد واجهة ترسل الطلب إلى Manager.
    if ((interaction.isChatInputCommand() && isDashboardCommand(interaction.commandName))
        || (interaction.customId && interaction.customId.startsWith('dash:'))
        || (interaction.isModalSubmit && interaction.isModalSubmit() && interaction.customId && interaction.customId.startsWith('dash:'))) {
        if (typeof agentConfig.handleManagementInteraction === 'function') {
            await agentConfig.handleManagementInteraction(interaction);
        } else if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '⚠️ Manager Runtime غير متاح لمعالجة لوحة التحكم.' });
        }
        return;
    }

    // لا توجد أوامر إدارة محلية داخل Agent Runtime.
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const guild = interaction.guild;
    const member = interaction.member;

    try {

        // أوامر إدارة الوكلاء نُقلت بالكامل إلى Manager Dashboard.

        if (commandName === 'اوامر') {
            const botName = client.user.displayName || client.user.username;
            const helpText = `# أوامر ${botName}\n\n` +
                `## 💬 التفاعل\nمنشن البوت أو رد على رسالته للتحدث معه\n\n` +
                `## 📡 إدارة قنوات المحادثة (أدمن فقط)\n` +
                `**/قناة-محادثة** — أضف قناة للبوت (حد أقصى ${MAX_CHANNELS_PER_GUILD} قنوات)\n` +
                `**/قنوات-مسموحة** — عرض القنوات النشطة\n` +
                `**/حذف-قناة** — احذف قناة من القائمة\n` +
                `**/محادثة-جديدة** — أعد تعيين محادثة قناة (اختر نوع الموديل والتفكير)\n\n` +
                `## ⚙️ إعدادات (أدمن فقط)\n` +
                `**/رتبة-التحكم** — حدد رتبة الإدارة\n` +
                `**/الرتبة-الحالية** — عرض رتبة التحكم\n` +
                `**/مزود-باو** — تبديل مزود POW\n\n` +
                `## 🧠 قدرات البوت\n` +
                `**قراءة:** قنوات، رتب، أعضاء، رسائل، تدقيق، دعوات، بانات، إيموجيات، ملصقات، ثريدات، ويبهوكس، فعاليات، نيترو بوسترز، قائمة البوتات، معلومات عضو تفصيلية، فويس\n` +
                `**إدارة:** إنشاء/حذف/تعديل قنوات ورتب، منح/سحب رتب، كيك/بان/فك بان، تايم آوت، تغيير نكنيم، صلاحيات قنوات **لعضو بعينه بدون رتبة** ✨، سلو مود، قفل/فتح قناة، ثريد، ويبهوك، تصويت (poll)، استنساخ سيرفر\n\n` +
                `> **جديد:** صلاحيات القنوات تدعم الآن إضافة أعضاء بشكل مباشر بدون رتبة`;
            await interaction.reply({ content: helpText });
        }

        else if (commandName === 'قناة-محادثة') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.' });
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            let ch = guild.channels.cache.get(chanValue);
            if (!ch || ch.type !== ChannelType.GuildText) {
                ch = guild.channels.cache.find(c => c.name.toLowerCase() === chanValue.toLowerCase() && isTextChannel(c));
            }
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.' });
                return;
            }
            const added = await add_allowed_channel(guild.id, ch.id, agentId, allowed_channels_cache);
            if (!added) {
                await interaction.reply({
                    content: `⛔ وصلت للحد الأقصى (${MAX_CHANNELS_PER_GUILD} قنوات). احذف قناة أولاً بـ /حذف-قناة.`,
                });
                return;
            }
            await interaction.reply({
                content: `✅ تم إضافة **#${ch.name}** للقنوات النشطة.\nالبوت سيستجيب الآن في هذه القناة.`,
            });
        }

        else if (commandName === 'قنوات-مسموحة') {
            const ids = await get_allowed_channels(guild.id, agentId, allowed_channels_cache);
            if (!ids.length) {
                await interaction.reply({
                    content: `📭 لا توجد قنوات مضافة بعد. استخدم **/قناة-محادثة** لإضافة قنوات (حد أقصى ${MAX_CHANNELS_PER_GUILD}).`,
                });
                return;
            }
            const lines = [`# القنوات النشطة (${ids.length}/${MAX_CHANNELS_PER_GUILD})\n`];
            for (const cid of ids) {
                const ch = guild.channels.cache.get(cid);
                lines.push(`- ${ch ? '#' + ch.name : '~~محذوفة~~'} (\`${cid}\`)`);
            }
            await interaction.reply({ content: lines.join('\n') });
        }

        else if (commandName === 'حذف-قناة') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.' });
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            let ch = guild.channels.cache.get(chanValue);
            if (!ch || ch.type !== ChannelType.GuildText) {
                ch = guild.channels.cache.find(c => c.name.toLowerCase() === chanValue.toLowerCase() && isTextChannel(c));
            }
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.' });
                return;
            }
            const ids = await get_allowed_channels(guild.id, agentId, allowed_channels_cache);
            if (!ids.includes(ch.id)) {
                await interaction.reply({ content: `❌ **#${ch.name}** غير موجودة في القائمة.` });
                return;
            }
            await remove_allowed_channel(guild.id, ch.id, agentId, allowed_channels_cache);
            await interaction.reply({ content: `✅ تم حذف **#${ch.name}** من قنوات البوت.` });
        }

        else if (commandName === 'محادثة-جديدة') {
            const guildId = guild.id;
            const targetChanId = interaction.options.getString('قناة') || interaction.channelId;
            // التحقق من وجود القناة
            const chObj = guild.channels.cache.get(targetChanId);
            if (!chObj) {
                await interaction.reply({ content: '❌ القناة غير موجودة.' });
                return;
            }

            const mode = interaction.options.getString('وضع') || 'default';
            const thinking = (interaction.options.getString('تفكير') || 'off') === 'on';

            // إعادة تعيين جلسة القناة في RAM و DB
            const key = `${guildId}_${targetChanId}`;
            await sessionLock.acquire(() => {
                channel_sessions.set(key, {
                    session_id: null,
                    parent_message_id: null,
                    mode: mode,
                    thinking: thinking,
                });
            });
            await db_reset_channel_session(guildId, targetChanId, agentId);

            const chName = chObj.name || `ID:${targetChanId}`;
            const modeLabel = mode === 'expert' ? '🧠 خبير' : '🗨️ عادي';
            const thinkLbl = thinking ? '🔍 مفعّل' : '⚡ غير مفعّل';
            await interaction.reply({
                content: `✅ **تم إعادة تعيين محادثة #${chName}**\nالموديل: **${modeLabel}** | التفكير: **${thinkLbl}**`,
            });
        }

        else if (commandName === 'رتبة-التحكم') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.' });
                return;
            }
            const roleName = interaction.options.getString('role') || '';
            await set_control_role(guild.id, roleName, agentId);
            if (roleName) {
                await interaction.reply({ content: `✅ رتبة التحكم: **${roleName}**` });
            } else {
                await interaction.reply({ content: '✅ تم إزالة قيد الرتبة — الكل يقدر يستخدم البوت.' });
            }
        }

        else if (commandName === 'الرتبة-الحالية') {
            const role = await get_control_role(guild.id, agentId);
            if (role) {
                await interaction.reply({ content: `🔒 رتبة التحكم: **${role}**` });
            } else {
                await interaction.reply({ content: '🔓 لا يوجد قيد — الكل يقدر يستخدم البوت.' });
            }
        }

        else if (commandName === 'مزود-باو') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.' });
                return;
            }
            const provider = interaction.options.getString('provider', true);
            await set_pow_provider(guild.id, provider, agentId);
            await interaction.reply({ content: `✅ تم تبديل مزود POW إلى **${provider}**` });
        }

    } catch (error) {
        console.error(`[Slash Error] ${commandName}:`, error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '⚠️ حدث خطأ أثناء معالجة الأمر.' });
            } else {
                await interaction.followUp({ content: '⚠️ حدث خطأ.' });
            }
        } catch (_) {}
    }
});

// ══════════════════════════════════════════════════════════════
//  حدث MESSAGE — الرد على الرسائل
// ══════════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
    // تجاهل رسائل البوت
    if (message.author.id === client.user.id) return;
    // تجاهل الرسائل خارج السيرفر
    if (!message.guild) return;

    // التحقق من أن القناة ضمن المسموحات
    const allowedIds = await get_allowed_channels(message.guild.id, agentId, allowed_channels_cache);
    if (!allowedIds.length) return;
    if (!allowedIds.includes(message.channel.id)) return;

    // التحقق من منشن البوت أو الرد على رسالته
    const isMention = message.mentions.has(client.user.id) && !message.mentions.everyone;
    const isReplyToBot = message.reference
        && message.reference.messageId
        && (await message.fetchReference().catch(() => null))?.author?.id === client.user.id;

    if (!isMention && !isReplyToBot) return;

    // استخراج النص وإزالة منشن البوت
    let content = message.content;
    content = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

    // إضافة معلومات المنشنات الأخرى
    const otherMentions = message.mentions.users.filter(u => u.id !== client.user.id);
    if (otherMentions.size > 0) {
        const lines = ['\n[أعضاء تم منشنتهم في هذي الرسالة]'];
        for (const [id, user] of otherMentions) {
            const mem = message.guild.members.cache.get(id);
            const disp = mem ? mem.displayName : user.displayName;
            lines.push(`  - <@${id}> ← الاسم: ${disp} | اليوزرنيم: @${user.username} | الـ ID: ${id}`);
        }
        content += '\n' + lines.join('\n');
    }

    // معالجة المرفقات
    if (message.attachments.size > 0) {
        for (const [, att] of message.attachments) {
            if (is_text_attachment(att)) {
                try {
                    const text = await fetchTextAttachment(att.url);
                    const ext = path.extname(att.name).replace('.', '') || '';
                    content += `\n[ملف: ${att.name}]\n\`\`\`${ext}\n${text}\n\`\`\``;
                } catch (e) {
                    content += `\n[ملف: ${att.name}] (خطأ: ${e.message})`;
                }
            } else {
                content += `\n[ملف غير نصي: ${att.name}]`;
            }
        }
    }

    if (!content.trim()) {
        await message.reply('وين أساعدك؟ 😄');
        return;
    }

    // حماية التعليمات الداخلية
    if (looks_like_internal_prompt_request(content)) {
        await message.reply('⛔ لا أستطيع عرض التعليمات الداخلية.');
        return;
    }

    // إضافة تفاعل 👀
    try {
        await message.react('👀');
    } catch (_) {}

    // تحديد مستوى صلاحية المرسل
    const accessLevel = getAccessLevel(message.member);

    // بناء معلومات المستخدم
    const author = message.author;
    const member = message.member;
    const nick = member?.nickname || null;
    const displayName = nick || author.globalName || author.username;
    const userInfo = (
        `[معلومات المستخدم]\n` +
        `  النكنيم في السيرفر : ${nick || '—'}\n` +
        `  الاسم العالمي      : ${author.globalName || '—'}\n` +
        `  اليوزرنيم          : @${author.username}\n` +
        `  الـ ID             : ${author.id}\n` +
        `  ناديه بـ           : ${displayName}\n` +
        `  كتب في             : #${message.channel.name}\n`
    );

    // بناء سياق البوت
    const botContext = await buildBotContext(client, message.guild, message.channel, agentId, allowed_channels_cache);

    // جلسة القناة (per-channel)
    const chKey = `${message.guild.id}_${message.channel.id}`;
    let cs;
    await sessionLock.acquire(async () => {
        if (!channel_sessions.has(chKey)) {
            const loaded = await db_load_channel_session(message.guild.id, message.channel.id, agentId);
            if (loaded) {
                channel_sessions.set(chKey, loaded);
            } else {
                channel_sessions.set(chKey, {
                    session_id: null,
                    parent_message_id: null,
                    mode: 'default',
                    thinking: false,
                });
            }
        }
        cs = channel_sessions.get(chKey);
    });

    const botName = client.user.displayName || client.user.username;
    const mode = cs.mode || 'default';
    const thinking = cs.thinking || false;

    try {
        await message.react('⏳');
        await message.reactions.cache.get('👀')?.users.remove(client.user.id).catch(() => {});
    } catch (_) {}

    try {
        const result = await runAgent(
            message.guild,
            message.channel,
            content,
            userInfo,
            botContext,
            botName,
            cs.session_id,
            cs.parent_message_id,
            message.guild.id,
            mode,
            thinking,
            accessLevel,
            client,
            { deepseekToken, personality, agentId },
        );

        // تحديث الجلسة في RAM و DB
        await sessionLock.acquire(() => {
            const current = channel_sessions.get(chKey) || {};
            current.session_id = result.newSid;
            current.parent_message_id = result.newPmid;
            channel_sessions.set(chKey, current);
        });
        if (result.newSid) {
            await db_save_channel_session(
                message.guild.id,
                message.channel.id,
                result.newSid,
                result.newPmid,
                mode,
                thinking,
                agentId,
            );
        }

        const replyText = result.reply || '✅ تم.';
        const chunks = [];
        for (let i = 0; i < replyText.length; i += 1990) {
            chunks.push(replyText.slice(i, i + 1990));
        }

        const files = (result.filesToSend || []).map(fp => ({ attachment: fp, name: path.basename(fp) }));

        if (chunks.length > 0) {
            // إرسال الجزء الأول مع الملفات إن وجدت
            const firstMsgOpts = { content: chunks[0] };
            if (files.length > 0) firstMsgOpts.files = files;
            await message.reply(firstMsgOpts);

            // باقي الأجزاء
            for (let i = 1; i < chunks.length; i++) {
                await message.channel.send(chunks[i]);
            }
        } else if (files.length > 0) {
            await message.reply({ files });
        }

        // تنظيف الملفات المؤقتة
        if (result.filesToSend) {
            for (const fp of result.filesToSend) {
                try {
                    fs.unlinkSync(fp);
                } catch (_) {}
            }
        }

        try {
            await message.react('☑️');
            await message.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {});
        } catch (_) {}

    } catch (error) {
        console.error('[Agent Error]', error);
        try {
            await message.reply(`⚠️ خطأ غير متوقع: ${String(error.message || error).slice(0, 300)}`);
        } catch (_) {}
        try {
            await message.react('❌');
            await message.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {});
        } catch (_) {}
    }
});


client.on('error', (err) => {
    console.error(`[Agent ${agentId}] Discord error:`, err);
    if (agentConfig.onError) agentConfig.onError(err);
});

client.on('shardDisconnect', (event) => {
    if (!intentionalStop && agentConfig.onUnexpectedDisconnect) {
        agentConfig.onUnexpectedDisconnect(`shardDisconnect ${event?.code || ''} ${event?.reason || ''}`.trim());
    }
});

client.on('invalidated', () => {
    if (!intentionalStop && agentConfig.onUnexpectedDisconnect) {
        agentConfig.onUnexpectedDisconnect('session invalidated');
    }
});

    await client.login(discordToken);
    return {
        id: agentId,
        name: agentName,
        tokenType,
        client,
        channel_sessions,
        allowed_channels_cache,
        stop: () => {
            intentionalStop = true;
            channel_sessions.clear();
            allowed_channels_cache.clear();
            client.removeAllListeners();
            client.destroy();
        },
    };
}

module.exports = { startAgentRuntime };