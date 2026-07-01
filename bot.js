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

// ══════════════════════════════════════════════════════════════
//  إنشاء Client
// ══════════════════════════════════════════════════════════════
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ══════════════════════════════════════════════════════════════
//  حدث READY
// ══════════════════════════════════════════════════════════════
client.once('ready', async () => {
    // الاتصال بقاعدة البيانات أولاً
    await connectMongo();

    const botName = client.user.displayName || client.user.username;
    console.log(`✅ ${botName} (${client.user.id}) ready`);
    console.log(`📡 Guilds (${client.guilds.cache.size}): ${client.guilds.cache.map(g => g.name).join(', ')}`);

    // تسجيل أوامر السلاش
    try {
        const commands = [
            new SlashCommandBuilder()
                .setName('اوامر')
                .setDescription('عرض جميع الأوامر المتاحة'),
            new SlashCommandBuilder()
                .setName('قناة-محادثة')
                .setDescription('أضف قناة لقائمة قنوات البوت (أدمن فقط)')
                .addStringOption(option =>
                    option.setName('قناة')
                        .setDescription('اختر القناة')
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
            new SlashCommandBuilder()
                .setName('قنوات-مسموحة')
                .setDescription('عرض قنوات البوت النشطة في هذا السيرفر'),
            new SlashCommandBuilder()
                .setName('حذف-قناة')
                .setDescription('احذف قناة من قائمة البوت (أدمن فقط)')
                .addStringOption(option =>
                    option.setName('قناة')
                        .setDescription('اختر القناة للحذف')
                        .setRequired(true)
                        .setAutocomplete(true),
                ),
            new SlashCommandBuilder()
                .setName('محادثة-جديدة')
                .setDescription('أعد تعيين محادثة قناة واختر الموديل')
                .addStringOption(option =>
                    option.setName('قناة')
                        .setDescription('القناة التي تريد إعادة تعيين محادثتها (اتركها فارغة للقناة الحالية)')
                        .setRequired(false)
                        .setAutocomplete(true),
                )
                .addStringOption(option =>
                    option.setName('وضع')
                        .setDescription('نوع الموديل')
                        .setRequired(false)
                        .addChoices(
                            { name: '🗨️ عادي', value: 'default' },
                            { name: '🧠 خبير (Expert)', value: 'expert' },
                        ),
                )
                .addStringOption(option =>
                    option.setName('تفكير')
                        .setDescription('تفعيل التفكير العميق')
                        .setRequired(false)
                        .addChoices(
                            { name: '⚡ بدون تفكير — رد مباشر وأسرع', value: 'off' },
                            { name: '🔍 مع تفكير عميق — تحليل أدق', value: 'on' },
                        ),
                ),
            new SlashCommandBuilder()
                .setName('رتبة-التحكم')
                .setDescription('حدد الرتبة التي تستطيع استخدام البوت (أدمن فقط)')
                .addStringOption(option =>
                    option.setName('role')
                        .setDescription('اسم الرتبة (اتركها فارغة لتعطيل القيد)')
                        .setRequired(false),
                ),
            new SlashCommandBuilder()
                .setName('الرتبة-الحالية')
                .setDescription('عرض رتبة التحكم الحالية'),
            new SlashCommandBuilder()
                .setName('مزود-باو')
                .setDescription('تبديل مزود POW (أدمن فقط)')
                .addStringOption(option =>
                    option.setName('provider')
                        .setDescription('اختر المزود')
                        .setRequired(true)
                        .addChoices(
                            { name: '🚂 Railway (افتراضي)', value: 'railway' },
                            { name: '✈️ Telegram Proxy', value: 'telegram' },
                        ),
                ),
        ];

        const rest = new REST({ version: '10' }).setToken(USER_TOKEN);

        console.log('⏳ جاري تسجيل أوامر السلاش...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands.map(cmd => cmd.toJSON()) },
        );
        console.log('✅ Slash commands synced');
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
                .filter(ch => ch.type === ChannelType.GuildText && ch.name.toLowerCase().includes(current))
                .first(25)
                .map(ch => ({ name: `#${ch.name}`, value: ch.id }));
            await interaction.respond(choices);
        }
        return;
    }

    // ── Slash Commands ──
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const guild = interaction.guild;
    const member = interaction.member;

    try {
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
            await interaction.reply({ content: helpText, ephemeral: true });
        }

        else if (commandName === 'قناة-محادثة') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.', ephemeral: true });
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            let ch = guild.channels.cache.get(chanValue);
            if (!ch || ch.type !== ChannelType.GuildText) {
                ch = guild.channels.cache.find(c => c.name.toLowerCase() === chanValue.toLowerCase() && c.type === ChannelType.GuildText);
            }
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.', ephemeral: true });
                return;
            }
            const added = await add_allowed_channel(guild.id, ch.id);
            if (!added) {
                await interaction.reply({
                    content: `⛔ وصلت للحد الأقصى (${MAX_CHANNELS_PER_GUILD} قنوات). احذف قناة أولاً بـ /حذف-قناة.`,
                    ephemeral: true,
                });
                return;
            }
            await interaction.reply({
                content: `✅ تم إضافة **#${ch.name}** للقنوات النشطة.\nالبوت سيستجيب الآن في هذه القناة.`,
                ephemeral: true,
            });
        }

        else if (commandName === 'قنوات-مسموحة') {
            const ids = await get_allowed_channels(guild.id);
            if (!ids.length) {
                await interaction.reply({
                    content: `📭 لا توجد قنوات مضافة بعد. استخدم **/قناة-محادثة** لإضافة قنوات (حد أقصى ${MAX_CHANNELS_PER_GUILD}).`,
                    ephemeral: true,
                });
                return;
            }
            const lines = [`# القنوات النشطة (${ids.length}/${MAX_CHANNELS_PER_GUILD})\n`];
            for (const cid of ids) {
                const ch = guild.channels.cache.get(cid);
                lines.push(`- ${ch ? '#' + ch.name : '~~محذوفة~~'} (\`${cid}\`)`);
            }
            await interaction.reply({ content: lines.join('\n'), ephemeral: true });
        }

        else if (commandName === 'حذف-قناة') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.', ephemeral: true });
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            let ch = guild.channels.cache.get(chanValue);
            if (!ch || ch.type !== ChannelType.GuildText) {
                ch = guild.channels.cache.find(c => c.name.toLowerCase() === chanValue.toLowerCase() && c.type === ChannelType.GuildText);
            }
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.', ephemeral: true });
                return;
            }
            const ids = await get_allowed_channels(guild.id);
            if (!ids.includes(ch.id)) {
                await interaction.reply({ content: `❌ **#${ch.name}** غير موجودة في القائمة.`, ephemeral: true });
                return;
            }
            await remove_allowed_channel(guild.id, ch.id);
            await interaction.reply({ content: `✅ تم حذف **#${ch.name}** من قنوات البوت.`, ephemeral: true });
        }

        else if (commandName === 'محادثة-جديدة') {
            const guildId = guild.id;
            const targetChanId = interaction.options.getString('قناة') || interaction.channelId;
            // التحقق من وجود القناة
            const chObj = guild.channels.cache.get(targetChanId);
            if (!chObj) {
                await interaction.reply({ content: '❌ القناة غير موجودة.', ephemeral: true });
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
            await db_reset_channel_session(guildId, targetChanId);

            const chName = chObj.name || `ID:${targetChanId}`;
            const modeLabel = mode === 'expert' ? '🧠 خبير' : '🗨️ عادي';
            const thinkLbl = thinking ? '🔍 مفعّل' : '⚡ غير مفعّل';
            await interaction.reply({
                content: `✅ **تم إعادة تعيين محادثة #${chName}**\nالموديل: **${modeLabel}** | التفكير: **${thinkLbl}**`,
                ephemeral: true,
            });
        }

        else if (commandName === 'رتبة-التحكم') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.', ephemeral: true });
                return;
            }
            const roleName = interaction.options.getString('role') || '';
            await set_control_role(guild.id, roleName);
            if (roleName) {
                await interaction.reply({ content: `✅ رتبة التحكم: **${roleName}**`, ephemeral: true });
            } else {
                await interaction.reply({ content: '✅ تم إزالة قيد الرتبة — الكل يقدر يستخدم البوت.', ephemeral: true });
            }
        }

        else if (commandName === 'الرتبة-الحالية') {
            const role = await get_control_role(guild.id);
            if (role) {
                await interaction.reply({ content: `🔒 رتبة التحكم: **${role}**`, ephemeral: true });
            } else {
                await interaction.reply({ content: '🔓 لا يوجد قيد — الكل يقدر يستخدم البوت.', ephemeral: true });
            }
        }

        else if (commandName === 'مزود-باو') {
            if (!member.permissions.has('Administrator')) {
                await interaction.reply({ content: '⛔ هذا الأمر للأدمن فقط.', ephemeral: true });
                return;
            }
            const provider = interaction.options.getString('provider', true);
            await set_pow_provider(guild.id, provider);
            await interaction.reply({ content: `✅ تم تبديل مزود POW إلى **${provider}**`, ephemeral: true });
        }

    } catch (error) {
        console.error(`[Slash Error] ${commandName}:`, error);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '⚠️ حدث خطأ أثناء معالجة الأمر.', ephemeral: true });
            } else {
                await interaction.followUp({ content: '⚠️ حدث خطأ.', ephemeral: true });
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
    const allowedIds = await get_allowed_channels(message.guild.id);
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
    const botContext = await buildBotContext(client, message.guild, message.channel);

    // جلسة القناة (per-channel)
    const chKey = `${message.guild.id}_${message.channel.id}`;
    let cs;
    await sessionLock.acquire(async () => {
        if (!channel_sessions.has(chKey)) {
            const loaded = await db_load_channel_session(message.guild.id, message.channel.id);
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

// ══════════════════════════════════════════════════════════════
//  تشغيل البوت
// ══════════════════════════════════════════════════════════════
(async () => {
    // التحقق من متغيرات البيئة
    const missing = [];
    if (!USER_TOKEN) missing.push('USER_TOKEN');
    if (!process.env.DEEPSEEK_TOKEN) missing.push('DEEPSEEK_TOKEN');
    if (missing.length) {
        console.error(`❌ متغيرات مفقودة: ${missing.join(', ')}`);
        process.exit(1);
    }

    client.login(USER_TOKEN);
})();