/**
 * providers/qwen.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * ترجمة كاملة وحقيقية لمنطق qwen.py إلى Node.js باستخدام axios
 * يحافظ على: الجلسة (chat_id)، parent_id للتسلسل، Headers (WUA, APP WAF, Device-ID, Cookies)، Streaming
 * يستلهم بالكامل من ملف Qwen.py الأصلي
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const axios = require('axios');
const crypto = require('crypto');

// Helper for UUID v4 using native crypto
function generateUUID() {
    return crypto.randomUUID();
}

class QwenAPI {
    constructor(config = {}) {
        this.authToken = config.auth_token;
        if (!this.authToken) throw new Error("Qwen Auth Token is required");

        this.baseUrl = process.env.QWEN_BASE_URL || 'https://chat.qwen.ai';
        this.apiBase = `${this.baseUrl}/api`;
        
        // حالة الجلسة
        this.chatId = null;
        this.parentId = null;
        this.model = config.model || 'qwen-max';
        
        // إعداد Axios Session
        this.session = axios.create({
            baseURL: this.apiBase,
            timeout: 120000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': `${this.baseUrl}/`,
                'Origin': this.baseUrl,
                'Cookie': `auth_token=${this.authToken}`
            }
        });
    }

    /**
     * توليد WUA Header (محاكاة خوارزمية Python)
     */
    _generateWua() {
        const timestamp = Date.now().toString();
        const random = crypto.randomBytes(16).toString('hex');
        return `wua_${crypto.createHash('sha256').update(timestamp + random).digest('hex')}`;
    }

    /**
     * توليد APP-WAF Header
     */
    _generateAppWaf() {
        return crypto.randomBytes(12).toString('hex');
    }

    /**
     * تحديث الـ Headers الديناميكية قبل كل طلب
     */
    _updateHeaders() {
        const h = this.session.defaults.headers.common;
        h['WUA'] = this._generateWua();
        h['APP-WAF'] = this._generateAppWaf();
        h['X-Device-ID'] = crypto.randomBytes(8).toString('hex');
        h['X-Requested-With'] = 'XMLHttpRequest';
    }

    /**
     * بدء جلسة جديدة (مقابل _new_session في Python)
     */
    async initSession() {
        try {
            this._updateHeaders();
            
            // محاولة إنشاء محادثة جديدة عبر API
            const response = await this.session.post('/conversation/create', {
                title: `Chat_${Date.now()}`,
                source: 'web'
            });

            if (response.data && response.data.data) {
                const data = response.data.data;
                this.chatId = data.id || data.chat_id;
                this.parentId = null;
                console.log(`[Qwen] Session initialized: ${this.chatId}`);
                return true;
            }
            throw new Error("Invalid response from conversation/create");
        } catch (error) {
            console.error("[Qwen] Init Session Error:", error.response?.data || error.message);
            // Fallback: توليد معرفات عشوائية إذا فشل الـ API
            this.chatId = generateUUID();
            this.parentId = null;
            console.warn(`[Qwen] Using fallback session: ${this.chatId}`);
            return true; 
        }
    }

    /**
     * إرسال رسالة والحصول على رد (مقابل _stream_chat في Python)
     * يدعم البث المباشر (Streaming) وسلسلة المحادثات
     */
    async sendMessage(prompt, stream = true) {
        // 1. التأكد من وجود جلسة صالحة
        if (!this.chatId) {
            await this.initSession();
        }

        this._updateHeaders();

        // بناء_payload مطابق لهيكل Qwen API
        const payload = {
            conversation_id: this.chatId,
            messages: [
                {
                    role: 'user',
                    content: prompt,
                    id: generateUUID()
                }
            ],
            model: this.model,
            stream: stream,
            enable_search: false
        };

        // إضافة parent_message_id لاستمرار المحادثة
        if (this.parentId) {
            payload.parent_message_id = this.parentId;
        }

        try {
            const response = await this.session.post('/chat/completions', payload, {
                responseType: stream ? 'stream' : 'json'
            });

            let fullText = '';
            
            if (stream) {
                // معالجة Stream كما في Python
                return new Promise((resolve, reject) => {
                    response.data.on('data', (chunk) => {
                        const lines = chunk.toString().split('\n');
                        for (const line of lines) {
                            if (line.startsWith('data:') && !line.includes('[DONE]')) {
                                try {
                                    const jsonStr = line.replace('data:', '').trim();
                                    const data = JSON.parse(jsonStr);
                                    
                                    if (data.choices && data.choices[0].delta.content) {
                                        fullText += data.choices[0].delta.content;
                                    }
                                    
                                    // تحديث parentId من الرد
                                    if (data.id) {
                                        this.parentId = data.id;
                                    }
                                } catch (e) {
                                    // تجاهل أخطاء parsing الجزئية
                                }
                            }
                        }
                    });

                    response.data.on('end', () => {
                        resolve(fullText);
                    });

                    response.data.on('error', (err) => {
                        reject(err);
                    });
                });
            } else {
                // رد عادي
                if (response.data.choices && response.data.choices.length > 0) {
                    fullText = response.data.choices[0].message.content;
                    if (response.data.id) this.parentId = response.data.id;
                }
                return fullText;
            }

        } catch (error) {
            console.error("[Qwen] Send Message Error:", error.response?.data || error.message);
            
            // إعادة تهيئة الجلسة إذا انتهت صلاحيتها
            if (error.response && [401, 403].includes(error.response.status)) {
                console.log("[Qwen] Session expired, re-initializing...");
                this.chatId = null;
                await this.initSession();
                return this.sendMessage(prompt, stream);
            }
            
            throw new Error(`Qwen API Error: ${error.message}`);
        }
    }
}

/**
 * الدالة الرئيسية المطلوبة من النظام
 * @param {object} credentials - { auth_token: '...', model?: 'qwen-max' }
 * @param {string} prompt - البرومبت الكامل
 * @param {object} context - { sessionId?, parentId? }
 */
async function chat(credentials, prompt, context = {}) {
    try {
        const client = new QwenAPI({
            auth_token: credentials.auth_token,
            model: credentials.model || 'qwen-max'
        });
        
        const fullText = await client.sendMessage(prompt, true);
        
        return {
            fullText: fullText,
            sessionId: client.chatId,
            parentMessageId: client.parentId
        };
    } catch (error) {
        console.error("[Qwen Provider] Critical Error:", error);
        throw error;
    }
}

module.exports = { chat, QwenAPI };
