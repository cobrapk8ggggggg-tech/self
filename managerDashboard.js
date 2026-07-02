'use strict';

const { ObjectId } = require('mongodb');
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ChannelType,
} = require('discord.js');

const DASH_PREFIX = 'dash';
const PAGE_SIZE = 25;

const COLORS = Object.freeze({
    primary: 0x5865F2,
    success: 0x57F287,
    danger : 0xED4245,
    warning: 0xFEE75C,
    info   : 0x3498DB,
    dark   : 0x2B2D31,
    live   : 0x9B59B6,
});

const ICONS = Object.freeze({
    panel: '🧭', agents: '👥', add: '➕', settings: '⚙️', notifications: '🔔', logs: '📜', stats: '📊', system: '🖥️',
    running: '🟢', stopped: '⚫', failed: '🔴', starting: '🟡', restarting: '🔄', bot: '🤖', user: '👤', back: '↩️', refresh: '🔄',
});

const DASHBOARD_COMMAND_ROUTES = Object.freeze({
    panel: 'home',
    'لوحة': 'home',
    'الوكلاء': 'agents',
    'انشاء-وكيل': 'create',
    'الاعدادات': 'settings',
    'الاشعارات': 'notifications',
    'السجلات': 'logs',
    'الاحصائيات': 'stats',
    'النظام': 'system',
});

function dashboardCommands() {
    return [
        new SlashCommandBuilder().setName('panel').setDescription('Open the Disor AI Agents Control Center'),
        new SlashCommandBuilder().setName('لوحة').setDescription('فتح مركز تحكم وكلاء الذكاء الاصطناعي'),
        new SlashCommandBuilder().setName('الوكلاء').setDescription('فتح صفحة إدارة الوكلاء من لوحة التحكم'),
        new SlashCommandBuilder().setName('انشاء-وكيل').setDescription('فتح معالج إنشاء وكيل جديد من لوحة التحكم'),
        new SlashCommandBuilder().setName('الاعدادات').setDescription('فتح إعدادات منصة الوكلاء'),
        new SlashCommandBuilder().setName('الاشعارات').setDescription('فتح إعدادات إشعارات الوكلاء'),
        new SlashCommandBuilder().setName('السجلات').setDescription('فتح سجلات وتايملاين النظام'),
        new SlashCommandBuilder().setName('الاحصائيات').setDescription('فتح إحصائيات الوكلاء'),
        new SlashCommandBuilder().setName('النظام').setDescription('فتح حالة النظام والتشغيل'),
    ];
}

function dashboardCommandRoute(commandName) {
    return DASHBOARD_COMMAND_ROUTES[String(commandName || '')] || null;
}

function isDashboardCommand(commandName) {
    return Boolean(dashboardCommandRoute(commandName));
}

function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function trim(text, max = 90) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function tokenTypeLabel(agent) {
    return String(agent?.token_type || 'bot').toLowerCase() === 'user' ? 'User Account' : 'Bot Token';
}

function statusIcon(status) {
    const s = String(status || 'stopped').toLowerCase();
    if (s === 'running') return ICONS.running;
    if (s === 'failed') return ICONS.failed;
    if (s === 'starting') return ICONS.starting;
    if (s === 'restarting') return ICONS.restarting;
    return ICONS.stopped;
}

function agentIcon(agent) {
    return String(agent?.token_type || 'bot').toLowerCase() === 'user' ? ICONS.user : ICONS.bot;
}

function embed(title, description, color = COLORS.primary) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description || '—')
        .setTimestamp()
        .setFooter({ text: 'Disor Control Center • Dashboard-grade management' });
}

function linesBlock(lines) {
    return ['━━━━━━━━━━━━━━━━━━━━', ...lines.filter(Boolean), '━━━━━━━━━━━━━━━━━━━━'].join('\n');
}

function button(id, label, style = ButtonStyle.Secondary, emoji, disabled = false) {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
    if (emoji) b.setEmoji(emoji);
    return b;
}

function rowsFromButtons(buttons) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return rows;
}

async function managerSettings(guildId) {
    const cfg = require('./config');
    return cfg.settings_col.findOne({ scope: 'manager', guild_id: String(guildId || 'global') });
}

