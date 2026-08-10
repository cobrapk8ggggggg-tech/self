'use strict';

const deepseek = require('./deepseek');
const qwen = require('./qwen');

const PROVIDERS = Object.freeze({ deepseek, qwen });

const DEFAULT_METADATA = Object.freeze({
    displayName: 'Custom Provider',
    defaultModel: 'default',
    models: ['default'],
    capabilities: { modes: false, thinking: false, search: false, pow: false },
    credentialField: { key: 'token', label: 'Provider Token' },
});

function getProviderMeta(providerName = 'deepseek') {
    const provider = PROVIDERS[String(providerName || 'deepseek').toLowerCase()];
    return { ...DEFAULT_METADATA, ...(provider?.metadata || {}) };
}

function listProviders() {
    return Object.entries(PROVIDERS).map(([name, provider]) => ({ name, ...getProviderMeta(name), ...(provider.metadata || {}) }));
}

function normalizeConfig(config = {}) {
    if (!config || typeof config !== 'object') return { provider: 'deepseek', model: getProviderMeta('deepseek').defaultModel, credentials: {} };
    const provider = String(config.provider || 'deepseek').toLowerCase();
    const meta = getProviderMeta(provider);
    return {
        provider,
        model: config.model || meta.defaultModel || 'default',
        credentials: config.credentials || {},
        options: config.options || {},
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

module.exports = { chat, normalizeConfig, getProviderMeta, listProviders, PROVIDERS };
