'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { QWEN_BASE_URL } = require('../config');

const DEFAULTS = Object.freeze({
    deviceId: process.env.QWEN_DEVICE_ID || 'ai41028e1f8c77e8b2786e747bbb688d45',
    miniWuaNew: process.env.QWEN_MINI_WUA_NEW || 'aFgR23MLtqLGGJyrcbapgd+3XceWqBxoJgwW5OfWJyoy3xEC7dShaw+ngiFDudGDdY6tt1kIeyR2PVktTjGdU3Bq8hFdQ4COyBLsSGPWyu6LrCN93vNCG600RwsH2PZgTpNQVxwdd5WDtQJl/bbuWLjXYRlDIHL+VeV7aQR6TkveYD25QvPjRymkV',
    miniWuaChat: process.env.QWEN_MINI_WUA_CHAT || 'amQS4zB7f+nI4zFIidbQfWJS4DFq6eY/JGTsMp6g0eEgI1hW/WjAixbY00rXCEfaU1m0k8YFrAS7FdfKBfhdNv3tVDb9W9lKxCkU9N7WoxP6NBjjq7KDfBtkYRQwFDVeAnTLV3as78GbA/GIYRwe/sGfa+Ec4kEd6w8P5tnHKvatdiI6yyDOBdQyG',
    appWaf: process.env.QWEN_APP_WAF || 'Z9Tr56YmQpXcO2K_d_3nAbJvRqMLFW8HTNjvRguWHEowM1xY',
    uaNew: 'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2),Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite',
    uaChat: 'Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2) AliApp(QWENCHAT/2.7.2) AppType/Release AplusBridgeLite,Dalvik/2.1.0 (Linux; U; Android 15; RMX3834 Build/AP3A.240905.015.A2)',
});

function uuid() { return crypto.randomUUID(); }
function cookieHeader(credentials = {}) {
    const cookies = { 'x-ap': 'eu-central-1', acw_tc: '0a03e58c17857397926041890e494252933302e11e7e13facd87298e0a89a3', ...(credentials.cookies || {}) };
    const token = credentials.auth_token || credentials.authToken || credentials.token;
    if (token) cookies.token = token;
    return Object.entries(cookies).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
}
function headers(kind, credentials = {}, stream = false) {
    const authToken = credentials.auth_token || credentials.authToken || credentials.token;
    const deviceId = credentials.device_id && credentials.device_id !== 'auto' ? credentials.device_id : DEFAULTS.deviceId;
    const h = {
        'X-Platform': 'android',
        Accept: stream ? '*/*,text/event-stream' : 'application/json',
        'User-Agent': kind === 'chat' ? DEFAULTS.uaChat : DEFAULTS.uaNew,
        'x-device-id': deviceId,
        source: 'app',
        'x-mini-wua': kind === 'chat' ? DEFAULTS.miniWuaChat : DEFAULTS.miniWuaNew,
        'x-request-id': uuid(),
        'Accept-Language': 'en-US',
        'Accept-Charset': 'UTF-8',
        'Content-Type': kind === 'chat' ? 'application/json; charset=UTF-8' : 'application/json',
        Host: new URL(QWEN_BASE_URL).host,
        Connection: 'Keep-Alive',
        'Accept-Encoding': 'gzip, deflate',
        Cookie: cookieHeader(credentials),
    };
    if (kind === 'chat') { h['Cache-Control'] = 'no-store'; h.app_waf = DEFAULTS.appWaf; }
    if (authToken) h.Authorization = `Bearer ${authToken}`;
    return h;
}
async function newChat(credentials) {
    console.log('[providers/qwen] creating new chat session');
    const resp = await axios.post(`${QWEN_BASE_URL}/api/v2/chats/new`, { chat_mode: 'normal', project_id: '' }, { headers: headers('new', credentials), timeout: 120000 });
    const data = resp.data || {};
    const id = data.chat_id || data.id || data.data?.chat_id || data.data?.id;
    if (!id) throw new Error(`Qwen لم يرجع chat_id: ${JSON.stringify(data).slice(0, 500)}`);
    return id;
}
function textPayload(chatId, prompt, model, parentId, thinking) {
    const ts = Math.floor(Date.now() / 1000);
    const msg = { id: null, fid: uuid(), chat_type: 't2t', content: prompt, role: 'user', feature_config: { thinking_enabled: Boolean(thinking), output_schema: 'phase', research_mode: 'normal', auto_thinking: Boolean(thinking), thinking_mode: thinking ? 'Deep' : 'Fast', thinking_format: 'summary', auto_search: true }, timestamp: ts, sub_chat_type: 't2t', models: [model], model: '', files: [], user_action: 'chat', extra: { meta: { subChatType: 't2t' } }, parentId: parentId || null, parent_id: parentId || null };
    return { stream: true, version: '2.1', incremental_output: true, chatId, chat_id: chatId, chat_mode: 'normal', model, messages: [msg], timestamp: ts, parentId: parentId || '', parent_id: parentId || null };
}
function getPath(obj, path) { let cur = obj; for (const k of path) { if (Number.isInteger(k) && Array.isArray(cur) && cur.length > k) cur = cur[k]; else if (cur && typeof cur === 'object' && k in cur) cur = cur[k]; else return ''; } return typeof cur === 'string' ? cur : ''; }
function extractText(obj) {
    if (!obj) return ''; if (typeof obj === 'string') return obj; if (Array.isArray(obj)) return obj.map(extractText).join(''); if (typeof obj !== 'object') return '';
    for (const p of [['choices',0,'delta','content'],['choices',0,'message','content'],['data','choices',0,'delta','content'],['data','choices',0,'message','content'],['message','content'],['delta','content'],['data','content'],['content'],['answer'],['output','text'],['text']]) { const v = getPath(obj, p); if (v) return v; }
    for (const k of ['messages','contents','items','events','phases','data']) { const v = extractText(obj[k]); if (v) return v; }
    return '';
}
async function parseStream(stream) {
    let fullText = '', parentMessageId = null, buf = '';
    await new Promise((resolve, reject) => {
        stream.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let idx; while ((idx = buf.indexOf('\n')) !== -1) {
                let line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
                if (!line) continue; if (line.startsWith('data:')) line = line.slice(5).trim(); if (line === '[DONE]' || line === 'done') continue;
                try { const obj = JSON.parse(line); const created = obj['response.created']; if (created?.response_id) parentMessageId = created.response_id; if (obj.response_id) parentMessageId = obj.response_id; fullText += extractText(obj); } catch (_) {}
            }
        });
        stream.on('end', resolve); stream.on('error', reject);
    });
    return { fullText: fullText.trim(), parentMessageId };
}
async function chat(config = {}, prompt, context = {}) {
    const credentials = config.credentials || {};
    const model = config.model && config.model !== 'default' ? config.model : 'qwen3.8-max';
    const sessionId = context.sessionId || await newChat(credentials);
    const payload = textPayload(sessionId, prompt, model, context.parentId || null, context.thinking || false);
    const resp = await axios.post(`${QWEN_BASE_URL}/api/v2/chat/completions`, payload, { params: { chat_id: sessionId }, headers: headers('chat', credentials, true), timeout: 120000, responseType: 'stream' });
    const parsed = await parseStream(resp.data);
    return { fullText: parsed.fullText, sessionId, parentMessageId: parsed.parentMessageId || context.parentId || null };
}
module.exports = { chat, newChat, headers, textPayload, extractText };
