'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appHtml = fs.readFileSync(path.join(__dirname,
    '../app/src/main/assets/www/index.html'), 'utf8');
const docsHtml = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
const activity = fs.readFileSync(path.join(__dirname,
    '../app/src/main/java/com/mathreader/boox/MainActivity.java'), 'utf8');

function loadFunction(name, globals = {}) {
    const start = appHtml.indexOf(`        function ${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const closing = '\n        }\n';
    const end = appHtml.indexOf(closing, start);
    assert.notEqual(end, -1, `${name} must have a closing brace`);
    const source = appHtml.slice(start, end + closing.length).trim();
    return Function(...Object.keys(globals), `return (${source});`)(...Object.values(globals));
}

test('keeps custom chat-completions on OpenAI format and sizes maxthinking output', () => {
    const isNativeAnthropicEndpoint = loadFunction('isNativeAnthropicEndpoint', { URL });
    const isClaudeOpus5Model = loadFunction('isClaudeOpus5Model');
    const openAIOutputTokenLimit = loadFunction('openAIOutputTokenLimit');

    assert.equal(isNativeAnthropicEndpoint('https://gateway.test/v1/chat/completions'), false);
    assert.equal(isNativeAnthropicEndpoint('https://gateway.test/v1/messages'), true);
    assert.equal(isClaudeOpus5Model('claude-opus-5-maxthinking'), true);
    assert.equal(openAIOutputTokenLimit('claude-opus-5-maxthinking', 16000), 49152);
    assert.equal(openAIOutputTokenLimit('claude-opus-5', 16000), 16000);
});

test('keeps final Claude text and rejects reasoning-only output', () => {
    const extractOpenAIResponseText = loadFunction('extractOpenAIResponseText', {
        i18n: key => key
    });

    assert.equal(extractOpenAIResponseText({ choices: [{ message: {
        reasoning_content: 'private reasoning', content: '# Lecture\n\nBody'
    } }] }), '# Lecture\n\nBody');
    assert.equal(extractOpenAIResponseText({ choices: [{ message: {
        content: '<think>private reasoning</think>\n# Lecture'
    } }] }), '\n# Lecture');
    assert.throws(() => extractOpenAIResponseText({ choices: [{ message: {
        reasoning_content: 'private reasoning', content: ''
    } }] }), /toast_content_gen_failed/);
});

test('injects PDF text and wires the BOOX native transport without diverging PWA HTML', () => {
    const injectPdfTextIntoLastUser = loadFunction('injectPdfTextIntoLastUser', {
        i18n: (key, value) => `${key}:${value}`
    });
    const result = injectPdfTextIntoLastUser([
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'write lecture' }
    ], 'page text');

    assert.match(result[1].content, /^attached_pdf_text:page text/);
    assert.match(result[1].content, /write lecture$/);
    assert.match(appHtml, /postOpenAICompatibleRequest\(config\.url/);
    assert.match(activity, /addJavascriptInterface\(aiHttpBridge, "BooxAiHttpNative"\)/);
    assert.equal(appHtml, docsHtml);
});
