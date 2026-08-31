const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(
    __dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'index.html'
), 'utf8');

function section(start, end) {
    const from = source.indexOf(start);
    assert.notEqual(from, -1, `missing section start: ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.notEqual(to, -1, `missing section end: ${end}`);
    return source.slice(from, to);
}

test('opening and reading a lecture never start cloud sync', () => {
    const open = section('async function openLecture(', 'async function displayLectureContent(');
    const progressFlush = section('function flushLectureProgressSync()',
        'function flushLectureProgressSave()');

    assert.doesNotMatch(open, /triggerSyncOnFileChange\s*\(/);
    assert.doesNotMatch(progressFlush, /triggerSyncOnFileChange\s*\(/);
    assert.match(progressFlush, /flushLectureDrawingSync\s*\(\)/);
});

test('new generation and regeneration use only lecture_upload', () => {
    const initialize = section('async function generateLecture(',
        'async function generateChapterContent(');
    const generate = section('async function generateChapterContent(',
        '// 讲义阅读器状态');
    const regenerate = section('async function confirmRegenerateLecture()',
        'let _lectureCardLongPressTimer');

    assert.doesNotMatch(initialize, /debouncedChatSync\s*\(/);
    assert.doesNotMatch(regenerate, /debouncedChatSync\s*\(/);
    assert.equal((generate.match(/'lecture_upload'/g) || []).length, 2,
        'one upload trigger plus one queue-priority check are expected');
    assert.doesNotMatch(generate, /sendNotification\s*\(/);
    assert.match(generate, /toast_lecture_generated/);
});

test('handwriting is marked only by actual drawing changes and synced in one flush', () => {
    const saveDrawing = section('function saveLectureDrawing(changed = false)',
        'function loadLectureDrawing()');
    const drawingFlush = section('function flushLectureDrawingSync()',
        '// Apple Pencil 模式');

    assert.match(saveDrawing, /if \(changed && currentLecture/);
    assert.match(saveDrawing, /chapter\.drawingUpdatedAt = Date\.now\(\)/);
    assert.match(saveDrawing, /_lectureDrawingSyncPending = true/);
    assert.doesNotMatch(saveDrawing, /triggerSyncOnFileChange\s*\(/);
    assert.equal((drawingFlush.match(/triggerSyncOnFileChange\s*\(/g) || []).length, 1);
    assert.match(drawingFlush, /'lecture_drawing_update'/);
});

test('handwriting metadata merges independently from body and reading progress', () => {
    const merge = section('function mergeLecturesData(', 'let _cloudMetaBackupDay');
    assert.match(merge, /cloudChapter\.drawingUpdatedAt/);
    assert.match(merge, /localChapter\.drawingUpdatedAt/);
    assert.match(merge, /drawingStrokes/);
});
