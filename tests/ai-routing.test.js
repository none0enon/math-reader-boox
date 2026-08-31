'use strict';

// index.html 是单文件应用，没法直接 require。这里按函数名把渠道路由相关的函数原样抠出来，
// 配上假的 fetch 跑一遍，保证“自定义渠道不走 Gemini”“不把思考当正文”这两条不被改回去。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WWW = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const AIResponse = require(path.join(WWW, 'ai-response.js'));
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');

function extractFunction(name) {
    const match = html.match(new RegExp('^ *(?:async )?function ' + name + '\\(', 'm'));
    assert.ok(match, 'index.html 里找不到函数 ' + name);
    const start = match.index;
    // 先跳过参数表，避免把 `options = {}` 的默认值当成函数体
    let i = html.indexOf('(', start);
    let parens = 0;
    for (; i < html.length; i++) {
        if (html[i] === '(') parens++;
        else if (html[i] === ')' && --parens === 0) { i++; break; }
    }
    let depth = 0;
    let quote = null;
    for (i = html.indexOf('{', i); i < html.length; i++) {
        const ch = html[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return html.slice(start, i + 1);
    }
    throw new Error('函数括号不配对: ' + name);
}

const SOURCE = [
    'doAIRequest', 'doGeminiRequest', 'doClaudeRequest', 'reasoningRetryMaxTokens', 'isGeminiUrl',
    'extractPdfTextAsFallback', 'injectPdfTextIntoLastUser', 'buildGeminiContentsWithPdf',
    'embedPdfForClaude', 'uint8ToBase64', 'base64ToUint8'
].map(extractFunction).join('\n\n');

const load = new Function('AIResponse', 'i18n', 'fetch', 'window', 'pdfjsLib', 'console',
    SOURCE + '\nreturn { doAIRequest, doGeminiRequest };');

// respond(url, body, callIndex) -> { json } 或 { ok:false, status, json }
function sandbox(respond, pdfjsLib) {
    const calls = [];
    const fetchStub = async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : null;
        calls.push({ url, body });
        const result = respond(url, body, calls.length - 1);
        return {
            ok: result.ok !== false,
            status: result.status || 200,
            json: async () => result.json,
            text: async () => JSON.stringify(result.json)
        };
    };
    const i18n = (key, ...args) => (args.length ? key + ':' + args.join(',') : key);
    const quietConsole = { warn() {}, error() {}, log() {} };
    const api = load(AIResponse, i18n, fetchStub, { RecordingAI: null }, pdfjsLib || null, quietConsole);
    return { api, calls };
}

const GEMINI = { url: 'https://generativelanguage.googleapis.com/v1beta', key: 'k', model: 'gemini-2.5-pro' };
const CUSTOM = { url: 'https://gateway.example.com/v1/chat/completions', key: 'k', model: 'gemini-3-pro', provider: 'custom' };
const ONE_PAGE_PDF = {
    getDocument: () => ({ promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Section 7 Fatou–Julia' }] }) })
    }) })
};

function geminiReply(parts, finishReason) {
    return { json: { candidates: [{ finishReason: finishReason || 'STOP', content: { parts } }] } };
}

test('custom channel uses the OpenAI protocol and sends the PDF as extracted text', async () => {
    const { api, calls } = sandbox(
        () => ({ json: { choices: [{ message: { content: '# 讲义' } }] } }), ONE_PAGE_PDF);
    const result = await api.doAIRequest(CUSTOM, 'sys', [{ role: 'user', content: '生成讲义' }], {
        maxTokens: 8192,
        pdfAttachment: { bytes: new Uint8Array([1, 2, 3]), base64: 'AQID', name: 'ch1.pdf' }
    });
    assert.equal(result, '# 讲义');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, CUSTOM.url);
    assert.doesNotMatch(calls[0].url, /generateContent|generativelanguage/);
    assert.ok(!calls[0].body.contents, 'Gemini 的 contents 字段不应出现');
    const lastMessage = calls[0].body.messages[calls[0].body.messages.length - 1].content;
    assert.match(lastMessage, /Section 7 Fatou–Julia/);
});

test('Gemini reply keeps the answer part and drops the thought part', async () => {
    const { api, calls } = sandbox(() => geminiReply([
        { text: "I'm trying to recall the specific arXiv paper 1506.07113", thought: true },
        { text: '## 一、预习' }
    ]));
    assert.equal(await api.doGeminiRequest(GEMINI, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        '## 一、预习');
    assert.equal(calls.length, 1);
});

test('a thought-only Gemini reply is retried with a bigger output budget', async () => {
    const { api, calls } = sandbox((url, body, index) => index === 0
        ? geminiReply([{ text: 'Let me reconsider with a cleaner argument.', thought: true }], 'MAX_TOKENS')
        : geminiReply([{ text: '## 一、预习' }]));
    assert.equal(await api.doGeminiRequest(GEMINI, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        '## 一、预习');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.generationConfig.maxOutputTokens, 8192);
    assert.equal(calls[1].body.generationConfig.maxOutputTokens, 16384);
    assert.equal(calls[1].body.generationConfig.thinkingConfig.includeThoughts, false);
});

test('the retry drops thinkingConfig when the endpoint rejects it', async () => {
    const { api, calls } = sandbox((url, body, index) => {
        if (index === 0) return geminiReply([{ text: 'thinking…', thought: true }], 'MAX_TOKENS');
        if (body.generationConfig.thinkingConfig) return { ok: false, status: 400, json: 'unknown field' };
        return geminiReply([{ text: '正文' }]);
    });
    assert.equal(await api.doGeminiRequest(GEMINI, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        '正文');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.generationConfig.maxOutputTokens, 16384);
    assert.ok(!calls[2].body.generationConfig.thinkingConfig);
});

test('an all-thinking Gemini reply fails instead of returning the monologue', async () => {
    const { api } = sandbox(() => geminiReply(
        [{ text: "I'm working through the immediate basin argument", thought: true }], 'MAX_TOKENS'));
    await assert.rejects(
        () => api.doGeminiRequest(GEMINI, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        /ai_reasoning_only/);
});

test('an OpenAI-compatible reasoning-only reply is retried, then stripped of <think>', async () => {
    const { api, calls } = sandbox((url, body, index) => index === 0
        ? ({ json: { choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: '…' } }] } })
        : ({ json: { choices: [{ finish_reason: 'stop', message: { content: '<think>…</think>\n\n# 讲义' } }] } }));
    assert.equal(await api.doAIRequest(CUSTOM, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        '# 讲义');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.max_tokens, 8192);
    assert.equal(calls[1].body.max_tokens, 16384);
});