async function updateManagerSettings(guildId, patch) {
    const cfg = require('./config');
    await cfg.settings_col.updateOne(
        { scope: 'manager', guild_id: String(guildId || 'global') },
        { $set: { ...patch, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
        { upsert: true },
    );
}

async function hasDashboardAccess(interaction) {
    const cfg = require('./config');
    if (String(interaction.user.id) === String(cfg.BOT_OWNER_ID)) return true;
    const settings = interaction.guildId ? await managerSettings(interaction.guildId).catch(() => null) : null;
    const roleId = settings?.admin_role_id;
    if (!roleId || !interaction.member?.roles) return false;
    if (interaction.member.roles.cache?.has(roleId)) return true;
    return Array.isArray(interaction.member.roles) && interaction.member.roles.includes(roleId);
}

async function requireAccess(interaction) {
    if (await hasDashboardAccess(interaction)) return true;
    await interaction.reply({ embeds: [embed('⛔ صلاحية مرفوضة', linesBlock(['هذه لوحة إدارة مركزية ولا يمكن استخدامها إلا بواسطة المالك أو رتبة الإدارة المحددة.']), COLORS.danger)] }).catch(() => {});
    return false;
}

async function overview(manager) {
    const cfg = require('./config');
    const agents = await cfg.agents_col.find({}).sort({ created_at: -1 }).toArray();
    const logs = await cfg.logs_col.find({}).sort({ created_at: -1 }).limit(8).toArray();
    const counts = { total: agents.length, running: 0, stopped: 0, failed: 0, transitional: 0, bots: 0, users: 0 };
    for (const a of agents) {
        const s = String(a.status || 'stopped');
        if (s === 'running') counts.running++;
        else if (s === 'failed') counts.failed++;
        else if (['starting', 'stopping', 'restarting'].includes(s)) counts.transitional++;
        else counts.stopped++;
        if (String(a.token_type || 'bot') === 'user') counts.users++; else counts.bots++;
    }
    return { agents, logs, counts, activeRuntimeCount: manager.runtimes.size };
}

async function renderHome(manager, interaction) {
    const data = await overview(manager);
    const settings = interaction.guildId ? await managerSettings(interaction.guildId).catch(() => null) : null;
    const emb = embed(`${ICONS.panel} Disor AI Agents Control Center`, linesBlock([
        '**منصة SaaS داخل Discord لإدارة وكلاء الذكاء الاصطناعي.**',
        '',
        `${ICONS.agents} **الوكلاء:** ${data.counts.total} | ${ICONS.running} يعمل: ${data.counts.running} | ${ICONS.stopped} متوقف: ${data.counts.stopped} | ${ICONS.failed} فشل: ${data.counts.failed}`,
        `${ICONS.bot} **Bot Tokens:** ${data.counts.bots}  •  ${ICONS.user} **User Accounts:** ${data.counts.users}`,
        `${ICONS.system} **Runtimes نشطة:** ${data.activeRuntimeCount}`,
        `${ICONS.notifications} **قناة الإشعارات:** ${settings?.notification_channel_id ? `<#${settings.notification_channel_id}>` : 'غير محددة'}`,
        `${ICONS.settings} **رتبة الإدارة:** ${settings?.admin_role_id ? `<@&${settings.admin_role_id}>` : 'المالك فقط'}`,
        '',
        '**اختر قسمًا من الأسفل. كل شاشة تعمل كصفحة داخل تطبيق، لا كأمر نصي.**',
    ]), COLORS.live);
    const buttons = [
        button(`${DASH_PREFIX}:agents:0`, 'الوكلاء', ButtonStyle.Primary, ICONS.agents),
        button(`${DASH_PREFIX}:create`, 'إنشاء وكيل', ButtonStyle.Success, ICONS.add),
        button(`${DASH_PREFIX}:settings`, 'الإعدادات', ButtonStyle.Secondary, ICONS.settings),
        button(`${DASH_PREFIX}:notifications`, 'الإشعارات', ButtonStyle.Secondary, ICONS.notifications),
        button(`${DASH_PREFIX}:logs:0`, 'السجلات', ButtonStyle.Secondary, ICONS.logs),
        button(`${DASH_PREFIX}:stats`, 'الإحصائيات', ButtonStyle.Secondary, ICONS.stats),
        button(`${DASH_PREFIX}:system`, 'حالة النظام', ButtonStyle.Secondary, ICONS.system),
        button(`${DASH_PREFIX}:home`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
    ];
    return { embeds: [emb], components: rowsFromButtons(buttons) };
}

function agentOption(agent) {
    const id = String(agent._id);
    return {
        label: trim(`${statusIcon(agent.status)} ${agent.name || id}`, 100),
        value: id,
        description: trim(`${tokenTypeLabel(agent)} • ${agent.status || 'stopped'} • آخر نشاط ${fmtDate(agent.last_activity_at || agent.updated_at)}`, 100),
        emoji: String(agent.token_type || 'bot') === 'user' ? ICONS.user : ICONS.bot,
    };
}

async function renderAgents(manager, page = 0) {
    const cfg = require('./config');
    const total = await cfg.agents_col.countDocuments();
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
    const agents = await cfg.agents_col.find({}).sort({ updated_at: -1, created_at: -1 }).skip(safePage * PAGE_SIZE).limit(PAGE_SIZE).toArray();
    const emb = embed(`${ICONS.agents} الوكلاء`, linesBlock([
        '**اختر وكيلاً من القائمة لإدارة صفحة كاملة خاصة به.**',
        'لا تظهر معرفات MongoDB في الواجهة؛ الاختيار يتم بالاسم والحالة فقط.',
        '',
        `العدد الإجمالي: **${total}**`,
        `الصفحة: **${safePage + 1}/${pages}**`,
    ]), COLORS.info);
    const components = [];
    if (agents.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent_select`)
                .setPlaceholder('اختر وكيلًا لإدارته')
                .addOptions(agents.map(agentOption)),
        ));
    }
    components.push(...rowsFromButtons([
        button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back),
        button(`${DASH_PREFIX}:agents:${safePage - 1}`, 'السابق', ButtonStyle.Secondary, '⬅️', safePage <= 0),
        button(`${DASH_PREFIX}:agents:${safePage + 1}`, 'التالي', ButtonStyle.Secondary, '➡️', safePage >= pages - 1),
        button(`${DASH_PREFIX}:create`, 'إنشاء وكيل', ButtonStyle.Success, ICONS.add),
        button(`${DASH_PREFIX}:agents:${safePage}`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
    ]));
    return { embeds: [emb], components };
}

async function renderAgent(manager, agentId) {
    const cfg = require('./config');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    if (!agent) return { embeds: [embed('❌ الوكيل غير موجود', linesBlock(['قد يكون الوكيل حُذف أو لم يعد متاحًا.']), COLORS.danger)], components: rowsFromButtons([button(`${DASH_PREFIX}:agents:0`, 'عودة للوكلاء', ButtonStyle.Secondary, ICONS.back)]) };
    const id = String(agent._id);
    const running = manager.runtimes.has(id);
    const status = agent.status || (running ? 'running' : 'stopped');
    const emb = embed(`${agentIcon(agent)} ${agent.name || 'Agent'}`, linesBlock([
        `📌 **النوع:** ${tokenTypeLabel(agent)}`,
        `${statusIcon(status)} **الحالة:** ${status}`,
        `🧩 **Runtime:** ${running ? 'متصل ونشط' : 'غير نشط'}`,
        `🧠 **DeepSeek Token:** ${agent.deepseek_token ? 'موجود' : 'مفقود'}`,
        `🎭 **الشخصية:** ${agent.personality ? trim(agent.personality, 120) : 'افتراضية'}`,
        `🔔 **قناة إشعارات الوكيل:** ${agent.notification_channel_id ? `<#${agent.notification_channel_id}>` : 'غير محددة'}`,
        `🕒 **آخر تحديث:** ${fmtDate(agent.updated_at)}`,
        `🧾 **آخر سبب حالة:** ${agent.status_reason || '—'}`,
        '',
        '**كل الإجراءات تتم من Manager Runtime فقط.**',
    ]), status === 'failed' ? COLORS.danger : running ? COLORS.success : COLORS.dark);
    const isRunning = status === 'running' || running;
    const isBusy = ['starting', 'stopping', 'restarting'].includes(status);
    const actions = [
        button(`${DASH_PREFIX}:agent:${id}:start`, 'تشغيل', ButtonStyle.Success, '▶️', isRunning || isBusy),
        button(`${DASH_PREFIX}:agent:${id}:stop`, 'إيقاف', ButtonStyle.Danger, '⏹️', !isRunning || isBusy),
        button(`${DASH_PREFIX}:agent:${id}:restart`, 'إعادة تشغيل', ButtonStyle.Primary, '🔄', isBusy),
        button(`${DASH_PREFIX}:agent:${id}:edit`, 'تعديل', ButtonStyle.Secondary, '✏️'),
        button(`${DASH_PREFIX}:agent:${id}:channels`, 'القنوات', ButtonStyle.Secondary, '📡'),
        button(`${DASH_PREFIX}:agent:${id}:conversations`, 'المحادثات', ButtonStyle.Secondary, '💬'),
        button(`${DASH_PREFIX}:agent:${id}:provider`, 'مزود POW', ButtonStyle.Secondary, '⚡'),
        button(`${DASH_PREFIX}:agent:${id}:notify`, 'الإشعارات', ButtonStyle.Secondary, '🔔'),
        button(`${DASH_PREFIX}:agent:${id}:logs:0`, 'Timeline', ButtonStyle.Secondary, '📜'),
        button(`${DASH_PREFIX}:agent:${id}:delete_confirm`, 'حذف', ButtonStyle.Danger, '🗑️'),
        button(`${DASH_PREFIX}:agents:0`, 'عودة', ButtonStyle.Secondary, ICONS.back),
        button(`${DASH_PREFIX}:agent:${id}:view`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
    ];
    return { embeds: [emb], components: rowsFromButtons(actions) };
}

function createTypeView() {
    const emb = embed('➕ إنشاء وكيل — Wizard', linesBlock([
        '**الخطوة 1 من 3: اختر نوع الوكيل.**',
        `${ICONS.bot} Bot Token: يمكنه عرض واجهة Dashboard كواجهة فقط، والتنفيذ يبقى في Manager.`,
        `${ICONS.user} User Account: Runtime فقط بدون Slash/Application Commands.`,
    ]), COLORS.success);
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:create_type`)
            .setPlaceholder('اختر نوع الوكيل')
            .addOptions([
                { label: 'Bot Token', value: 'bot', description: 'واجهة UI اختيارية + Runtime AI', emoji: ICONS.bot },
                { label: 'User Account', value: 'user', description: 'Runtime فقط بدون Commands', emoji: ICONS.user },
            ]),
    );
    return { embeds: [emb], components: [row, ...rowsFromButtons([button(`${DASH_PREFIX}:home`, 'إلغاء والعودة', ButtonStyle.Secondary, ICONS.back)])] };
}

function createAgentModal(type) {
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:create_modal:${type}`).setTitle(type === 'user' ? 'إنشاء User Account Runtime' : 'إنشاء Bot Agent');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('اسم الوكيل').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord_token').setLabel(type === 'user' ? 'User Token' : 'Discord Bot Token').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('deepseek_token').setLabel('DeepSeek Token').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('personality').setLabel('الشخصية / Personality').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500)),
    );
    return modal;
}

function editAgentModal(agent) {
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:edit_modal:${agent._id}`).setTitle('تعديل إعدادات الوكيل');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('اسم الوكيل').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80).setValue(String(agent.name || ''))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('personality').setLabel('الشخصية').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500).setValue(String(agent.personality || ''))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord_token').setLabel('Discord Token جديد — اتركه فارغًا للإبقاء عليه').setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('deepseek_token').setLabel('DeepSeek Token جديد — اتركه فارغًا للإبقاء عليه').setStyle(TextInputStyle.Short).setRequired(false)),
    );
    return modal;
}

