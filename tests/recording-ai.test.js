'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RecordingAI = require('../app/src/main/assets/www/recording-ai.js');

test('normalizes Safari AAC recordings for Gemini Files API', () => {
    assert.equal(RecordingAI.normalizeGeminiAudioMime('audio/mp4;codecs=mp4a.40.2'),
        'audio/m4a');
    assert.equal(RecordingAI.supportsGeminiFileAudio('audio/mp4'), true);
});

test('routes long iOS recordings to Gemini without routing unsupported WebM', () => {
    const longRecording = {
        durationSeconds: 90 * 60,
        byteLength: 80 * 1024 * 1024,
        maxDurationMs: 5 * 60 * 1000,
        maxBytes: 10 * 1024 * 1024
    };
    assert.equal(RecordingAI.shouldUseGeminiFileAudio({
        ...longRecording,
        mimeType: 'audio/mp4'
    }), true);
    assert.equal(RecordingAI.shouldUseGeminiFileAudio({
        ...longRecording,
        mimeType: 'audio/webm'
    }), false);
});
