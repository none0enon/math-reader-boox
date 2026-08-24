'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const RecordingAI = require(path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www',
    'recording-ai.js'));

function makeSegments(count) {
    return Array.from({ length: count }, (_, index) => ({ index }));
}

function transcriptFor(index) {
    return 'Segment ' + (index + 1) + ' transcript text';
}

test('validateAiText rejects empty and too-short responses', () => {
    assert.throws(() => RecordingAI.validateAiText(''), /empty/);
    assert.throws(() => RecordingAI.validateAiText('   \n  '), /empty/);
    assert.throws(() => RecordingAI.validateAiText('short'), /too short/);
    assert.throws(() => RecordingAI.validateAiText(null), /must be text/);
    assert.strictEqual(RecordingAI.validateAiText('  a full enough answer  '),
        'a full enough answer');
});

test('mergeRecordingParts keeps one part verbatim and labels several', () => {
    assert.strictEqual(RecordingAI.mergeRecordingParts(['only one part here']),
        'only one part here');

    const merged = RecordingAI.mergeRecordingParts(['first part text', 'second part text'],
        { ref: 'M1' });
    assert.match(merged, /^## 录音分段 1\/2 \{ref:M1\}\n\nfirst part text/);
    assert.match(merged, /## 录音分段 2\/2 \{ref:M1\}\n\nsecond part text$/);
});

test('mergeRecordingParts strips separators that would break the ref tag', () => {
    const merged = RecordingAI.mergeRecordingParts(['first part text', 'second part text'],
        { ref: 'a{b}\nc' });
    assert.match(merged, /\{ref:a b c\}/);
});

test('runRecordingNoteJob transcribes every segment in order', async () => {
    const seen = [];
    const job = await RecordingAI.runRecordingNoteJob({
        segments: makeSegments(3),
        transcribe: async (segment, context) => {
            seen.push(context.index);
            return transcriptFor(context.index);
        }
    });

    assert.deepStrictEqual(seen, [0, 1, 2]);
    assert.strictEqual(job.segmentCount, 3);
    assert.deepStrictEqual(job.parts,
        [transcriptFor(0), transcriptFor(1), transcriptFor(2)]);
    assert.deepStrictEqual(job.failedSegments, []);
    assert.ok(job.content.includes(transcriptFor(2)));
});

test('runRecordingNoteJob retries a failing segment up to the retry budget', async () => {
    let attempts = 0;
    const job = await RecordingAI.runRecordingNoteJob({
        segments: makeSegments(1),
        retry: 2,
        transcribe: async () => {
            attempts++;
            if (attempts < 3) throw new Error('transient upstream failure');
            return transcriptFor(0);
        }
    });

    assert.strictEqual(attempts, 3);
    assert.strictEqual(job.content, transcriptFor(0));
});

test('runRecordingNoteJob discards the job when a segment fails and partials are off', async () => {
    await assert.rejects(RecordingAI.runRecordingNoteJob({
        segments: makeSegments(3),
        transcribe: async (segment, context) => {
            if (context.index === 1) throw new Error('model refused this audio');
            return transcriptFor(context.index);
        }
    }), error => {
        assert.strictEqual(error.code, 'RECORDING_SEGMENT_FAILED');
        assert.strictEqual(error.segmentIndex, 1);
        assert.match(error.message, /segment 2\/3 failed: model refused this audio/);
        return true;
    });
});

test('allowPartial keeps a long transcript when one segment cannot be transcribed', async () => {
    // The reported failure: an 80-90 minute lecture is close to twenty sequential model
    // calls, and one bad response used to throw away every finished segment.
    const total = 18;
    const job = await RecordingAI.runRecordingNoteJob({
        segments: makeSegments(total),
        allowPartial: true,
        transcribe: async (segment, context) => {
            if (context.index === 7) throw new Error('model refused this audio');
            return transcriptFor(context.index);
        }
    });

    assert.strictEqual(job.segmentCount, total);
    assert.strictEqual(job.parts.length, total);
    assert.deepStrictEqual(job.failedSegments.map(item => item.index), [7]);
    assert.match(job.failedSegments[0].message, /model refused this audio/);
    assert.ok(job.content.includes(transcriptFor(0)));
    assert.ok(job.content.includes(transcriptFor(17)));
    assert.ok(job.content.includes('[transcription unavailable]'));
});

test('allowPartial uses the caller placeholder and reports the failure phase', async () => {
    const phases = [];
    const job = await RecordingAI.runRecordingNoteJob({
        segments: makeSegments(4),
        allowPartial: true,
        placeholder: (index, total) => '第 ' + (index + 1) + '/' + total + ' 段转写失败',
        onProgress: event => phases.push(event.phase),
        transcribe: async (segment, context) => {
            if (context.index === 2) throw new Error('model refused this audio');
            return transcriptFor(context.index);
        }
    });

    assert.ok(job.content.includes('第 3/4 段转写失败'));
    assert.ok(!job.content.includes('[transcription unavailable]'));
    assert.ok(phases.includes('segment-failed'));
    assert.strictEqual(phases[phases.length - 1], 'complete');
});

test('allowPartial still fails when too little of the recording came back', async () => {
    await assert.rejects(RecordingAI.runRecordingNoteJob({
        segments: makeSegments(4),
        allowPartial: true,
        transcribe: async (segment, context) => {
            if (context.index === 0) return transcriptFor(0);
            throw new Error('model refused this audio');
        }
    }), error => {
        assert.strictEqual(error.code, 'RECORDING_SEGMENT_FAILED');
        assert.strictEqual(error.segmentIndex, 1);
        return true;
    });
});

test('minSuccessRatio bounds how much of a recording may be missing', async () => {
    const options = index => ({
        segments: makeSegments(4),
        allowPartial: true,
        transcribe: async (segment, context) => {
            if (context.index >= index) throw new Error('model refused this audio');
            return transcriptFor(context.index);
        }
    });

    // Half transcribed: rejected by the default ratio, accepted when the caller lowers it.
    await assert.rejects(RecordingAI.runRecordingNoteJob(options(2)));
    const relaxed = await RecordingAI.runRecordingNoteJob(
        Object.assign(options(2), { minSuccessRatio: 0.5 }));
    assert.strictEqual(relaxed.failedSegments.length, 2);

    // Out-of-range ratios clamp to [0, 1]; clamping to 1 means nothing may be missing.
    await assert.rejects(RecordingAI.runRecordingNoteJob(
        Object.assign(options(3), { minSuccessRatio: 2 })), /segment 4\/4 failed/);
    const anyIsEnough = await RecordingAI.runRecordingNoteJob(
        Object.assign(options(1), { minSuccessRatio: -1 }));
    assert.strictEqual(anyIsEnough.failedSegments.length, 3);
});

test('a partial job still produces a mergeable transcript for every segment', async () => {
    const job = await RecordingAI.runRecordingNoteJob({
        segments: makeSegments(5),
        allowPartial: true,
        ref: 'M7',
        transcribe: async (segment, context) => {
            if (context.index === 4) throw new Error('model refused this audio');
            return transcriptFor(context.index);
        }
    });

    for (let index = 1; index <= 5; index++) {
        assert.ok(job.merged.includes('## 录音分段 ' + index + '/5 {ref:M7}'),
            'segment ' + index + ' is missing from the merged transcript');
    }
});

test('runRecordingNoteJob rejects an empty or malformed job', async () => {
    await assert.rejects(RecordingAI.runRecordingNoteJob({ transcribe: async () => 'text here' }),
        /segments are required/);
    await assert.rejects(RecordingAI.runRecordingNoteJob({ segments: [] }),
        /segments are required/);
    await assert.rejects(RecordingAI.runRecordingNoteJob({ segments: makeSegments(1) }),
        /transcribe function is required/);
});
