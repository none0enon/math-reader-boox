(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.RecordingAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const MIN_AI_TEXT_CHARS = 8;
    const SUMMARY_MAX_CHARS_HINT = 1200;
    // An 80-90 minute lecture is close to twenty sequential model calls. Throwing every
    // finished segment away because one response came back bad is what left users with no
    // note at all, so a job may keep going as long as most of the recording transcribed.
    const DEFAULT_MIN_SUCCESS_RATIO = 0.6;

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

    function normalizeSuccessRatio(value) {
        const ratio = Number(value);
        if (!Number.isFinite(ratio)) return DEFAULT_MIN_SUCCESS_RATIO;
        return Math.min(1, Math.max(0, ratio));
    }

    // The placeholder is merged into the transcript like any other part, so it must survive
    // validateAiText and read as an explicit gap rather than as transcribed speech.
    function segmentPlaceholder(index, total, error, render) {
        if (typeof render === 'function') {
            const custom = render(index, total, error);
            if (typeof custom === 'string' && custom.trim()) return custom.trim();
        }
        const reason = error && error.message ? error.message : String(error || 'unknown error');
        return '> [transcription unavailable] Recording segment ' + (index + 1) + '/' + total +
            ' could not be transcribed: ' + safeRef(reason);
    }

    // ---- Fragmented MP4 splitting -------------------------------------------------
    // Safari is the only MediaRecorder that cannot produce WebM, so every iOS PWA
    // records fragmented MP4: ftyp + moov, then a moof/mdat pair per timeslice.
    // Prefixing any run of fragments with those init boxes yields a standalone,
    // decodable file, so a long recording can be cut up by copying byte ranges.
    // Decoding it instead - the only other way to split audio in a browser - needs the
    // whole recording as float PCM and takes the tab down long before an 80-90 minute
    // lecture finishes.

    const MP4_WINDOW_BYTES = 256 * 1024;
    const MP4_MAX_HEADER_BOX_BYTES = 8 * 1024 * 1024;
    const MP4_DEFAULT_SEGMENT_MS = 5 * 60 * 1000;
    const MP4_DEFAULT_SEGMENT_BYTES = 10 * 1024 * 1024;

    function readUint32(bytes, offset) {
        return (bytes[offset] * 16777216) + (bytes[offset + 1] << 16) +
            (bytes[offset + 2] << 8) + bytes[offset + 3];
    }

    function readUint64(bytes, offset) {
        return readUint32(bytes, offset) * 4294967296 + readUint32(bytes, offset + 4);
    }

    function readBoxType(bytes, offset) {
        let type = '';
        for (let i = 0; i < 4; i++) {
            const code = bytes[offset + i];
            // Box types are four printable characters. Anything else means this offset
            // is not on a box boundary, and the file cannot be walked safely.
            if (code < 0x20 || code > 0x7e) return '';
            type += String.fromCharCode(code);
        }
        return type;
    }

    function decodeBoxHeader(bytes, offset, available) {
        if (available < 8) return null;
        const type = readBoxType(bytes, offset + 4);
        if (!type) return null;
        let size = readUint32(bytes, offset);
        let headerSize = 8;
        if (size === 1) {
            if (available < 16) return null;
            size = readUint64(bytes, offset + 8);
            headerSize = 16;
        }
        // A declared size of 0 means "to the end" and is resolved by the caller, which
        // is the only one that knows what the end is.
        return { type, size, headerSize };
    }

    function parseBoxHeader(bytes, offset, limit) {
        const header = decodeBoxHeader(bytes, offset, limit - offset);
        if (!header) return null;
        const size = header.size === 0 ? limit - offset : header.size;
        if (size < header.headerSize || offset + size > limit) return null;
        return {
            type: header.type, start: offset, size,
            contentStart: offset + header.headerSize, end: offset + size
        };
    }

    // Walks a blob one window at a time so scanning a long recording never holds more
    // than the window in memory.
    function createBlobWindowReader(blob, windowBytes) {
        let windowStart = 0;
        let windowBuffer = null;
        return {
            size: blob.size,
            async read(offset, length) {
                if (offset < 0 || length < 0 || offset + length > blob.size) return null;
                if (!windowBuffer || offset < windowStart ||
                    offset + length > windowStart + windowBuffer.length) {
                    const end = Math.min(blob.size, offset + Math.max(windowBytes, length));
                    windowBuffer = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
                    windowStart = offset;
                }
                if (windowBuffer.length < offset - windowStart + length) return null;
                return windowBuffer.subarray(offset - windowStart, offset - windowStart + length);
            }
        };
    }

    async function readTopLevelBox(reader, offset) {
        const head = await reader.read(offset, Math.min(16, reader.size - offset));
        if (!head) return null;
        const header = decodeBoxHeader(head, 0, head.length);
        if (!header) return null;
        const size = header.size === 0 ? reader.size - offset : header.size;
        if (size < header.headerSize || offset + size > reader.size) return null;
        return {
            type: header.type, start: offset, size,
            contentStart: offset + header.headerSize, end: offset + size
        };
    }

    function findChildBox(bytes, start, end, type) {
        let offset = start;
        while (offset + 8 <= end) {
            const box = parseBoxHeader(bytes, offset, end);
            if (!box) return null;
            if (box.type === type) return box;
            offset = box.end;
        }
        return null;
    }

    function findBoxPath(bytes, start, end, path) {
        let cursor = { contentStart: start, end };
        for (const type of path) {
            const found = findChildBox(bytes, cursor.contentStart, cursor.end, type);
            if (!found) return null;
            cursor = found;
        }
        return cursor;
    }

    // Media timescale of the first track, used to turn fragment decode times into ms.
    async function readTrackTimescale(reader, moov) {
        if (moov.size > MP4_MAX_HEADER_BOX_BYTES) return 0;
        const bytes = await reader.read(moov.start, moov.size);
        if (!bytes) return 0;
        const mdhd = findBoxPath(bytes, moov.contentStart - moov.start, bytes.length,
            ['trak', 'mdia', 'mdhd']);
        if (!mdhd) return 0;
        const version = bytes[mdhd.contentStart];
        const timescaleOffset = mdhd.contentStart + 4 + (version === 1 ? 16 : 8);
        if (timescaleOffset + 4 > mdhd.end) return 0;
        const timescale = readUint32(bytes, timescaleOffset);
        return timescale > 0 ? timescale : 0;
    }

    async function readFragmentDecodeTime(reader, moof) {
        if (moof.size > MP4_MAX_HEADER_BOX_BYTES) return null;
        const bytes = await reader.read(moof.start, moof.size);
        if (!bytes) return null;
        const tfdt = findBoxPath(bytes, moof.contentStart - moof.start, bytes.length,
            ['traf', 'tfdt']);
        if (!tfdt) return null;
        const version = bytes[tfdt.contentStart];
        if (version === 1) {
            if (tfdt.end - tfdt.contentStart < 12) return null;
            return readUint64(bytes, tfdt.contentStart + 4);
        }
        if (tfdt.end - tfdt.contentStart < 8) return null;
        return readUint32(bytes, tfdt.contentStart + 4);
    }

    /**
     * Regroups a fragmented MP4 into standalone files bounded by duration and size.
     * Returns null rather than throwing when the blob is not fragmented MP4, or when a
     * single fragment already exceeds the size limit, so callers can fall back.
     */
    async function splitFragmentedMp4(blob, options) {
        options = options || {};
        if (!blob || !(blob.size > 0) || typeof blob.slice !== 'function') return null;
        const maxSegmentMs = Math.max(1000,
            Number(options.maxSegmentMs) || MP4_DEFAULT_SEGMENT_MS);
        const maxSegmentBytes = Math.max(64 * 1024,
            Number(options.maxSegmentBytes) || MP4_DEFAULT_SEGMENT_BYTES);
        const totalDurationMs = Math.max(0, Number(options.totalDurationMs) || 0);
        const mimeType = options.mimeType || blob.type || 'audio/mp4';

        const reader = createBlobWindowReader(blob, MP4_WINDOW_BYTES);
        const fragments = [];
        let current = null;
        let pendingStart = -1;
        let initEnd = -1;
        let timescale = 0;
        let offset = 0;

        while (offset < blob.size) {
            const box = await readTopLevelBox(reader, offset);
            if (!box) return null;
            if (box.type === 'moov') {
                timescale = await readTrackTimescale(reader, box);
            } else if (box.type === 'styp') {
                if (initEnd >= 0 && pendingStart < 0) pendingStart = box.start;
            } else if (box.type === 'moof') {
                const start = pendingStart >= 0 ? pendingStart : box.start;
                pendingStart = -1;
                if (initEnd < 0) initEnd = start;
                if (current) {
                    current.end = start;
                    fragments.push(current);
                }
                const decodeTime = timescale > 0
                    ? await readFragmentDecodeTime(reader, box) : null;
                current = {
                    start,
                    end: blob.size,
                    startMs: decodeTime === null ? null : Math.round(decodeTime * 1000 / timescale)
                };
            }
            offset = box.end;
        }
        if (current) fragments.push(current);
        if (initEnd <= 0 || !fragments.length) return null;

        // Without tfdt there is no decode time to group by. Spreading the caller's known
        // length across the media bytes keeps segments near the intended duration rather
        // than falling back to size alone.
        const mediaBytes = Math.max(1, blob.size - initEnd);
        if (totalDurationMs > 0) {
            for (const fragment of fragments) {
                if (fragment.startMs === null) {
                    fragment.startMs =
                        Math.round((fragment.start - initEnd) / mediaBytes * totalDurationMs);
                }
            }
        }

        const groups = [];
        let group = null;
        for (const fragment of fragments) {
            const fragmentBytes = fragment.end - fragment.start;
            if (fragmentBytes < 1) continue;
            if (initEnd + fragmentBytes > maxSegmentBytes) return null;
            const overDuration = group && group.startMs !== null && fragment.startMs !== null &&
                fragment.startMs - group.startMs >= maxSegmentMs;
            const overBytes = group && group.bytes + fragmentBytes > maxSegmentBytes;
            if (group && (overDuration || overBytes)) {
                groups.push(group);
                group = null;
            }
            if (group) {
                group.end = fragment.end;
                group.bytes += fragmentBytes;
            } else {
                group = {
                    start: fragment.start,
                    end: fragment.end,
                    startMs: fragment.startMs,
                    bytes: initEnd + fragmentBytes
                };
            }
        }
        if (group) groups.push(group);
        if (!groups.length) return null;

        // The trailing segment has no successor to bound it. Prefer the caller's known
        // length, then the cadence of the fragments themselves, so it still reports one.
        const firstFragment = fragments[0];
        const lastFragment = fragments[fragments.length - 1];
        let averageFragmentMs = 0;
        if (fragments.length > 1 && firstFragment.startMs !== null &&
            lastFragment.startMs !== null && lastFragment.startMs > firstFragment.startMs) {
            averageFragmentMs = (lastFragment.startMs - firstFragment.startMs) /
                (fragments.length - 1);
        }
        const timelineEndMs = totalDurationMs > 0 ? totalDurationMs
            : (lastFragment.startMs === null ? null
                : Math.round(lastFragment.startMs + averageFragmentMs));

        const init = blob.slice(0, initEnd);
        return {
            container: 'mp4',
            initByteLength: initEnd,
            fragmentCount: fragments.length,
            segments: groups.map(function (item, index) {
                const next = groups[index + 1];
                const endMs = next && next.startMs !== null ? next.startMs : timelineEndMs;
                const durationMs = item.startMs !== null && endMs !== null && endMs > item.startMs
                    ? endMs - item.startMs : 0;
                return {
                    index,
                    startMs: item.startMs === null ? 0 : item.startMs,
                    durationMs,
                    byteLength: item.bytes,
                    mimeType,
                    blob: new Blob([init, blob.slice(item.start, item.end)], { type: mimeType })
                };
            })
        };
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

        const allowPartial = options.allowPartial === true;
        const minSuccessRatio = normalizeSuccessRatio(options.minSuccessRatio);
        const parts = [];
        const failures = [];
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
                        const failure = segmentError(error, index, total);
                        if (!allowPartial) throw failure;
                        failures.push({ index, error: failure });
                        parts.push(validateAiText(segmentPlaceholder(index, total, error,
                            options.placeholder)));
                        await emitProgress(onProgress, {
                            phase: 'segment-failed', index, total, attempt, error: failure
                        });
                        break;
                    }
                    await emitProgress(onProgress, {
                        phase: 'retry', index, total, attempt, error
                    });
                }
            }
        }

        const succeeded = total - failures.length;
        if (failures.length && (succeeded < 1 || succeeded / total < minSuccessRatio)) {
            // Too little of the recording came back to be worth saving; surface the first
            // real failure rather than a transcript that is mostly placeholders.
            throw failures[0].error;
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

        await emitProgress(onProgress, { phase: 'complete', total, failed: failures.length });
        return {
            content,
            merged,
            summary,
            parts: parts.slice(),
            segmentCount: total,
            failedSegments: failures.map(function (failure) {
                return { index: failure.index, message: failure.error.message };
            })
        };
    }

    return {
        validateAiText,
        mergeRecordingParts,
        splitFragmentedMp4,
        runRecordingNoteJob
    };
});
