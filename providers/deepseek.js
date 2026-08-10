/**
 * DeepSeek provider extracted from utils.js.
 */
'use strict';

const axios = require('axios');
const { DEEPSEEK_TOKEN, RAILWAY_URL, POW_PROXY_TELEGRAM } = require('../config');
const { get_pow_provider } = require('../utils');

// ══════════════════════════════════════════════════════════════
//  DeepSeek Provider — دوال DeepSeek المساعدة
// ══════════════════════════════════════════════════════════════

/** يولّد device ID عشوائي */
function _device_id() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let i = 0; i < 88; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

/** يولّد rangers ID */
function _rangers_id() {
    const ts = BigInt(Date.now());
    const rv = BigInt(Math.floor(Math.random() * (9_999_999_999 - 1_000_000_000)) + 1_000_000_000);
    return String((ts << 32n) | rv);
}

/** يجيب offset المنطقة الزمنية */
function _tz_offset() {
    return String(-Math.round(new Date().getTimezoneOffset() * 60));
}

/**
 * يبني headers لطلبات DeepSeek
 * @param {string} powResponse
 * @param {string} token
 * @returns {object}
 */
function _build_headers(powResponse, token) {
    return {
        'User-Agent'               : 'DeepSeek/2.1.1 Android/36',
        'Accept'                   : 'application/json',
        'Accept-Encoding'          : 'gzip',
        'Content-Type'             : 'application/json',
        'x-client-platform'        : 'android',
        'x-client-version'         : '2.1.1',
        'x-client-locale'          : 'ar',
        'x-client-bundle-id'       : 'com.deepseek.chat',
        'x-rangers-id'             : _rangers_id(),
        'x-client-timezone-offset' : _tz_offset(),
        'x-device-id'              : _device_id(),
        'x-os-version'             : '30',
        'x-app-version'            : '2.1.1',
        'Authorization'            : `Bearer ${token}`,
        'X-DS-PoW-Response'        : powResponse,
        'accept-charset'           : 'UTF-8',
    };
}

/**
 * يجلب POW token من المزود المناسب
 * @param {string} guildId
 * @returns {Promise<{pow_response: string, pow_data: any}>}
 */
async function _get_pow(guildId, token = DEEPSEEK_TOKEN, agent_id = 'default') {
    const provider = await get_pow_provider(guildId, agent_id);

    if (provider === 'telegram') {
        const encodedToken = encodeURIComponent(token);
        const url = `${POW_PROXY_TELEGRAM}/get_pow?authorization=${encodedToken}`;
        try {
            const resp = await axios.get(url, { timeout: 15000 });
            if (resp.status === 200) {
                const data = resp.data;
                const pr   = data.x_ds_pow_response || data.pow_response;
                if (pr) return { pow_response: pr, pow_data: data.solved_json || null };
            }
        } catch (_) {}
        throw new Error('POW fetch failed (telegram proxy)');
    }

    // railway (افتراضي)
    const powUrl = `${RAILWAY_URL}/pow`;
    const urls   = [`${powUrl}?authorization=${token}`, powUrl];
    for (const url of urls) {
        try {
            const resp = await axios.get(url, { timeout: 15000 });
            if (resp.status === 200) {
                const data = resp.data;
                const pr   = data.x_ds_pow_response || data.pow_response;
                if (pr) return { pow_response: pr, pow_data: data.solved_json || null };
            }
        } catch (_) {
            continue;
        }
    }
    throw new Error('POW fetch failed (railway)');
}

/**
 * ينشئ جلسة DeepSeek جديدة
 * @returns {Promise<string>} session_id
 */
async function _new_ds_session(token = DEEPSEEK_TOKEN) {
    const url   = 'https://chat.deepseek.com/api/v0/chat_session/create';
    const hdrs  = {
        'x-client-bundle-id'       : 'com.deepseek.chat',
        'x-client-platform'        : 'web',
        'x-client-version'         : '2.0.0',
        'x-client-locale'          : 'en_US',
        'x-client-timezone-offset' : _tz_offset(),
        'x-app-version'            : '2.0.0',
        'Authorization'            : `Bearer ${token}`,
        'Content-Type'             : 'application/json',
        'Accept'                   : '*/*',
    };
    const resp = await axios.post(url, {}, { headers: hdrs });
    const sid  = resp.data?.data?.biz_data?.chat_session?.id;
    if (!sid) throw new Error(`Bad session response: ${JSON.stringify(resp.data)}`);
    return sid;
}