async function renderNotifications(agentId = null, guildId = null) {
    const cfg = require('./config');
    const settings = guildId ? await managerSettings(guildId).catch(() => null) : null;
    const agent = agentId ? await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }) : null;
    const emb = embed('🔔 الإشعارات', linesBlock([
        '**إدارة مسارات الإشعارات المهمة.**',
        `📡 القناة العامة: ${settings?.notification_channel_id ? `<#${settings.notification_channel_id}>` : 'غير محددة'}`,
        agent ? `🤖 الوكيل: **${agent.name}**` : null,
        agent ? `🔔 قناة الوكيل: ${agent.notification_channel_id ? `<#${agent.notification_channel_id}>` : 'غير محددة'}` : null,
        '',
        'الأحداث: تشغيل، توقف، Restart، فشل، Disconnect، Reconnect، أخطاء Runtime، وتعديلات إدارية.',
    ]), COLORS.info);
    const components = [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(agent ? `${DASH_PREFIX}:agent:${agentId}:notify_channel` : `${DASH_PREFIX}:notify_global_channel`)
                .setPlaceholder(agent ? 'اختر قناة إشعارات لهذا الوكيل' : 'اختر قناة الإشعارات العامة')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
        ...rowsFromButtons([
            button(agent ? `${DASH_PREFIX}:agent:${agentId}:view` : `${DASH_PREFIX}:home`, 'عودة', ButtonStyle.Secondary, ICONS.back),
            button(`${DASH_PREFIX}:notify_test`, 'إرسال اختبار', ButtonStyle.Primary, '🧪'),
        ]),
    ];
    return { embeds: [emb], components };
}

