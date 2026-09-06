const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const appHtml = fs.readFileSync(
    path.join(root, 'app/src/main/assets/www/index.html'), 'utf8');
const docsHtml = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');

function loadPositionHelpers(exercises) {
    const start = appHtml.indexOf('function exFindTask');
    const end = appHtml.indexOf('function exPositionCloudReady', start);
    assert.ok(start >= 0 && end > start, 'exercise position helper block exists');
    const storage = new Map();
    const context = {
        getExercisesData() { return exercises; },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, String(value)); }
        },
        saveData() {},
        console: { warn() {} }
    };
    vm.createContext(context);
    vm.runInContext(
        `${appHtml.slice(start, end)}\nthis.helpers = {` +
        'remember: exRememberOpenedQuestion, read: exReadLocalPosition, ' +
        'latest: exLatestPosition, resolve: exResolveOpeningQuestionIndex };',
        context
    );
    return context.helpers;
}

function loadExerciseStarter(exercises, cloudPosition, opened) {
    const start = appHtml.indexOf('function exFindTask');
    const end = appHtml.indexOf('async function openExerciseDoing', start);
    assert.ok(start >= 0 && end > start, 'exercise opening source block exists');
    const storage = new Map();
    const context = {
        appData: { settings: { r2Config: {
            accessKeyId: 'key', secretKey: 'secret', endpoint: 'https://example.test',
            bucketName: 'bucket', autoSyncOnChange: true
        } } },
        currentExerciseFolder: { folderId: 'folder-1' },
        document: {
            getElementById() { return { classList: { contains() { return true; } } }; }
        },
        getExercisesData() { return exercises; },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, String(value)); },
            removeItem(key) { storage.delete(key); }
        },
        r2StartupMetadataReady: new Promise(() => {}),
        async r2GetObjectWithTimeout() { return JSON.stringify(cloudPosition); },
        async r2PutObject() {},
        async r2DeleteObject() {},
        async openExerciseDoing(folderId, taskId, questionIndex, isWrong) {
            opened.push({ folderId, taskId, questionIndex, isWrong });
        },
        saveData() {},
        showToast() {},
        i18n(value) { return value; },
        console: { warn() {} },
        setTimeout,
        clearTimeout
    };
    vm.createContext(context);
    vm.runInContext(`${appHtml.slice(start, end)}\nthis.start = startExerciseTask;`, context);
    return context.start;
}

test('keeps the hosted page and APK exercise logic identical', () => {
    assert.equal(appHtml, docsHtml);
});

test('reopens the last viewed question before falling back to the first pending one', () => {
    const questions = Array.from({ length: 8 }, (_, index) => ({
        status: index < 4 ? 'done' : 'pending'
    }));
    const task = { id: 'task-1', questions };
    const exercises = { folders: [{ id: 'folder-1', tasks: [task] }] };
    const helpers = loadPositionHelpers(exercises);

    assert.equal(helpers.remember('folder-1', 'task-1', 6), true);
    const saved = helpers.read('task-1');
    assert.equal(saved.lastOpenedQuestionIndex, 6);
    assert.equal(helpers.resolve(task, helpers.latest(task, saved)), 6);

    assert.equal(helpers.resolve(task, {
        lastOpenedQuestionIndex: 99,
        lastOpenedQuestionUpdatedAt: 2
    }), 4);
    assert.equal(helpers.resolve(task, null), 4);
    assert.equal(helpers.resolve({ questions: questions.map(() => ({ status: 'done' })) }, null), 0);
});

test('task entry passes the saved seventh question through the real opening path', async () => {
    const questions = Array.from({ length: 8 }, (_, index) => ({
        status: index < 4 ? 'done' : 'pending'
    }));
    const task = {
        id: 'task-1',
        questions,
        lastOpenedQuestionIndex: 6,
        lastOpenedQuestionUpdatedAt: 10
    };
    const exercises = { folders: [{ id: 'folder-1', tasks: [task] }] };
    const opened = [];
    const start = loadExerciseStarter(exercises, {
        taskId: 'task-1',
        lastOpenedQuestionIndex: 6,
        lastOpenedQuestionUpdatedAt: 10
    }, opened);

    await Promise.race([
        start('folder-1', 'task-1'),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('local exercise opening waited for cloud startup')), 100))
    ]);
    assert.deepEqual(opened, [{
        folderId: 'folder-1', taskId: 'task-1', questionIndex: 6, isWrong: false
    }]);
});
