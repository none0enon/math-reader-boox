'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExerciseUpload = require('../app/src/main/assets/www/exercise-upload.js');

test('rejects an HTML login page renamed with a PDF extension', () => {
    const loginPage = Buffer.from('<!DOCTYPE html><html><title>IU Login</title></html>');
    assert.equal(ExerciseUpload.hasPdfHeader(loginPage), false);
});

test('accepts a PDF header within the first 1024 bytes', () => {
    const pdf = Buffer.concat([Buffer.from('\ufeff\n'), Buffer.from('%PDF-1.7\n')]);
    assert.equal(ExerciseUpload.hasPdfHeader(pdf), true);
});

test('keeps only non-empty recognized question strings', () => {
    assert.deepEqual(
        ExerciseUpload.validQuestionStrings(['1. Solve x = 2.', '', 'Q', { text: 'not a string' }]),
        ['1. Solve x = 2.']
    );
});