async function renderSettings(guildId) {
    const settings = guildId ? await managerSettings(guildId).catch(() => null) : null;
    const emb = embed('⚙️ إعدادات المنصة', linesBlock([
        '**إعدادات Dashboard وRuntime من مكان واحد.**',
        `🛡️ رتبة الإدارة: ${settings?.admin_role_id ? `<@&${settings.admin_role_id}>` : 'المالك فقط'}`,
        `🔔 قناة الإشعارات العامة: ${settings?.notification_channel_id ? `<#${settings.notification_channel_id}>` : 'غير محددة'}`,
        `🔁 إعادة الاتصال: مفعلة عبر Manager Lifecycle`,
        `🧾 التسجيل: مفعّل في agent_logs`,
    ]), COLORS.dark);
    return { embeds: [emb], components: [
        new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:settings_admin_role`).setPlaceholder('اختر رتبة الإدارة للوحة')),
        ...rowsFromButtons([
            button(`${DASH_PREFIX}:notifications`, 'قناة الإشعارات', ButtonStyle.Secondary, ICONS.notifications),
            button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back),
        ]),
    ] };
}

async function renderLogs(agentId = null, page = 0) {
    const cfg = require('./config');
    const query = agentId ? { agent_id: String(agentId) } : {};
    const total = await cfg.logs_col.countDocuments(query);
    const pages = Math.max(1, Math.ceil(total / 10));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
    const logs = await cfg.logs_col.find(query).sort({ created_at: -1 }).skip(safePage * 10).limit(10).toArray();
    const rows = logs.length ? logs.map((log) => `• **${fmtDate(log.created_at)}** — **${log.type}** — ${trim(log.message, 120)}`) : ['لا توجد سجلات بعد.'];
    const emb = embed(agentId ? '📜 Timeline الوكيل' : '📜 Timeline النظام', linesBlock([
        `الصفحة: **${safePage + 1}/${pages}**`,
        '',
        ...rows,
    ]), COLORS.dark);
    const back = agentId ? `${DASH_PREFIX}:agent:${agentId}:view` : `${DASH_PREFIX}:home`;
    return { embeds: [emb], components: rowsFromButtons([
        button(back, 'عودة', ButtonStyle.Secondary, ICONS.back),
        button(agentId ? `${DASH_PREFIX}:agent:${agentId}:logs:${safePage - 1}` : `${DASH_PREFIX}:logs:${safePage - 1}`, 'السابق', ButtonStyle.Secondary, '⬅️', safePage <= 0),
        button(agentId ? `${DASH_PREFIX}:agent:${agentId}:logs:${safePage + 1}` : `${DASH_PREFIX}:logs:${safePage + 1}`, 'التالي', ButtonStyle.Secondary, '➡️', safePage >= pages - 1),
    ]) };
}

async function renderStats(manager) {
    const data = await overview(manager);
    const emb = embed('📊 الإحصائيات', linesBlock([
        `👥 إجمالي الوكلاء: **${data.counts.total}**`,
        `${ICONS.running} يعمل: **${data.counts.running}**`,
        `${ICONS.stopped} متوقف: **${data.counts.stopped}**`,
        `${ICONS.failed} فاشل: **${data.counts.failed}**`,
        `🧩 Runtimes نشطة: **${data.activeRuntimeCount}**`,
        `${ICONS.bot} Bot Tokens: **${data.counts.bots}**`,
        `${ICONS.user} User Accounts: **${data.counts.users}**`,
        '',
        'عدادات الرسائل واستهلاك DeepSeek ستظهر هنا بعد إضافة قياس telemetry لكل استدعاء دون تغيير AI flow.',
    ]), COLORS.info);
    return { embeds: [emb], components: rowsFromButtons([button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:stats`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]) };
}

