(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AIResponse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const THINKING_PART_TYPES = new Set([
        'analysis', 'reasoning', 'reasoning_content', 'thinking', 'thought'
    ]);

    function inferProtocol(config) {
        config = config || {};
        const provider = String(config.provider || '').toLowerCase();
        const url = String(config.url || '').toLowerCase();

        // An explicit endpoint shape is more reliable than the UI label. In particular,
        // a custom endpoint ending in /chat/completions can still serve a Claude model.
        if (/\/chat\/completions(?:[/?#]|$)/.test(url)) return 'openai';
        if (/anthropic\.com/.test(url) || /\/messages(?:[/?#]|$)/.test(url)) return 'anthropic';
        if (/generativelanguage\.googleapis\.com/.test(url) ||
            /:generatecontent(?:[/?#]|$)/.test(url) ||
            /\/(?:v1beta|v1alpha)(?:[/?#]|$)/.test(url)) return 'gemini';

        if (provider === 'google') return 'gemini';
        if (provider === 'claude') return 'anthropic';
        return 'openai';
    }

    function isMaxThinkingModel(model) {
        return /(?:^|[-_/\s])max[-_\s]?thinking(?:$|[-_/\s])/i.test(String(model || ''));
    }

    function outputTokenLimit(model, requested, fallback) {
        const value = Number(requested);
        const defaultValue = Number(fallback);
        const base = Number.isFinite(value) && value > 0
            ? Math.floor(value)
            : Number.isFinite(defaultValue) && defaultValue > 0
            ? Math.floor(defaultValue)
            : null;
        // maxthinking gateways commonly reserve up to 32K tokens for reasoning. Keep
        // enough room for a roughly 12K-token lecture without asking ordinary models
        // for an unnecessarily large completion.
        return isMaxThinkingModel(model) ? Math.max(base || 0, 49152) : base;
    }

    function thinkingOnlyError(finishReason) {
        const error = new Error('AI returned reasoning but no final answer');
        error.code = 'AI_THINKING_ONLY';
        error.finishReason = finishReason || '';
        return error;
    }

    function isThinkingPart(part) {
        if (!part || typeof part !== 'object') return false;
        if (part.thought === true) return true;
        return THINKING_PART_TYPES.has(String(part.type || '').toLowerCase());
    }

    function textFromPart(part) {
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        if (part.text && typeof part.text.value === 'string') return part.text.value;
        return '';
    }

    function removeEmbeddedThinking(value) {
        let text = String(value || '');
        let hadThinking = false;
        text = text.replace(/<(?:think|thinking)>[\s\S]*?<\/(?:think|thinking)>/gi, function () {
            hadThinking = true;
            return '';
        });
        if (/<(?:think|thinking)>/i.test(text)) {
            hadThinking = true;
            text = text.replace(/<(?:think|thinking)>[\s\S]*$/i, '');
        }
        return { text, hadThinking };
    }

    function extractOpenAIText(data) {
        const message = data && data.choices && data.choices[0] && data.choices[0].message;
        if (!message) return null;

        let answer = '';
        let hadThinking = !!(message.reasoning_content || message.reasoning);
        if (typeof message.content === 'string') {
            const cleaned = removeEmbeddedThinking(message.content);
            answer = cleaned.text;
            hadThinking = hadThinking || cleaned.hadThinking;
        } else if (Array.isArray(message.content)) {
            const answerParts = [];
            for (const part of message.content) {
                const text = textFromPart(part);
                if (isThinkingPart(part)) {
                    if (text) hadThinking = true;
                } else if (text) {
                    answerParts.push(text);
                }
            }
            answer = answerParts.join('');
        }

        if (answer.trim()) return answer;
        if (hadThinking) throw thinkingOnlyError(data.choices[0].finish_reason);
        return null;
    }

    function extractAnthropicText(data) {
        if (!data || !Array.isArray(data.content)) return null;
        const answer = data.content
            .filter(function (part) { return !isThinkingPart(part); })
            .map(textFromPart)
            .join('');
        if (answer.trim()) return answer;
        const hadThinking = data.content.some(function (part) {
            return isThinkingPart(part) && !!(textFromPart(part) || part.thinking);
        });
        if (hadThinking) throw thinkingOnlyError(data.stop_reason);
        return null;
    }

    function extractGeminiText(data) {
        const candidate = data && data.candidates && data.candidates[0];
        const parts = candidate && candidate.content && candidate.content.parts;
        if (!Array.isArray(parts) || parts.length === 0) return null;

        const answer = parts
            .filter(function (part) { return !isThinkingPart(part); })
            .map(textFromPart)
            .join('');
        if (answer.trim()) return answer;
        const hadThinking = parts.some(function (part) {
            return isThinkingPart(part) && !!textFromPart(part);
        });
        if (hadThinking) throw thinkingOnlyError(candidate.finishReason);
        return null;
    }

    function prependToLastUserMessage(messages, prefix) {
        const out = Array.isArray(messages) ? messages.slice() : [];
        let index = -1;
        for (let i = out.length - 1; i >= 0; i--) {
            if (out[i] && out[i].role === 'user') {
                index = i;
                break;
            }
        }
        if (index < 0) {
            out.push({ role: 'user', content: String(prefix || '') });
            return out;
        }

        const message = out[index] || { role: 'user', content: '' };
        if (Array.isArray(message.content)) {
            out[index] = {
                ...message,
                content: [{ type: 'text', text: String(prefix || '') }, ...message.content]
            };
        } else {
            const suffix = String(message.content || '');
            out[index] = {
                ...message,
                content: String(prefix || '') + (suffix ? '\n\n---\n\n' + suffix : '')
            };
        }
        return out;
    }

    return {
        inferProtocol,
        isMaxThinkingModel,
        outputTokenLimit,
        isThinkingPart,
        extractOpenAIText,
        extractAnthropicText,
        extractGeminiText,
        prependToLastUserMessage
    };
});
