'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const AIResponse = require('../app/src/main/assets/www/ai-response.js');

test('keeps the answer and drops Gemini thought parts', () => {
    const answer = AIResponse.extractGeminiAnswer({
        candidates: [{
            content: {
                parts: [
                    { text: 'I am trying to recall arXiv:1506.07113 ...', thought: true },
                    { text: '## 一、预习\n\n设 $f_c(z)=z^2+c$。' }
                ]
            },
            finishReason: 'STOP'
        }]
    });
    assert.equal(answer.text, '## 一、预习\n\n设 $f_c(z)=z^2+c$。');
    assert.equal(answer.reasoning, 'I am trying to recall arXiv:1506.07113 ...');
    assert.equal(AIResponse.isReasoningOnly(answer), false);
});

test('reports a thought-only Gemini reply instead of returning the monologue', () => {
    // 思考把 maxOutputTokens 吃光，正文一个字都没写：不能当讲义保存。
    const answer = AIResponse.extractGeminiAnswer({
        candidates: [{
            content: { parts: [{ text: 'Let me reconsider with a cleaner argument.', thought: 'true' }] },
            finishReason: 'MAX_TOKENS'
        }]
    });
    assert.equal(answer.text, '');
    assert.equal(answer.reasoning, 'Let me reconsider with a cleaner argument.');
    assert.equal(answer.finishReason, 'MAX_TOKENS');
    assert.equal(AIResponse.isReasoningOnly(answer), true);
});

test('treats thought:false parts as answer text and surfaces block reasons', () => {
    const answer = AIResponse.extractGeminiAnswer({
        candidates: [{ content: { parts: [{ text: '正文', thought: false }] }, finishReason: 'STOP' }],
        promptFeedback: { blockReason: 'SAFETY' }
    });
    assert.equal(answer.text, '正文');
    assert.equal(answer.blockReason, 'SAFETY');
    assert.equal(answer.hasCandidate, true);
});

test('survives empty and malformed Gemini payloads', () => {
    for (const payload of [null, {}, { candidates: [] }, { candidates: [{}] }]) {
        const answer = AIResponse.extractGeminiAnswer(payload);
        assert.equal(answer.text, '');
        assert.equal(answer.reasoning, '');
    }
    assert.equal(AIResponse.extractGeminiAnswer({ candidates: [{}] }).hasCandidate, true);
    assert.equal(AIResponse.extractGeminiAnswer({}).hasCandidate, false);
});

test('drops OpenAI-compatible reasoning_content and keeps the answer', () => {
    const answer = AIResponse.extractOpenAiAnswer({
        choices: [{
            message: { content: '## 二、大纲', reasoning_content: 'first I check the fixed points' },
            finish_reason: 'stop'
        }]
    });
    assert.equal(answer.text, '## 二、大纲');
    assert.equal(answer.reasoning, 'first I check the fixed points');
    assert.equal(AIResponse.isReasoningOnly(answer), false);
});

test('flags a reasoning-only OpenAI-compatible reply', () => {
    const answer = AIResponse.extractOpenAiAnswer({
        choices: [{ message: { content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' }]
    });
    assert.equal(answer.text, '');
    assert.equal(answer.finishReason, 'length');
    assert.equal(AIResponse.isReasoningOnly(answer), true);
});

test('reads OpenAI content blocks and ignores thinking blocks', () => {
    const answer = AIResponse.extractOpenAiAnswer({
        choices: [{
            message: {
                content: [
                    { type: 'thinking', thinking: 'internal' },
                    { type: 'text', text: 'Theorem 1. ' },
                    { type: 'text', text: 'Proof.' }
                ]
            }
        }]
    });
    assert.equal(answer.text, 'Theorem 1. Proof.');
    assert.equal(answer.reasoning, 'internal');
});

test('strips inline reasoning tags gateways inject into the body', () => {
    assert.deepEqual(
        AIResponse.splitReasoningMarkup('<think>weighing options</think>\n\n# 讲义'),
        { text: '# 讲义', reasoning: 'weighing options' });
    // 思考先流式输出、只留下一个结束标签
    assert.deepEqual(
        AIResponse.splitReasoningMarkup('recalling the lemma</thinking>\n# 讲义'),
        { text: '# 讲义', reasoning: 'recalling the lemma' });
    // 思考没写完就被截断：整段都不是正文
    assert.deepEqual(
        AIResponse.splitReasoningMarkup('# 讲义\n<reasoning>still unsure about'),
        { text: '# 讲义', reasoning: 'still unsure about' });
});

test('leaves ordinary lecture text untouched', () => {
    const lecture = '## 一、预习\n\n若 $|\\lambda| < 1$，则 $c = \\lambda/2 - \\lambda^2/4$。';
    assert.deepEqual(AIResponse.splitReasoningMarkup(lecture), { text: lecture, reasoning: '' });
});