async function renderSystem(manager) {
    const cfg = require('./config');
    const emb = embed('🖥️ حالة النظام', linesBlock([
        `Node.js: **${process.version}**`,
        `MongoDB URI: **${cfg.MONGODB_URI ? 'محدد' : 'غير محدد'}**`,
        `Manager Bot Token: **${cfg.DISCORD_TOKEN ? 'محدد' : 'غير محدد'}**`,
        `Legacy USER_TOKEN: **${cfg.USER_TOKEN ? 'محدد' : 'غير محدد'}**`,
        `Runtimes: **${manager.runtimes.size}**`,
        `Uptime: **${Math.floor(process.uptime())}s**`,
    ]), COLORS.dark);
    return { embeds: [emb], components: rowsFromButtons([button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:system`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]) };
}

async function updateInteraction(interaction, payload) {
    if (interaction.isChatInputCommand()) return interaction.reply(payload);
    if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) return interaction.update(payload);
    return interaction.reply(payload);
}

async function handleDashboardInteraction(interaction, manager) {
    const commandRoute = interaction.isChatInputCommand?.() ? dashboardCommandRoute(interaction.commandName) : null;
    const commandOk = Boolean(commandRoute);
    const componentOk = interaction.customId && interaction.customId.startsWith(`${DASH_PREFIX}:`);
    if (!commandOk && !componentOk) return false;
    if (!await requireAccess(interaction)) return true;

    if (commandOk) {
        if (commandRoute === 'agents') return updateInteraction(interaction, await renderAgents(manager, 0));
        if (commandRoute === 'create') return updateInteraction(interaction, createTypeView());
        if (commandRoute === 'settings') return updateInteraction(interaction, await renderSettings(interaction.guildId));
        if (commandRoute === 'notifications') return updateInteraction(interaction, await renderNotifications(null, interaction.guildId));
        if (commandRoute === 'logs') return updateInteraction(interaction, await renderLogs(null, 0));
        if (commandRoute === 'stats') return updateInteraction(interaction, await renderStats(manager));
        if (commandRoute === 'system') return updateInteraction(interaction, await renderSystem(manager));
        return updateInteraction(interaction, await renderHome(manager, interaction));
    }

    const id = interaction.customId;
    const parts = id.split(':');

    if (interaction.isStringSelectMenu() && id === `${DASH_PREFIX}:create_type`) {
        await interaction.showModal(createAgentModal(interaction.values[0]));
        return true;
    }
    if (interaction.isStringSelectMenu() && id === `${DASH_PREFIX}:agent_select`) {
        await interaction.update(await renderAgent(manager, interaction.values[0]));
        return true;
    }
    if (interaction.isChannelSelectMenu() && id === `${DASH_PREFIX}:notify_global_channel`) {
        await updateManagerSettings(interaction.guildId, { notification_channel_id: interaction.values[0] });
        await interaction.update(await renderNotifications(null, interaction.guildId));
        return true;
    }
    if (interaction.isRoleSelectMenu() && id === `${DASH_PREFIX}:settings_admin_role`) {
        await updateManagerSettings(interaction.guildId, { admin_role_id: interaction.values[0] });
        await interaction.update(await renderSettings(interaction.guildId));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:create_modal:`)) {
        const type = parts[2] === 'user' ? 'user' : 'bot';
        const agent = await manager.createAgent({
            name: interaction.fields.getTextInputValue('name'),
            discord_token: interaction.fields.getTextInputValue('discord_token'),
            deepseek_token: interaction.fields.getTextInputValue('deepseek_token'),
            personality: interaction.fields.getTextInputValue('personality') || '',
            token_type: type,
        });
        await manager.logAgent(String(agent._id), 'create', 'تم إنشاء وكيل من Dashboard', { token_type: type });
        await interaction.reply(await renderAgent(manager, String(agent._id)));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:edit_modal:`)) {
        const agentId = parts[2];
        const cfg = require('./config');
        const $set = { updated_at: new Date() };
        for (const key of ['name', 'personality', 'discord_token', 'deepseek_token']) {
            const val = interaction.fields.getTextInputValue(key);
            if (val) $set[key] = val;
        }
        await cfg.agents_col.updateOne({ _id: new ObjectId(agentId) }, { $set });
        await manager.logAgent(agentId, 'update', 'تم تعديل إعدادات الوكيل من Dashboard', { fields: Object.keys($set).filter(k => k !== 'updated_at') });
        await interaction.reply(await renderAgent(manager, agentId));
        return true;
    }

    if (parts[1] === 'home') return updateInteraction(interaction, await renderHome(manager, interaction));
    if (parts[1] === 'agents') return updateInteraction(interaction, await renderAgents(manager, parts[2]));
    if (parts[1] === 'create') return updateInteraction(interaction, createTypeView());
    if (parts[1] === 'settings') return updateInteraction(interaction, await renderSettings(interaction.guildId));
    if (parts[1] === 'notifications') return updateInteraction(interaction, await renderNotifications(null, interaction.guildId));
    if (parts[1] === 'logs') return updateInteraction(interaction, await renderLogs(null, parts[2]));
    if (parts[1] === 'stats') return updateInteraction(interaction, await renderStats(manager));
    if (parts[1] === 'system') return updateInteraction(interaction, await renderSystem(manager));
    if (parts[1] === 'notify_test') {
        await manager.notify({ type: 'test', agentId: 'manager', title: '🧪 اختبار الإشعارات', message: 'تم إرسال اختبار من لوحة التحكم.', guildId: interaction.guildId });
        return updateInteraction(interaction, await renderNotifications(null, interaction.guildId));
    }

    if (parts[1] === 'agent') {
        const agentId = parts[2];
        const action = parts[3];
        const cfg = require('./config');
        if (interaction.isChannelSelectMenu() && action === 'notify_channel') {
            await cfg.agents_col.updateOne({ _id: new ObjectId(agentId) }, { $set: { notification_channel_id: interaction.values[0], updated_at: new Date() } });
            await manager.logAgent(agentId, 'notification_channel', 'تم تحديث قناة إشعارات الوكيل');
            return interaction.update(await renderNotifications(agentId, interaction.guildId));
        }
        if (interaction.isChannelSelectMenu() && action === 'channel_add') {
            const { add_allowed_channel, get_allowed_channels } = require('./utils');
            const added = await add_allowed_channel(interaction.guildId, interaction.values[0], agentId);
            const ids = await get_allowed_channels(interaction.guildId, agentId);
            syncRuntimeAllowedChannels(manager, agentId, interaction.guildId, ids);
            await manager.logAgent(agentId, added ? 'channel_add' : 'channel_add_limit', added ? 'تمت إضافة قناة محادثة من Dashboard' : 'فشل إضافة قناة محادثة بسبب الحد الأقصى', { channel_id: interaction.values[0] });
            return interaction.update(await renderAgentChannels(agentId, interaction.guildId, added ? null : 'وصل الوكيل للحد الأقصى للقنوات، احذف قناة ثم حاول مجددًا.'));
        }
        if (interaction.isStringSelectMenu() && action === 'channel_remove') {
            const { remove_allowed_channel, get_allowed_channels } = require('./utils');
            await remove_allowed_channel(interaction.guildId, interaction.values[0], agentId);
            const ids = await get_allowed_channels(interaction.guildId, agentId);
            syncRuntimeAllowedChannels(manager, agentId, interaction.guildId, ids);
            await manager.logAgent(agentId, 'channel_remove', 'تم حذف قناة محادثة من Dashboard', { channel_id: interaction.values[0] });
            return interaction.update(await renderAgentChannels(agentId, interaction.guildId));
        }
        if (interaction.isStringSelectMenu() && action === 'provider_set') {
            const { set_pow_provider } = require('./utils');
            await set_pow_provider(interaction.guildId, interaction.values[0], agentId);
            await manager.logAgent(agentId, 'provider_update', 'تم تحديث مزود POW للوكيل من Dashboard', { provider: interaction.values[0] });
            return interaction.update(await renderAgentProvider(agentId, interaction.guildId));
        }
        if (interaction.isStringSelectMenu() && action === 'conversation_delete') {
            const { db_reset_channel_session } = require('./utils');
            await db_reset_channel_session(interaction.guildId, interaction.values[0], agentId);
            const runtime = manager?.runtimes?.get?.(String(agentId));
            runtime?.channel_sessions?.delete?.(`${interaction.guildId}_${interaction.values[0]}`);
            await manager.logAgent(agentId, 'conversation_delete', 'تم حذف محادثة قناة من Dashboard', { channel_id: interaction.values[0] });
            return interaction.update(await renderAgentConversations(agentId, interaction.guildId));
        }
        if (action === 'view') return updateInteraction(interaction, await renderAgent(manager, agentId));
        if (action === 'logs') return updateInteraction(interaction, await renderLogs(agentId, parts[4]));
        if (action === 'notify') return updateInteraction(interaction, await renderNotifications(agentId, interaction.guildId));
        if (action === 'channels') return updateInteraction(interaction, await renderAgentChannels(agentId, interaction.guildId));
        if (action === 'conversations') return updateInteraction(interaction, await renderAgentConversations(agentId, interaction.guildId));
        if (action === 'provider') return updateInteraction(interaction, await renderAgentProvider(agentId, interaction.guildId));
        if (action === 'edit') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            await interaction.showModal(editAgentModal(agent));
            return true;
        }
        if (action === 'start') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (agent) await manager.startAgent(agent);
            return updateInteraction(interaction, await renderAgent(manager, agentId));
        }
        if (action === 'stop') {
            await manager.stopAgent(agentId);
            return updateInteraction(interaction, await renderAgent(manager, agentId));
        }
        if (action === 'restart') {
            await manager.restartAgent(agentId, 'Dashboard restart');
            return updateInteraction(interaction, await renderAgent(manager, agentId));
        }
        if (action === 'delete_confirm') {
            const emb = embed('⚠️ تأكيد حذف الوكيل', linesBlock(['هذا الإجراء سيوقف Runtime ثم يحذف الوكيل من قاعدة البيانات.', 'لا يمكن التراجع عنه.']), COLORS.warning);
            return updateInteraction(interaction, { embeds: [emb], components: rowsFromButtons([
                button(`${DASH_PREFIX}:agent:${agentId}:delete`, 'تأكيد الحذف', ButtonStyle.Danger, '🗑️'),
                button(`${DASH_PREFIX}:agent:${agentId}:view`, 'إلغاء', ButtonStyle.Secondary, '❌'),
            ]) });
        }
        if (action === 'delete') {
            await manager.deleteAgent(agentId);
            return updateInteraction(interaction, await renderAgents(manager, 0));
        }
    }

    return false;
}


async function renderAgentProvider(agentId, guildId) {
    const cfg = require('./config');
    const { get_pow_provider } = require('./utils');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const provider = guildId ? await get_pow_provider(guildId, agentId).catch(() => 'railway') : 'railway';
    const emb = embed('⚡ مزود POW للوكيل', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `السيرفر الحالي: **${guildId || 'غير متاح'}**`,
        `المزود الحالي: **${provider}**`,
        '',
        'هذا الإعداد خاص بهذا الوكيل، وليس Manager Bot.',
    ]), COLORS.info);
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:agent:${agentId}:provider_set`)
            .setPlaceholder('اختر مزود POW لهذا الوكيل')
            .addOptions([
                { label: 'railway', value: 'railway', description: 'استخدام مزود Railway' },
                { label: 'telegram', value: 'telegram', description: 'استخدام مزود Telegram proxy' },
            ]),
    );
    return { embeds: [emb], components: [row, ...rowsFromButtons([button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:agent:${agentId}:provider`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)])] };
}

async function renderAgentConversations(agentId, guildId) {
    const cfg = require('./config');
    const { db_list_channel_sessions } = require('./utils');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const sessions = guildId ? await db_list_channel_sessions(guildId, agentId).catch(() => []) : [];
    const rows = sessions.length ? sessions.map((session) => {
        const channelId = String(session.channel_id);
        const updated = fmtDate(session.updated_at || session.created_at);
        return `• <#${channelId}> — الوضع: **${session.mode || 'default'}** — التفكير: **${session.thinking ? 'مفعل' : 'مغلق'}** — ${updated}`;
    }) : ['لا توجد محادثات محفوظة لهذا الوكيل في هذا السيرفر.'];
    const emb = embed('💬 محادثات الوكيل', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `السيرفر الحالي: **${guildId || 'غير متاح'}**`,
        `عدد المحادثات: **${sessions.length}**`,
        '',
        ...rows,
    ]), COLORS.info);
    const components = [];
    if (sessions.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:conversation_delete`)
                .setPlaceholder('اختر محادثة لحذفها/تصفيرها')
                .addOptions(sessions.slice(0, 25).map((session) => {
                    const channelId = String(session.channel_id);
                    return { label: `محادثة ${channelId}`.slice(0, 100), value: channelId, description: 'حذف جلسة هذه القناة' };
                })),
        ));
    }
    components.push(...rowsFromButtons([button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:agent:${agentId}:conversations`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]));
    return { embeds: [emb], components };
}

