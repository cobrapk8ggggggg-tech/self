/**
 * providers/index.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * ModelProvider الرئيسي: يوزع الطلبات على المزودين (DeepSeek, Qwen)
 * واجهة موحدة لـ agent.js مع إمكانية إضافة مزودين جدد بسهولة
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const deepseek = require('./deepseek');
const qwen = require('./qwen');

/**
 * دالة chat الرئيسية الموحدة
 * @param {object} config - { provider, model, credentials }
 * @param {string} prompt - البرومبت الكامل (system + user + tools)
 * @param {object} context - { guildId, sessionId, parentId, thinking, mode }
 * @returns {Promise<{ fullText: string, sessionId: string, parentMessageId: string }>}
 */
async function chat(config, prompt, context) {
    const provider = config.provider || 'deepseek';
    const model = config.model || 'default';
    const credentials = config.credentials || {};
    
    console.log('[ModelProvider] Routing request:', { 
        provider, 
        model, 
        context: { 
            guildId: context.guildId, 
            sessionId: context.sessionId ? 'exists' : 'null',
            parentId: context.parentId ? 'exists' : 'null',
            thinking: context.thinking,
            mode: context.mode 
        } 
    });
    
    try {
        switch (provider) {
            case 'deepseek': {
                // استخراج token من credentials
                const token = credentials.token || credentials.deepseek_token;
                if (!token) {
                    throw new Error('DeepSeek token غير موجود في credentials');
                }
                
                console.log('[ModelProvider] Calling DeepSeek provider...');
                
                const result = await deepseek._stream_ds(
                    prompt,
                    context.guildId,
                    context.sessionId || null,
                    context.parentId || null,
                    context.mode || 'default',
                    Boolean(context.thinking),
                    token,
                    context.agentId || 'default'
                );
                
                console.log('[ModelProvider] DeepSeek response:', {
                    sessionId: result.sessionId,
                    parentMessageId: result.newParentMessageId,
                    textLength: result.fullText.length
                });
                
                return {
                    fullText: result.fullText,
                    sessionId: result.sessionId,
                    parentMessageId: result.newParentMessageId,
                };
            }
            
            case 'qwen': {
                // استخراج auth_token من credentials
                const authToken = credentials.auth_token || credentials.token;
                if (!authToken) {
                    throw new Error('Qwen auth_token غير موجود في credentials');
                }
                
                console.log('[ModelProvider] Calling Qwen provider...');
                
                const result = await qwen.chat(
                    {
                        auth_token: authToken,
                        device_id: credentials.device_id,
                        cookies_str: credentials.cookies_str,
                        base_url: credentials.base_url,
                    },
                    prompt,
                    {
                        guildId: context.guildId,
                        sessionId: context.sessionId,
                        parentId: context.parentId,
                        thinking: context.thinking,
                        mode: context.mode,
                    }
                );
                
                console.log('[ModelProvider] Qwen response:', {
                    sessionId: result.sessionId,
                    parentMessageId: result.parentMessageId,
                    textLength: result.fullText.length
                });
                
                return {
                    fullText: result.fullText,
                    sessionId: result.sessionId,
                    parentMessageId: result.parentMessageId,
                };
            }
            
            default:
                throw new Error(`مزود AI غير مدعوم: ${provider}. المزودات المتاحة: deepseek, qwen`);
        }
    } catch (error) {
        console.error('[ModelProvider] Error:', {
            provider,
            error: error.message,
            stack: error.stack?.split('\n').slice(0, 5).join('\n')
        });
        throw error;
    }
}

/**
 * يسجل مزود جديد
 * @param {string} name - اسم المزود
 * @param {object} module - модуль المزود الذي يحتوي على دالة chat
 */
function registerProvider(name, module) {
    console.log(`[ModelProvider] Registering new provider: ${name}`);
    // يمكن استخدام هذا مستقبلاً لإضافة مزودين ديناميكياً
    if (name === 'deepseek') {
        Object.assign(deepseek, module);
    } else if (name === 'qwen') {
        Object.assign(qwen, module);
    }
}

module.exports = {
    chat,
    registerProvider,
    deepseek,
    qwen,
};
