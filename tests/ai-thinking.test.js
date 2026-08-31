'use strict';

// index.html 是单文件应用，没法直接 require：按函数名把相关函数原样抠出来跑，
// 保证"只取正文、不取思考"和自定义渠道的 PDF 处理不会被改回去。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
    path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'index.html'), 'utf8');

function extractFunction(name) {
    const match = html.match(new RegExp('^ *(?:async )?function ' + name + '\\(', 'm'));
    assert.ok(match, 'index.html 里找不到函数 ' + name);
    // 先跳过参数表，避免把 `options = {}` 的默认值当成函数体
    let i = html.indexOf('(', match.index);
    for (let parens = 0; i < html.length; i++) {
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
        } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return html.slice(match.index, i + 1);
    }
    throw new Error('函数括号不配对: ' + name);
}

const SOURCE = ['stripThinkingMarkup', 'extractGeminiAnswer', 'doGeminiRequest', 'doAIRequest',
    'doClaudeRequest', 'isGeminiUrl', 'extractPdfTextAsFallback', 'injectPdfTextIntoLastUser',
    'buildGeminiContentsWithPdf', 'embedPdfForClaude', 'uint8ToBase64', 'base64ToUint8']
    .map(extractFunction).join('\n\n');

const load = new Function('i18n', 'fetch', 'window', 'pdfjsLib', 'console', SOURCE +
    '\nreturn { stripThinkingMarkup, extractGeminiAnswer, doGeminiRequest, doAIRequest };');

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
    const i18n = (key, ...args) => args.reduce(
        (text, arg, idx) => text.replace(new RegExp('\\{' + idx + '\\}', 'g'), String(arg)),
        I18N_TEMPLATES[key] || key);
    const api = load(i18n, fetchStub, {}, pdfjsLib || null, { warn() {}, error() {}, log() {} });
    return { api, calls };
}

// 用 index.html 里真实的模板，才能验出 i18n 占位符没被替换的情况
const I18N_TEMPLATES = {
    attached_pdf_text: html.match(/attached_pdf_text:'([^']*)'/)[1]
};

const GEMINI = { url: 'https://generativelanguage.googleapis.com/v1beta', key: 'k', model: 'gemini-2.5-pro' };
const CUSTOM = { url: 'https://gateway.example.com/v1beta', key: 'k', model: 'opus-maxthinking', provider: 'custom' };
const ONE_PAGE_PDF = {
    getDocument: () => ({ promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({ getTextContent: async () => ({ items: [{ str: 'Section 7 Fatou–Julia' }] }) })
    }) })
};
const PDF_ATTACHMENT = { bytes: new Uint8Array([1, 2, 3]), base64: 'AQID', name: 'ch1.pdf' };

function geminiReply(parts, finishReason) {
    return { json: { candidates: [{ finishReason: finishReason || 'STOP', content: { parts } }] } };
}

test('只保留正文，丢掉 thought 分段', () => {
    const { api } = sandbox(() => ({ json: {} }));
    const answer = api.extractGeminiAnswer({ candidates: [{ content: { parts: [
        { text: "I'm trying to recall the specific arXiv paper 1506.07113", thought: true },
        { text: '## 一、预习\n\n设 $f_c(z)=z^2+c$。' }
    ] } }] });
    assert.equal(answer.text, '## 一、预习\n\n设 $f_c(z)=z^2+c$。');
    assert.equal(answer.thinking, "I'm trying to recall the specific arXiv paper 1506.07113");
});

test('只有思考时正文为空，思考不会被当成正文', () => {
    const { api } = sandbox(() => ({ json: {} }));
    // 网关有时把布尔发成字符串
    const answer = api.extractGeminiAnswer({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [
        { text: 'Let me reconsider with a cleaner argument.', thought: 'true' }
    ] } }] });
    assert.equal(answer.text, '');
    assert.equal(answer.thinking, 'Let me reconsider with a cleaner argument.');
    // thought:false 的分段是正文
    assert.equal(api.extractGeminiAnswer({ candidates: [{ content: { parts: [
        { text: '正文', thought: false }] } }] }).text, '正文');
    // 畸形响应不炸
    for (const payload of [null, {}, { candidates: [] }, { candidates: [{}] }]) {
        assert.deepEqual(api.extractGeminiAnswer(payload), { text: '', thinking: '' });
    }
});