function syncRuntimeAllowedChannels(manager, agentId, guildId, ids) {
    const runtime = manager?.runtimes?.get?.(String(agentId));
    if (!runtime?.allowed_channels_cache || !guildId) return;
    runtime.allowed_channels_cache.set(`${String(agentId)}:${String(guildId)}`, ids.map(String));
}

async function renderAgentChannels(agentId, guildId, notice = null) {
    const cfg = require('./config');
    const { get_allowed_channels } = require('./utils');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const ids = guildId ? await get_allowed_channels(guildId, agentId).catch(() => []) : [];
    const emb = embed('📡 قنوات الوكيل', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `السيرفر الحالي: **${guildId || 'غير متاح'}**`,
        `القنوات المسموحة: **${ids.length}**`,
        notice ? `⚠️ ${notice}` : null,
        '',
        ...(ids.length ? ids.map(id => `• <#${id}>`) : ['لا توجد قنوات مضافة لهذا الوكيل في هذا السيرفر.']),
        '',
        'استخدم Channel Select لإضافة قناة، أو قائمة الحذف لإزالة قناة بدون كتابة أي معرف.',
    ]), COLORS.info);
    const components = [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:channel_add`)
                .setPlaceholder('اختر قناة لإضافتها إلى قنوات المحادثة')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    ];
    if (ids.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:channel_remove`)
                .setPlaceholder('اختر قناة لإزالتها')
                .addOptions(ids.slice(0, 25).map(id => ({ label: `قناة ${id}`.slice(0, 100), value: id, description: 'إزالة من القنوات المسموحة' }))),
        ));
    }
    components.push(...rowsFromButtons([button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:agent:${agentId}:channels`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]));
    return { embeds: [emb], components };
}

module.exports = {
    dashboardCommands,
    dashboardCommandRoute,
    isDashboardCommand,
    handleDashboardInteraction,
    renderHome,
    COLORS,
    embed,
    linesBlock,
};