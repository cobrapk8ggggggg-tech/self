/**
 * providers/qwen.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * ترجمة كاملة لمنطق qwen.py إلى Node.js باستخدام axios
 * يحافظ على: الجلسة (chat_id)، parent_id للتسلسل، Headers (WUA, APP WAF, Device-ID, Cookies)، Streaming
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

class QwenAPI {
    constructor(config = {}) {
        this.BASE = config.base_url || process.env.QWEN_BASE_URL || 'https://chat.qwen.ai';
        this.DEVICE_ID = config.device_id || process.env.QWEN_DEVICE_ID || 'ai41028e1f8c77e8b2786e747bbb688d45';
        this.MINI_WUA_NEW = config.mini_wua_new || process.env.QWEN_MINI_WUA_NEW || 'aFgR23MLtqLGGJyrcbapgd+3XceWqBxoJgwW5OfWJyoy3xEC7dShaw+ngiFDudGDdY6tt1kIeyR2PVktTjGdU3Bq8hFdQ4COyBLsSGPWyu6LrCN93vNCG600RwsH2PZgTpNQVxwdd5WDtQJl/bbuWLjXYRlDIHL+VeV7aQR6TkveYD25QvPjRymkV';
        this.MINI_WUA_CHAT = config.mini_wua_chat || process.env.QWEN_MINI_WUA_CHAT || 'amQS4zB7f+nI4zFIidbQfWJS4DFq6eY/JGTsMp6g0eEgI1hW/WjAixbY00rXCEfaU1m0k8YFrAS7FdfKBfhdNv3tVDb9W9lKxCkU9N7WoxP6NBjjq7KDfBtkYRQwFDVeAnTLV3as78GbA/GIYRwe/sGfa+Ec4kEd6w8P5tnHKvatdiI6yyDOBdQyG';
        this.APP_WAF = config.app_waf || process.env.QWEN_APP_WAF || 'Z9Tr56YmQpXcO2K_d_3nAbJvRqMLFW8HTNjvRguWHEowM1xY';
        this.AUTH_TOKEN = config.auth_token;
        this.UA_NEW = 'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2),Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite';
        this.UA_CHAT = 'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite,Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2)';
        
        this.thinking_enabled = true;
        this.auto_search = true;
        this.last_response_id = null;
        this.last_created_parent_id = null;
        
        // تحليل cookies إذا كانت موجودة
        this.cookies = {};
        if (config.cookies_str) {
            const parts = config.cookies_str.split(';');
            for (const part of parts) {
                if (part.includes('=')) {
                    const [k, v] = part.trim().split('=', 2);
                    this.cookies[k] = v;
                }
            }
        }
        this.cookies['x-ap'] = this.cookies['x-ap'] || 'eu-central-1';
        this.cookies['acw_tc'] = this.cookies['acw_tc'] || '0a03e58c17857397926041890e494252933302e11e7e13facd87298e0a89a3';
        if (this.AUTH_TOKEN) {
            this.cookies['token'] = this.AUTH_TOKEN;
        }
        
        // إنشاء axios instance مع cookies
        this.session = axios.create({
            baseURL: this.BASE,
            headers: { 'Content-Type': 'application/json' },
        });
        
        // تعيين cookies للـ session
        const cookieHeader = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        this.session.defaults.headers.common['Cookie'] = cookieHeader;
    }
    
    /**
     * يبني headers حسب نوع الطلب
     * @param {'new'|'chat'} kind
     * @param {boolean} auth
     * @param {boolean} stream
     * @returns {object}
     */
    _headers(kind = 'chat', auth = false, stream = false) {
        const h = {
            'X-Platform': 'android',
            'Accept': stream ? '*/*,text/event-stream' : 'application/json',
            'User-Agent': kind === 'chat' ? this.UA_CHAT : this.UA_NEW,
            'x-device-id': this.DEVICE_ID,
            'source': 'app',
            'x-mini-wua': kind === 'chat' ? this.MINI_WUA_CHAT : this.MINI_WUA_NEW,
            'x-request-id': uuidv4(),
            'Accept-Language': 'en-US',
            'Accept-Charset': 'UTF-8',
            'Content-Type': kind === 'chat' ? 'application/json; charset=UTF-8' : 'application/json',
            'Host': 'chat.qwen.ai',
            'Connection': 'Keep-Alive',
            'Accept-Encoding': 'gzip, deflate',
        };
        
        if (kind === 'chat') {
            h['Cache-Control'] = 'no-store';
            h['app_waf'] = this.APP_WAF;
        }
        
        if (auth && this.AUTH_TOKEN) {
            h['Authorization'] = 'Bearer ' + this.AUTH_TOKEN;
        }
        
        return h;
    }
    
    /**
     * ينشئ محادثة جديدة
     * @param {string} mode
     * @returns {Promise<string>} chat_id
     */
    async new_chat(mode = 'normal') {
        const url = this.BASE + '/api/v2/chats/new';
        const payload = { chat_mode: 'normal', project_id: '' };
        const headers = this._headers('new', true);
        headers['Accept'] = 'application/json';
        headers['Accept-Encoding'] = 'gzip';
        headers['X-Platform'] = 'android';
        
        const resp = await this.session.post(url, payload, { headers });
        const data = resp.data;
        const cid = data?.chat_id || data?.id || data?.data?.chat_id || data?.data?.id;
        
        if (!cid) {
            throw new Error('لم أجد chat_id في الرد: ' + JSON.stringify(data).slice(0, 1000));
        }
        
        return cid;
    }
    
    /**
     * يجلب معلومات المحادثة
     * @param {string} chat_id
     * @param {number} limit
     * @returns {Promise<object>}
     */
    async get_chat(chat_id, limit = 6) {
        const url = `${this.BASE}/api/v2/chats/${chat_id}?direction=up&limit=${limit}`;
        const resp = await this.session.get(url, { headers: this._headers('new'), timeout: 60000 });
        if (resp.status >= 400) {
            throw new Error(`HTTP ${resp.status}: ${resp.data?.toString?.().slice(0, 1000) || String(resp.data)}`);
        }
        return resp.data;
    }
    
    /**
     * يجيب currentId من المحادثة
     * @param {string} chat_id
     * @returns {Promise<string|null>}
     */
    async get_current_id(chat_id) {
        try {
            const data = await this.get_chat(chat_id);
            const d = data.data || {};
            let cur = d.currentId || d.chat?.history?.currentId;
            
            if (cur) return cur;
            
            const msgs = d.chat?.messages || [];
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (m && typeof m === 'object' && m.role === 'assistant' && m.id) {
                    return m.id;
                }
            }
            for (let i = msgs.length - 1; i >= 0; i--) {
                const m = msgs[i];
                if (m && typeof m === 'object' && m.id) {
                    return m.id;
                }
            }
        } catch (_) {
            return null;
        }
        return null;
    }
    
    /**
     * يبني payload لرسالة نصية
     * @param {string} chat_id
     * @param {string} prompt
     * @param {boolean} stream
     * @param {string} model
     * @param {string|null} parent_id
     * @returns {object}
     */
    text_payload(chat_id, prompt, stream = true, model = 'qwen3.8-max', parent_id = null) {
        const ts = Math.floor(Date.now() / 1000);
        const fid = uuidv4();
        
        const msg = {
            id: null,
            fid: fid,
            chat_type: 't2t',
            content: prompt,
            role: 'user',
            feature_config: {
                thinking_enabled: this.thinking_enabled,
                output_schema: 'phase',
                research_mode: 'normal',
                auto_thinking: this.thinking_enabled,
                thinking_mode: this.thinking_enabled ? 'Deep' : 'Fast',
                thinking_format: 'summary',
                auto_search: this.auto_search,
            },
            timestamp: ts,
            sub_chat_type: 't2t',
            models: [model],
            model: '',
            files: [],
            user_action: 'chat',
            extra: { meta: { subChatType: 't2t' } },
        };
        
        const payload = {
            stream: stream,
            version: '2.1',
            incremental_output: true,
            chatId: chat_id,
            chat_id: chat_id,
            chat_mode: 'normal',
            model: model,
            messages: [msg],
            timestamp: ts,
        };
        
        // بعد أول رد: parent هو response_id/currentId السابق
        if (parent_id) {
            msg.parentId = parent_id;
            msg.parent_id = parent_id;
            payload.parentId = parent_id;
            payload.parent_id = parent_id;
        } else {
            payload.parentId = '';
            payload.parent_id = null;
            msg.parentId = null;
            msg.parent_id = null;
        }
        
        return payload;
    }
    
    /**
     * يستخرج النص من كائن SSE
     * @param {any} obj
     * @returns {string}
     */
    extract_text(obj) {
        if (obj === null || obj === undefined) return '';
        if (typeof obj === 'string') return obj;
        if (Array.isArray(obj)) return obj.map(x => this.extract_text(x)).join('');
        if (typeof obj !== 'object') return '';
        
        // مسارات شائعة لاستخراج النص
        const paths = [
            ['choices', 0, 'delta', 'content'],
            ['choices', 0, 'message', 'content'],
            ['data', 'choices', 0, 'delta', 'content'],
            ['data', 'choices', 0, 'message', 'content'],
            ['message', 'content'],
            ['delta', 'content'],
            ['data', 'content'],
            ['content'],
            ['answer'],
            ['output', 'text'],
            ['text'],
        ];
        
        for (const path of paths) {
            let cur = obj;
            let ok = true;
            for (const k of path) {
                if (typeof k === 'number' && Array.isArray(cur) && cur.length > k) {
                    cur = cur[k];
                } else if (typeof k === 'string' && typeof cur === 'object' && k in cur) {
                    cur = cur[k];
                } else {
                    ok = false;
                    break;
                }
            }
            if (ok && typeof cur === 'string' && cur) {
                return cur;
            }
        }
        
        // Qwen أحياناً يرسل phases/events
        for (const key of ['messages', 'contents', 'items', 'events', 'phases', 'data']) {
            if (key in obj) {
                const txt = this.extract_text(obj[key]);
                if (txt) return txt;
            }
        }
        
        return '';
    }
    
    /**
     * يرسل prompt ويستقبل streaming response
     * @param {string} chat_id
     * @param {string} prompt
     * @param {boolean} stream
     * @param {string} model
     * @param {string|null} parent_id
     * @returns {Promise<{fullText: string, sessionId: string, parentMessageId: string|null}>}
     */
    async chat(chat_id, prompt, stream = true, model = 'qwen3.8-max', parent_id = null) {
        const url = `${this.BASE}/api/v2/chat/completions`;
        const payload = this.text_payload(chat_id, prompt, stream, model, parent_id);
        const headers = this._headers('chat', true, stream);
        
        console.log('[Qwen] Sending chat request:', { chat_id, model, parent_id, prompt_len: prompt.length });
        
        const response = await this.session.post(url, payload, {
            headers,
            params: { chat_id },
            responseType: stream ? 'stream' : 'json',
            timeout: 120000,
        });
        
        if (response.status >= 400) {
            throw new Error(`HTTP ${response.status}: ${response.data?.toString?.().slice(0, 1000) || String(response.data)}`);
        }
        
        if (!stream) {
            const data = response.data;
            const text = this.extract_text(data);
            return {
                fullText: text,
                sessionId: chat_id,
                parentMessageId: parent_id,
            };
        }
        
        // معالجة streaming
        let fullText = '';
        let response_id = null;
        let created_parent_id = null;
        
        await new Promise((resolve, reject) => {
            let buf = '';
            
            response.data.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                let idx;
                while ((idx = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    
                    if (!line) continue;
                    
                    let dataLine = line;
                    if (dataLine.startsWith('data:')) {
                        dataLine = dataLine.slice(5).trim();
                    }
                    
                    if (dataLine === '[DONE]' || dataLine === 'done') {
                        response.data.removeAllListeners();
                        resolve();
                        return;
                    }
                    
                    try {
                        const obj = JSON.parse(dataLine);
                        
                        // استخراج response_id و parent_id
                        if (typeof obj === 'object') {
                            const created = obj['response.created'];
                            if (created && typeof created === 'object' && created.response_id) {
                                response_id = created.response_id;
                                created_parent_id = created.parent_id;
                            }
                            if (obj.response_id) {
                                response_id = obj.response_id;
                            }
                        }
                        
                        const txt = this.extract_text(obj);
                        if (txt) {
                            fullText += txt;
                        }
                    } catch (_) {
                        // تجاهل الأخطاء في parsing
                    }
                }
            });
            
            response.data.on('end', () => {
                resolve();
            });
            
            response.data.on('error', reject);
        });
        
        this.last_response_id = response_id;
        this.last_created_parent_id = created_parent_id;
        
        console.log('[Qwen] Chat completed:', { chat_id, response_id, created_parent_id, text_len: fullText.length });
        
        return {
            fullText: fullText,
            sessionId: chat_id,
            parentMessageId: response_id || created_parent_id || parent_id,
        };
    }
}