test('内联的 <think> 标签会被清掉，正常正文不受影响', () => {
    const { api } = sandbox(() => ({ json: {} }));
    assert.equal(api.stripThinkingMarkup('<think>weighing options</think>\n\n# 讲义'), '# 讲义');
    // 思考先输出、只剩一个结束标签
    assert.equal(api.stripThinkingMarkup('recalling the lemma</thinking>\n# 讲义'), '# 讲义');
    // 思考没写完就被截断
    assert.equal(api.stripThinkingMarkup('# 讲义\n<reasoning>still unsure'), '# 讲义');
    const lecture = '## 一、预习\n\n若 $|\\lambda| < 1$，则 $c = \\lambda/2 - \\lambda^2/4$。';
    assert.equal(api.stripThinkingMarkup(lecture), lecture);
});

test('思考吃光预算时提高上限重试一次', async () => {
    const { api, calls } = sandbox((url, body, index) => index === 0
        ? geminiReply([{ text: 'thinking…', thought: true }], 'MAX_TOKENS')
        : geminiReply([{ text: '## 一、预习' }]));
    assert.equal(await api.doGeminiRequest(GEMINI, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        '## 一、预习');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.generationConfig.maxOutputTokens, 8192);
    assert.equal(calls[1].body.generationConfig.maxOutputTokens, 32768);
});

test('重试后仍然只有思考就返回空，不返回独白', async () => {
    const { api, calls } = sandbox(() => geminiReply(
        [{ text: "I'm working through the immediate basin argument", thought: true }], 'MAX_TOKENS'));
    assert.equal(await api.doGeminiRequest(GEMINI, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        null);
    assert.equal(calls.length, 2);
});

test('正常回复只请求一次', async () => {
    const { api, calls } = sandbox(() => geminiReply([{ text: '## 一、预习' }]));
    assert.equal(await api.doGeminiRequest(GEMINI, 'sys', [{ role: 'user', content: 'go' }], { maxTokens: 8192 }),
        '## 一、预习');
    assert.equal(calls.length, 1);
});

test('自定义渠道的地址和请求格式不变，PDF 换成本地提取的文本', async () => {
    const { api, calls } = sandbox(() => geminiReply([{ text: '# 讲义' }]), ONE_PAGE_PDF);
    const result = await api.doAIRequest(CUSTOM, 'sys', [{ role: 'user', content: '生成讲义' }],
        { maxTokens: 8192, pdfAttachment: PDF_ATTACHMENT });
    assert.equal(result, '# 讲义');
    assert.equal(calls.length, 1);
    // 仍然是 Gemini 协议的地址和请求体
    assert.equal(calls[0].url,
        'https://gateway.example.com/v1beta/models/opus-maxthinking:generateContent?key=k');
    assert.ok(calls[0].body.contents, '请求体仍然是 Gemini 的 contents');
    const parts = calls[0].body.contents[calls[0].body.contents.length - 1].parts;
    assert.ok(!parts.some(p => p.inline_data || p.file_data), 'PDF 不再作为 Gemini 附件发送');
    assert.match(parts[0].text, /Section 7 Fatou–Julia/);
    assert.doesNotMatch(parts[0].text, /\{0\}/);
});

test('真正的 Gemini 端点仍然直接上传 PDF', async () => {
    const { api, calls } = sandbox(() => geminiReply([{ text: '# 讲义' }]), ONE_PAGE_PDF);
    await api.doAIRequest(GEMINI, 'sys', [{ role: 'user', content: '生成讲义' }],
        { maxTokens: 8192, pdfAttachment: PDF_ATTACHMENT });
    const parts = calls[0].body.contents[calls[0].body.contents.length - 1].parts;
    assert.equal(parts[0].inline_data.mime_type, 'application/pdf');
});

test('OpenAI 兼容渠道只取 content，清掉内联思考', async () => {
    const { api } = sandbox(() => ({ json: { choices: [{
        message: { content: '<think>hmm</think>\n\n# 讲义', reasoning_content: 'hmm' }
    }] } }));
    assert.equal(await api.doAIRequest(
        { url: 'https://api.deepseek.com/v1/chat/completions', key: 'k', model: 'deepseek-chat' },
        'sys', [{ role: 'user', content: 'go' }], {}), '# 讲义');
});
