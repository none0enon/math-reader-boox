(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RecordingAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MIN_AI_TEXT_CHARS = 8;
    const SUMMARY_MAX_CHARS_HINT = 1200;

    function validationError(code, message) {
        const error = new Error(message);
        error.code = code;
        return error;
    }

    function validateAiText(text) {
        if (typeof text !== 'string') {
            throw validationError('AI_TEXT_EMPTY', 'AI response must be text');
        }
        const trimmed = text.trim();
        if (!trimmed) {
            throw validationError('AI_TEXT_EMPTY', 'AI response is empty');
        }
        const visibleLength = Array.from(trimmed.replace(/\s/g, '')).length;
        if (visibleLength < MIN_AI_TEXT_CHARS) {
            throw validationError('AI_TEXT_TOO_SHORT', 'AI response is too short');
        }
        return trimmed;
    }

    function safeRef(value) {
        if (value === undefined || value === null) return '';
        return String(value).replace(/[\r\n{}]+/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function mergeRecordingParts(parts, options) {
        if (!Array.isArray(parts) || parts.length === 0) {
            throw new Error('Recording parts are required');
        }
        const validParts = parts.map(validateAiText);
        if (validParts.length === 1) return validParts[0];

        const ref = safeRef(options && options.ref);
        const refTag = ref ? ' {ref:' + ref + '}' : '';
        return validParts.map(function (part, index) {
            return '## \u5f55\u97f3\u5206\u6bb5 ' + (index + 1) + '/' + validParts.length + refTag + '\n\n' + part;
        }).join('\n\n---\n\n');
    }

    async function emitProgress(onProgress, event) {
        if (typeof onProgress === 'function') await onProgress(event);
    }

    async function canRetry(retry, error, context) {
        if (typeof retry === 'number') {
            const retries = Math.max(0, Math.floor(retry));
            return context.attempt <= retries;
        }
        if (typeof retry === 'function') return !!(await retry(error, context));
        return false;
    }

    function segmentError(error, index, total) {
        const message = error && error.message ? error.message : String(error || 'unknown error');
        const wrapped = new Error('Recording segment ' + (index + 1) + '/' + total + ' failed: ' + message);
        wrapped.code = 'RECORDING_SEGMENT_FAILED';
        wrapped.segmentIndex = index;
        wrapped.cause = error;
        return wrapped;
    }

    async function runRecordingNoteJob(options) {
        options = options || {};
        const segments = options.segments;
        const transcribe = options.transcribe;
        const summarize = options.summarize;
        const onProgress = options.onProgress;
        const retry = options.retry;

        if (!Array.isArray(segments) || segments.length === 0) {
            throw new Error('Recording segments are required');
        }
        if (typeof transcribe !== 'function') {
            throw new Error('A transcribe function is required');
        }

        const parts = [];
        const total = segments.length;
        for (let index = 0; index < total; index++) {
            let attempt = 0;
            while (true) {
                attempt++;
                const context = { index, total, attempt };
                await emitProgress(onProgress, {
                    phase: 'transcribe', index, total, attempt
                });
                try {
                    const result = await transcribe(segments[index], context);
                    parts.push(validateAiText(result));
                    await emitProgress(onProgress, {
                        phase: 'transcribed', index, total, attempt
                    });
                    break;
                } catch (error) {
                    if (!await canRetry(retry, error, context)) {
                        throw segmentError(error, index, total);
                    }
                    await emitProgress(onProgress, {
                        phase: 'retry', index, total, attempt, error
                    });
                }
            }
        }

        // This deterministic merge is the authoritative transcript. A model-generated
        // overview may be added, but is never allowed to replace any segment text.
        const merged = mergeRecordingParts(parts, { ref: options.ref });
        let summary = null;
        let content = merged;
        if (parts.length > 1 && typeof summarize === 'function') {
            await emitProgress(onProgress, { phase: 'summarize', total });
            summary = validateAiText(await summarize(merged, {
                parts: parts.slice(),
                total,
                mode: 'overview',
                maxChars: SUMMARY_MAX_CHARS_HINT
            }));
            content = '# \u5f55\u97f3\u603b\u89c8\n\n' + summary +
                '\n\n---\n\n# \u5206\u6bb5\u5168\u6587\n\n' + merged;
        }

        await emitProgress(onProgress, { phase: 'complete', total });
        return {
            content,
            merged,
            summary,
            parts: parts.slice(),
            segmentCount: total
        };
    }

    return {
        validateAiText,
        mergeRecordingParts,
        runRecordingNoteJob
    };
});
