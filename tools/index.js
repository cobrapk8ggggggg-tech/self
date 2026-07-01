/**
 * tools/index.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * ملف التجميع وإعادة التصدير — Aggregator
 * يجمع جميع الدوال من الملفات الأربعة ويعيد تصديرها دفعة واحدة
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const readTools     = require('./readTools');
const executeAction = require('./executeAction');
const agent         = require('./agent');
const systemPrompt  = require('./systemPrompt');

module.exports = {
    // ── أدوات القراءة (readTools.js) ──
    ...readTools,

    // ── Execute + SafePurge (executeAction.js) ──
    ...executeAction,

    // ── Agent + JSON Extraction (agent.js) ──
    ...agent,

    // ── System Prompt (systemPrompt.js) ──
    ...systemPrompt,
};