/**
 * دالة chat الرئيسية التي تستدعيها agents
 * @param {object} credentials - { auth_token, device_id?, cookies_str?, base_url? }
 * @param {string} prompt
 * @param {object} context - { guildId, sessionId, parentId, thinking, mode }
 * @returns {Promise<{ fullText: string, sessionId: string, parentMessageId: string }>}
 */
async function chat(credentials, prompt, context) {
    const { guildId, sessionId, parentId, thinking, mode } = context;
    
    console.log('[Qwen Provider] Starting chat:', { guildId, sessionId, parentId, thinking, mode });
    
    // إنشاء instance من QwenAPI
    const api = new QwenAPI({
        auth_token: credentials.auth_token,
        device_id: credentials.device_id,
        cookies_str: credentials.cookies_str,
        base_url: credentials.base_url,
    });
    
    // تفعيل/تعطيل التفكير
    api.thinking_enabled = thinking !== false;
    
    // استخدام sessionId كـ chat_id، أو إنشاء جديد
    let chat_id = sessionId;
    if (!chat_id) {
        console.log('[Qwen Provider] Creating new chat session...');
        chat_id = await api.new_chat('normal');
        console.log('[Qwen Provider] New chat_id:', chat_id);
    }
    
    // تحديد الموديل حسب mode
    let model = 'qwen3.8-max';
    if (mode === 'expert' || mode === 'qwen-max') {
        model = 'qwen3.8-max';
    } else if (mode === 'qwen-plus') {
        model = 'qwen-plus';
    }
    
    // إرسال الطلب
    const result = await api.chat(chat_id, prompt, true, model, parentId || null);
    
    console.log('[Qwen Provider] Chat result:', { 
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

module.exports = {
    QwenAPI,
    chat,
};
