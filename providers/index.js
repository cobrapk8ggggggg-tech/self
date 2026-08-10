'use strict';

const deepseek = require('./deepseek');
const qwen = require('./qwen');

const PROVIDERS = Object.freeze({ deepseek, qwen });

function normalizeConfig(config = {}) {
    if (!config || typeof config !== 'object') return { provider: 'deepseek', model: 'default', credentials: {} };
    return {
        provider: String(config.provider || 'deepseek').toLowerCase(),
        model: config.model || 'default',
        credentials: config.credentials || {},
    };
}

/**
 * @param {object} config - { provider, model, credentials }
 * @param {string} prompt - البرومبت الكامل (system + user + tools)
 * @param {object} context - { guildId, sessionId, parentId, thinking, mode }
 * @returns {Promise<{ fullText: string, sessionId: string, parentMessageId: string }>}
 */
async function chat(config, prompt, context = {}) {
    const normalized = normalizeConfig(config);
    const provider = PROVIDERS[normalized.provider];
    if (!provider?.chat) throw new Error(`مزود النموذج غير مدعوم: ${normalized.provider}`);
    console.log(`[providers] chat provider=${normalized.provider} model=${normalized.model} session=${context.sessionId || 'new'}`);
    return provider.chat(normalized, prompt, context);
}

module.exports = { chat, normalizeConfig, PROVIDERS };
