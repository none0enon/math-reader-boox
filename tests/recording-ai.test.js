'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appModulePath = path.join(__dirname, '../app/src/main/assets/www/recording-ai.js');
const docsModulePath = path.join(__dirname, '../docs/recording-ai.js');
const {
    validateAiText,
    mergeRecordingParts,
    runRecordingNoteJob
} = require(appModulePath);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

test('PWA and APK recording AI modules stay byte-identical', () => {
    assert.equal(fs.readFileSync(docsModulePath, 'utf8'), fs.readFileSync(appModulePath, 'utf8'));
});

test('validateAiText rejects blank and implausibly short model output', () => {
    assert.throws(() => validateAiText(), error => error.code === 'AI_TEXT_EMPTY');
    assert.throws(() => validateAiText(' \n\t '), error => error.code === 'AI_TEXT_EMPTY');
    assert.throws(() => validateAiText('short'), error => error.code === 'AI_TEXT_TOO_SHORT');
    assert.equal(validateAiText('  sufficiently detailed transcript  '), 'sufficiently detailed transcript');
    assert.equal(validateAiText('  \u8fd9\u662f\u4e00\u6bb5\u5b8c\u6574\u8f6c\u5199\u5185\u5bb9  '), '\u8fd9\u662f\u4e00\u6bb5\u5b8c\u6574\u8f6c\u5199\u5185\u5bb9');
});

test('mergeRecordingParts deterministically preserves every validated part', () => {
    const parts = [
        'First segment contains theorem and proof details.',
        'Second segment contains examples and conclusions.'
    ];
    const first = mergeRecordingParts(parts, { ref: 'course-001' });
    const second = mergeRecordingParts(parts, { ref: 'course-001' });
    assert.equal(first, second);
    assert.match(first, /## \u5f55\u97f3\u5206\u6bb5 1\/2 \{ref:course-001\}/);
    assert.match(first, /## \u5f55\u97f3\u5206\u6bb5 2\/2 \{ref:course-001\}/);
    for (const part of parts) assert.ok(first.includes(part));
    assert.ok(first.indexOf(parts[0]) < first.indexOf(parts[1]));
    assert.equal(mergeRecordingParts([parts[0]], { ref: 'ignored-for-one-part' }), parts[0]);
});

test('runRecordingNoteJob transcribes segments strictly serially and in order', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started = [];
    const progress = [];
    let active = 0;
    let maxActive = 0;
    const job = runRecordingNoteJob({
        segments: ['s1', 's2', 's3'],
        transcribe: async (segment, context) => {
            started.push({ segment, index: context.index });
            active++;
            maxActive = Math.max(maxActive, active);
            const result = await gates[context.index].promise;
            active--;
            return result;
        },
        onProgress: event => { progress.push(event.phase + ':' + (event.index ?? '-')); }
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, [{ segment: 's1', index: 0 }]);
    gates[0].resolve('Transcript for segment one is complete.');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started.map(item => item.segment), ['s1', 's2']);
    gates[1].resolve('Transcript for segment two is complete.');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started.map(item => item.segment), ['s1', 's2', 's3']);
    gates[2].resolve('Transcript for segment three is complete.');

    const result = await job;
    assert.equal(maxActive, 1);
    assert.deepEqual(result.parts, [
        'Transcript for segment one is complete.',
        'Transcript for segment two is complete.',
        'Transcript for segment three is complete.'
    ]);
    assert.deepEqual(progress, [
        'transcribe:0', 'transcribed:0',
        'transcribe:1', 'transcribed:1',
        'transcribe:2', 'transcribed:2',
        'complete:-'
    ]);
});

test('empty segment output is retryable but never committed as success', async () => {
    let calls = 0;
    const progress = [];
    const result = await runRecordingNoteJob({
        segments: ['segment'],
        retry: 1,
        transcribe: async () => {
            calls++;
            return calls === 1 ? '   ' : 'Recovered transcript after one retry.';
        },
        onProgress: event => progress.push(event.phase)
    });

    assert.equal(calls, 2);
    assert.equal(result.content, 'Recovered transcript after one retry.');
    assert.deepEqual(progress, ['transcribe', 'retry', 'transcribe', 'transcribed', 'complete']);
});

test('a failed segment rejects the whole job and stops later work', async () => {
    const seen = [];
    let summarized = false;
    await assert.rejects(runRecordingNoteJob({
        segments: ['one', 'two', 'three'],
        transcribe: async segment => {
            seen.push(segment);
            if (segment === 'two') throw new Error('network stopped');
            return 'Complete transcript for segment ' + segment + '.';
        },
        summarize: async () => {
            summarized = true;
            return 'This summary must not run after failure.';
        }
    }), error => {
        assert.equal(error.code, 'RECORDING_SEGMENT_FAILED');
        assert.equal(error.segmentIndex, 1);
        assert.match(error.message, /2\/3/);
        return true;
    });
    assert.deepEqual(seen, ['one', 'two']);
    assert.equal(summarized, false);
});

test('optional overview cannot replace or omit deterministic segment text', async () => {
    const transcripts = [
        'Detailed first transcript with definitions and arguments.',
        'Detailed second transcript with results and conclusions.'
    ];
    let summarizeInput = null;
    let summarizeContext = null;
    const result = await runRecordingNoteJob({
        segments: ['one', 'two'],
        transcribe: async (_segment, context) => transcripts[context.index],
        summarize: async (merged, context) => {
            summarizeInput = merged;
            summarizeContext = context;
            return 'Short overview covering both recording segments.';
        }
    });

    assert.equal(summarizeInput, result.merged);
    assert.equal(summarizeContext.mode, 'overview');
    assert.equal(summarizeContext.total, 2);
    assert.equal(result.summary, 'Short overview covering both recording segments.');
    assert.ok(result.content.endsWith(result.merged));
    for (const transcript of transcripts) {
        assert.ok(result.merged.includes(transcript));
        assert.ok(result.content.includes(transcript));
    }
});

test('blank optional overview rejects instead of reporting a fake completed job', async () => {
    const progress = [];
    await assert.rejects(runRecordingNoteJob({
        segments: ['one', 'two'],
        transcribe: async (_segment, context) =>
            'Complete transcript for segment number ' + (context.index + 1) + '.',
        summarize: async () => '   ',
        onProgress: event => progress.push(event.phase)
    }), error => error.code === 'AI_TEXT_EMPTY');
    assert.equal(progress.includes('complete'), false);
});
