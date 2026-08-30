'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIResponse = require('../app/src/main/assets/www/ai-response.js');

test('routes custom OpenAI-compatible Claude endpoints by URL protocol', () => {
    assert.equal(AIResponse.inferProtocol({
        provider: 'custom',
        url: 'https://gateway.example/v1/chat/completions',
        model: 'claude-opus-5-maxthinking'
    }), 'openai');
    assert.equal(AIResponse.inferProtocol({ provider: 'custom', url: 'https://gateway.example/v1beta' }),
        'gemini');
    assert.equal(AIResponse.inferProtocol({ provider: 'claude', url: 'https://api.anthropic.com/v1/messages' }),
        'anthropic');
});

test('keeps final text separate from reasoning and rejects a reasoning-only response', () => {
    const response = {
        choices: [{
            finish_reason: 'stop',
            message: { reasoning_content: 'internal reasoning', content: '# Lecture\n\nBody' }
        }]
    };
    assert.equal(AIResponse.extractOpenAIText(response), '# Lecture\n\nBody');
    assert.equal(AIResponse.extractGeminiText({
        candidates: [{ content: { parts: [
            { thought: true, text: 'internal reasoning' },
            { text: 'final answer' }
        ] } }]
    }), 'final answer');
    assert.throws(() => AIResponse.extractOpenAIText({
        choices: [{ finish_reason: 'length', message: {
            reasoning_content: 'internal reasoning', content: ''
        } }]
    }), error => error.code === 'AI_THINKING_ONLY');
});

test('injects PDF text into the user message and reserves maxthinking output capacity', () => {
    const messages = AIResponse.prependToLastUserMessage([
        { role: 'user', content: [{ type: 'text', text: 'Generate the lecture.' }] }
    ], 'Attached PDF text:\npage content');
    assert.equal(messages[0].content[0].text, 'Attached PDF text:\npage content');
    assert.equal(messages[0].content[1].text, 'Generate the lecture.');
    assert.equal(AIResponse.outputTokenLimit('claude-opus-5-maxthinking', 12288, 8192), 49152);
    assert.equal(AIResponse.outputTokenLimit('claude-opus-5', 12288, 8192), 12288);
});
