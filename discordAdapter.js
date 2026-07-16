/**
 * discordAdapter.js — Disor Bot v7.0 "Ironclad" [FIXED]
 * ═══════════════════════════════════════════════════════════
 * الإصلاح: channelCreateType لـ user token كان يُرجع strings
 * مثل 'GUILD_TEXT' — discord.js-selfbot-v13 لا يعرف يحوّلها
 * لرقم صحيح فيكسر الـ request body ويجعل name=[Object].
 * الحل: إرجاع أرقام مباشرة في كلا الحالتين.
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
    return isType(channel, ChannelType.GuildText, 'GUILD_TEXT')
        || isType(channel, ChannelType.GuildAnnouncement, 'GUILD_NEWS')
        // selfbot-v13 يستخدم أرقام أحياناً
        || channel?.type === 0
        || channel?.type === 5;
}

function isVoiceChannel(channel) {
    return isType(channel, ChannelType.GuildVoice, 'GUILD_VOICE')
        || channel?.type === 2;
}

function isCategoryChannel(channel) {
    return isType(channel, ChannelType.GuildCategory, 'GUILD_CATEGORY')
        || channel?.type === 4;
}

function isThreadChannel(channel) {
    return String(channel?.type || '').includes('THREAD')
        || [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(channel?.type)
        || [10, 11, 12].includes(channel?.type);
}

/**
 * [FIXED] يُرجع رقم ChannelType دائماً — سواء bot أو user token.
 * discord.js-selfbot-v13 يتوقع رقم أو ChannelType enum،
 * وعند تمرير string مثل 'GUILD_TEXT' يكسر بناء الـ request body.
 *
 * أرقام Discord API الثابتة:
 *   0  = GUILD_TEXT
 *   2  = GUILD_VOICE
 *   4  = GUILD_CATEGORY
 *   11 = GUILD_PUBLIC_THREAD
 *   12 = GUILD_PRIVATE_THREAD
 */
function channelCreateType(kind, tokenType = 'bot') {
    switch (String(kind || '').toLowerCase()) {
        case 'category': return 4;   // GUILD_CATEGORY
        case 'voice':    return 2;   // GUILD_VOICE
        case 'thread':   return 11;  // GUILD_PUBLIC_THREAD
        default:         return 0;   // GUILD_TEXT
    }
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