/**
 * يزيل التفكير وبعض الرموز غير المرغوبة من نص الرد
 * @param {string} text
 * @returns {string}
 */
function _strip(text) {
    text = text.replace(/\bFINISHEDSEARCH\b|\bFINISHED\b/gi, '');
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    text = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1');
    return text.trim();
}

/**
 * يرسل prompt لـ DeepSeek ويجمع الرد المتدفق (streaming)
 * @param {string} prompt
 * @param {string} guildId
 * @param {string|null} sessionId
 * @param {string|null} parentMessageId
 * @param {string} mode - 'default' أو 'expert'
 * @param {boolean} thinking
 * @returns {Promise<{fullText: string, sessionId: string, newParentMessageId: string|null}>}
 */
async function _stream_ds(prompt, guildId, sessionId = null, parentMessageId = null, mode = 'default', thinking = false, deepseekToken = DEEPSEEK_TOKEN, agent_id = 'default') {
    const token = deepseekToken;
    if (!token) throw new Error('DEEPSEEK_TOKEN not set');

    if (!sessionId) sessionId = await _new_ds_session(token);

    const powD = await _get_pow(guildId, token, agent_id);
    const hdrs = _build_headers(powD.pow_response, token);

    const modelType = (mode === 'expert') ? 'expert' : 'default';
    const payload   = {
        chat_session_id   : sessionId,
        parent_message_id : parentMessageId,
        prompt            : prompt,
        ref_file_ids      : [],
        thinking_enabled  : Boolean(thinking),
        search_enabled    : false,
        model_type        : modelType,
        action            : null,
        preempt           : false,
        stream            : true,
    };
    if (powD.pow_data !== null && powD.pow_data !== undefined) {
        payload.pow = powD.pow_data;
    }

    let fullText    = '';
    let newPmid     = null;

    // streaming request باستخدام axios responseType: 'stream'
    const response = await axios.post(
        'https://chat.deepseek.com/api/v0/chat/completion',
        payload,
        {
            headers      : hdrs,
            timeout      : 120_000,
            responseType : 'stream',
        },
    );

    if (response.status === 429) {
        throw new Error('⏳ DeepSeek مزدحم حالياً، حاول مرة أخرى بعد لحظة.');
    }
    if (response.status !== 200) {
        throw new Error(`DS ${response.status}`);
    }

    // معالجة الـ stream سطراً بسطر
    await new Promise((resolve, reject) => {
        let buf = '';
        response.data.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line.startsWith('data: ')) continue;
                try {
                    const d = JSON.parse(line.slice(6));
                    if (newPmid === null && d.response_message_id) {
                        newPmid = d.response_message_id;
                    }
                    const v = d.v;
                    if (v && typeof v === 'object') {
                        const frags = v.response?.fragments || [];
                        for (const frag of frags) {
                            const ftype = (frag.type || '').toUpperCase();
                            if (ftype === 'RESPONSE') {
                                fullText += frag.content || '';
                            }
                        }
                    } else if (typeof v === 'string') {
                        fullText += v;
                    }
                } catch (_) {}
            }
        });
        response.data.on('end', resolve);
        response.data.on('error', reject);
    });

    return {
        fullText       : _strip(fullText),
        sessionId      : sessionId,
        newParentMessageId : newPmid,
    };
}


module.exports = {
    _device_id,
    _rangers_id,
    _tz_offset,
    _build_headers,
    _get_pow,
    _new_ds_session,
    _strip,
    _stream_ds,
    async chat(config = {}, prompt, context = {}) {
        const credentials = config.credentials || {};
        const token = credentials.token || credentials.deepseek_token || config.token;
        const mode = config.model || context.mode || 'default';
        const result = await _stream_ds(prompt, context.guildId, context.sessionId || null, context.parentId || null, mode, context.thinking || false, token, context.agentId || 'default');
        return { fullText: result.fullText, sessionId: result.sessionId, parentMessageId: result.newParentMessageId };
    },
};
