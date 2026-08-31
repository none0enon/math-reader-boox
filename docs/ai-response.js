// AI 回复解析：只取正文，丢弃推理/思考内容。
//
// 背景：推理模型（Gemini thinking、DeepSeek-R1、各类聚合网关转发的模型）会把
// “思考过程”和“正文”一起返回：
//   - Gemini：candidates[0].content.parts 里带 thought:true 的 part 是思考摘要；
//   - OpenAI 兼容：message.reasoning_content / message.reasoning 是思考内容；
//   - 部分网关：把思考直接内联进正文，用 <think>…</think> 之类的标签包起来。
// 如果不加区分地把这些拼在一起，用户拿到的“讲义”就会变成一整篇模型自言自语。
// 本模块只负责纯解析，不发请求，便于用 node --test 回归。
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.AIResponse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const REASONING_TAGS = 'think|thinking|thought|thoughts|reasoning|reflection';
    const REASONING_BLOCK_RE = new RegExp(
        '<(' + REASONING_TAGS + ')(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1\\s*>', 'gi');
    const REASONING_OPEN_RE = new RegExp('<(' + REASONING_TAGS + ')(?:\\s[^>]*)?>', 'i');
    const REASONING_CLOSE_RE = new RegExp('<\\/(' + REASONING_TAGS + ')\\s*>', 'gi');

    function asText(value) {
        return typeof value === 'string' ? value : '';
    }

    function joinReasoning(chunks) {
        return chunks.map(asText).filter(function (chunk) {
            return chunk.trim() !== '';
        }).join('\n\n').trim();
    }

    // 把内联的思考标签从正文里摘出来。除了成对标签，还要处理两种残缺情况：
    // 只有结束标签（思考先流式输出、正文接在后面）和只有开始标签（思考没写完就被截断）。
    function splitReasoningMarkup(value) {
        let text = asText(value);
        const reasoning = [];

        REASONING_BLOCK_RE.lastIndex = 0;
        text = text.replace(REASONING_BLOCK_RE, function (match, tag, inner) {
            reasoning.push(inner);
            return '\n';
        });

        let closeStart = -1;
        let closeEnd = -1;
        let found;
        REASONING_CLOSE_RE.lastIndex = 0;
        while ((found = REASONING_CLOSE_RE.exec(text)) !== null) {
            closeStart = found.index;
            closeEnd = found.index + found[0].length;
        }
        if (closeStart >= 0) {
            reasoning.push(text.slice(0, closeStart));
            text = text.slice(closeEnd);
        }

        const open = text.match(REASONING_OPEN_RE);
        if (open) {
            reasoning.push(text.slice(open.index + open[0].length));
            text = text.slice(0, open.index);
        }

        return { text: text.trim(), reasoning: joinReasoning(reasoning) };
    }

    // Gemini 的思考 part 标记为 thought:true。个别网关会发字符串 'true'/'false'。
    function isThoughtPart(part) {
        const flag = part.thought;
        if (flag === undefined || flag === null || flag === false) return false;
        if (typeof flag === 'string') {
            const normalized = flag.trim().toLowerCase();
            return normalized !== '' && normalized !== 'false';
        }
        return !!flag;
    }

    // 返回 { text, reasoning, finishReason, blockReason, hasCandidate }
    // text 只包含正文；思考内容单独放在 reasoning 里，仅用于诊断，不给用户当结果。
    function extractGeminiAnswer(data) {
        const payload = data && typeof data === 'object' ? data : {};
        const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
        const candidate = candidates.length > 0 && candidates[0] && typeof candidates[0] === 'object'
            ? candidates[0] : null;
        const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
            ? candidate.content.parts : [];

        const answerChunks = [];
        const thoughtChunks = [];
        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!part || typeof part !== 'object') continue;
            const text = asText(part.text);
            if (text === '') continue;
            if (isThoughtPart(part)) thoughtChunks.push(text);
            else answerChunks.push(text);
        }

        const split = splitReasoningMarkup(answerChunks.join(''));
        const feedback = payload.promptFeedback && typeof payload.promptFeedback === 'object'
            ? payload.promptFeedback : {};
        return {
            text: split.text,
            reasoning: joinReasoning([thoughtChunks.join('\n\n'), split.reasoning]),
            finishReason: candidate ? asText(candidate.finishReason) : '',
            blockReason: asText(feedback.blockReason),
            hasCandidate: !!candidate
        };
    }

    // content 可能是字符串，也可能是内容块数组；thinking / reasoning 块归到思考里。
    function flattenOpenAiContent(content) {
        if (typeof content === 'string') return { text: content, reasoning: '' };
        if (!Array.isArray(content)) return { text: '', reasoning: '' };
        const chunks = [];
        const reasoning = [];
        for (let i = 0; i < content.length; i++) {
            const item = content[i];
            if (typeof item === 'string') { chunks.push(item); continue; }
            if (!item || typeof item !== 'object') continue;
            const type = asText(item.type);
            if (type === 'thinking' || type === 'reasoning') {
                reasoning.push(asText(item.thinking) || asText(item.reasoning) || asText(item.text));
                continue;
            }
            if (type === '' || type === 'text' || type === 'output_text') chunks.push(asText(item.text));
        }
        return { text: chunks.join(''), reasoning: joinReasoning(reasoning) };
    }

    // 返回 { text, reasoning, finishReason }
    function extractOpenAiAnswer(data) {
        const payload = data && typeof data === 'object' ? data : {};
        const choices = Array.isArray(payload.choices) ? payload.choices : [];
        const choice = choices.length > 0 && choices[0] && typeof choices[0] === 'object'
            ? choices[0] : null;
        const message = choice && choice.message && typeof choice.message === 'object'
            ? choice.message : null;

        const flattened = flattenOpenAiContent(message ? message.content : '');
        const split = splitReasoningMarkup(flattened.text);
        const declaredReasoning = message
            ? [asText(message.reasoning_content), asText(message.reasoning)]
            : [];
        return {
            text: split.text,
            reasoning: joinReasoning(declaredReasoning.concat([flattened.reasoning, split.reasoning])),
            finishReason: choice ? asText(choice.finish_reason) : ''
        };
    }

    // 正文为空但确实产出了思考（或输出预算被思考吃光），说明这次请求“只想没说”，
    // 值得抬高输出上限重试一次，而不是把思考当结果保存下来。
    function isReasoningOnly(answer) {
        if (!answer || answer.text) return false;
        return !!answer.reasoning || answer.finishReason === 'MAX_TOKENS' ||
            answer.finishReason === 'length';
    }

    return {
        splitReasoningMarkup,
        extractGeminiAnswer,
        extractOpenAiAnswer,
        isReasoningOnly
    };
});
