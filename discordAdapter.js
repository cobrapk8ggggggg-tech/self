/**
 * discordAdapter.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * طبقة توافق خفيفة بين discord.js bot client و selfbot client.
 * لا تغيّر واجهة الأدوات؛ فقط توحّد إنشاء العميل وفحص أنواع القنوات.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { File: BufferFile } = require('node:buffer');
const { toUSVString } = require('node:util');

function ensureWebCompatibilityGlobals() {
    if (typeof globalThis.File === 'undefined' && typeof BufferFile !== 'undefined') {
        globalThis.File = BufferFile;
    }

    if (typeof String.prototype.toWellFormed !== 'function') {
        Object.defineProperty(String.prototype, 'toWellFormed', {
            value() {
                return toUSVString(String(this));
            },
            configurable: true,
            writable: true,
        });
    }

    if (typeof String.prototype.isWellFormed !== 'function') {
        Object.defineProperty(String.prototype, 'isWellFormed', {
            value() {
                return toUSVString(String(this)) === String(this);
            },
            configurable: true,
            writable: true,
        });
    }
}

ensureWebCompatibilityGlobals();

const {
    Client: BotClient,
    GatewayIntentBits,
    Partials,
    ChannelType,
} = require('discord.js');

function loadSelfbotLibrary() {
    ensureWebCompatibilityGlobals();
    return require('discord.js-selfbot-v13');
}

function normalizeTokenType(tokenType) {
    return String(tokenType || 'bot').toLowerCase() === 'user' ? 'user' : 'bot';
}

function createDiscordClient(tokenType = 'bot') {
    const type = normalizeTokenType(tokenType);
    if (type === 'user') {
        // نفس فلسفة Auto-main: selfbot client بسيط ومباشر، دون خلط خيارات discord.js v14.
        const { Client: UserClient } = loadSelfbotLibrary();
        const client = new UserClient();
        client.__selfbotRuntime = true;
        return client;
    }

    return new BotClient({
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
}

function isType(channel, v14Type, v13Type) {
    if (!channel) return false;
    return channel.type === v14Type || channel.type === v13Type;
}

function isTextChannel(channel) {
    return isType(channel, ChannelType.GuildText, 'GUILD_TEXT') || isType(channel, ChannelType.GuildAnnouncement, 'GUILD_NEWS');
}

function isVoiceChannel(channel) {
    return isType(channel, ChannelType.GuildVoice, 'GUILD_VOICE');
}

function isCategoryChannel(channel) {
    return isType(channel, ChannelType.GuildCategory, 'GUILD_CATEGORY');
}

function isThreadChannel(channel) {
    return String(channel?.type || '').includes('THREAD') || [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel?.type);
}

function channelCreateType(kind, tokenType = 'bot') {
    const type = normalizeTokenType(tokenType);
    if (type === 'user') {
        if (kind === 'category') return 'GUILD_CATEGORY';
        if (kind === 'voice') return 'GUILD_VOICE';
        if (kind === 'thread') return 'GUILD_PUBLIC_THREAD';
        return 'GUILD_TEXT';
    }
    if (kind === 'category') return ChannelType.GuildCategory;
    if (kind === 'voice') return ChannelType.GuildVoice;
    if (kind === 'thread') return ChannelType.PublicThread;
    return ChannelType.GuildText;
}

function isBotRuntime(client) {
    return normalizeTokenType(client?.__agentTokenType) === 'bot';
}

function isUserRuntime(client) {
    return normalizeTokenType(client?.__agentTokenType) === 'user';
}

module.exports = {
    normalizeTokenType,
    createDiscordClient,
    isTextChannel,
    isVoiceChannel,
    isCategoryChannel,
    isThreadChannel,
    channelCreateType,
    isBotRuntime,
    isUserRuntime,
};