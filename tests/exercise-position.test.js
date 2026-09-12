// Run: node tests/exercise-position.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['docs/index.html', 'app/src/main/assets/www/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    function source(name) {
        const start = html.indexOf('        function ' + name + '(');
        const end = html.indexOf('\n        }', start);
        assert.ok(start >= 0 && end > start, file + ': ' + name);
        return html.slice(start, end + 10);
    }
    const code = ['getExercisesData', 'exFindTask', 'exLocalPositionKey', 'exPositionTimestamp',
        'exTaskPosition', 'exPositionIsValid', 'exReadLocalPosition', 'exLatestPosition',
        'exApplyPosition', 'exRememberOpenedQuestion', 'exResolveOpeningQuestionIndex'].map(source).join('\n');
    function session(storage = new Map()) {
        const task = {
            id: 'task', lastOpenedQuestionIndex: 3, lastOpenedQuestionUpdatedAt: 100,
            questions: Array.from({ length: 9 }, (_, index) => ({ status: index === 5 ? 'done' : 'pending' }))
        };
        const saved = [];
        const context = vm.createContext({
            appData: { exercises: { folders: [{ id: 'folder', tasks: [task] }] } },
            Date: { now: () => 1000 }, console: { warn() {} }, failWrites: false,
            localStorage: {
                getItem: key => storage.get(key) || null,
                setItem(key, value) {
                    if (context.failWrites) throw new Error('Storage unavailable');
                    storage.set(key, value);
                }
            },
            saveData: () => saved.push(JSON.parse(JSON.stringify(task)))
        });
        vm.runInContext(code, context, { filename: file });
        return { context, task, saved, storage };
    }
    const first = session();
    const key = first.context.exLocalPositionKey('task');
    assert.equal(key, 'mathReaderExercisePosition_task');
    const remember = (state, index, force = false) => state.context.exRememberOpenedQuestion('folder', 'task', index, force);

    // Opening an unfinished eighth question records it immediately; question 1 is
    // also pending and question 6 is completed, so neither is the resume target.
    assert.equal(remember(first, 7), true);
    const position = JSON.parse(first.storage.get(key));
    assert.deepEqual(position, { taskId: 'task', lastOpenedQuestionIndex: 7, lastOpenedQuestionUpdatedAt: 1000 });
    assert.equal(first.task.lastOpenedQuestionIndex, 7);
    assert.equal(first.task.questions[7].status, 'pending');
    assert.equal(first.saved.length, 0, file + ': ordinary navigation must not save all app data');

    // Simulate restart with old metadata and only the synchronously saved shadow.
    const restarted = session(new Map(first.storage));
    const latest = restarted.context.exLatestPosition(restarted.task,
        restarted.context.exTaskPosition(restarted.task), restarted.context.exReadLocalPosition('task'));
    assert.equal(restarted.context.exResolveOpeningQuestionIndex(restarted.task, latest), 7);
    restarted.context.exApplyPosition(restarted.task, latest);
    assert.equal(restarted.task.lastOpenedQuestionIndex, 7);
    assert.equal(restarted.saved.length, 1, 'existing metadata reconciliation remains persistent');

    assert.equal(remember(first, 6), true, 'previous question also records the opened position');
    assert.equal(first.task.lastOpenedQuestionIndex, 6);
    assert.equal(JSON.parse(first.storage.get(key)).lastOpenedQuestionIndex, 6);
    assert.equal(first.saved.length, 0);
    const unchanged = JSON.stringify(first.task);
    const unchangedStorage = first.storage.get(key);
    assert.equal(remember(first, 6), false);
    assert.equal(JSON.stringify(first.task), unchanged, 'reopening the same question does not advance its timestamp');
    assert.equal(first.storage.get(key), unchangedStorage);
    assert.equal(first.saved.length, 0);

    for (const index of [-1, 9, 1.5, '7', NaN, null]) assert.equal(remember(first, index), false);
    assert.equal(first.context.exRememberOpenedQuestion('missing', 'task', 7), false);
    assert.equal(first.context.exRememberOpenedQuestion('folder', 'missing', 7), false);
    assert.equal(JSON.stringify(first.task), unchanged);
    assert.equal(first.storage.get(key), unchangedStorage);
    assert.equal(first.saved.length, 0);

    // Clock skew cannot make a newly opened question older than either source.
    first.task.lastOpenedQuestionUpdatedAt = 5000;
    first.storage.set(key, JSON.stringify({ taskId: 'task', lastOpenedQuestionIndex: 2, lastOpenedQuestionUpdatedAt: 6000 }));
    assert.equal(remember(first, 7), true);
    assert.equal(first.task.lastOpenedQuestionUpdatedAt, 6001);
    assert.equal(JSON.parse(first.storage.get(key)).lastOpenedQuestionUpdatedAt, 6001);
    assert.equal(first.saved.length, 0);

    // Storage failure falls back only after the latest opened position is in memory.
    first.context.failWrites = true;
    assert.equal(remember(first, 8), true);
    assert.equal(first.saved.length, 1);
    assert.equal(first.saved[0].lastOpenedQuestionIndex, 8);
    assert.equal(first.saved[0].lastOpenedQuestionUpdatedAt, 6002);
    first.context.failWrites = false;
    assert.equal(remember(first, 8, true), true, 'force preserves its existing persistence path');
    assert.equal(first.saved.length, 2);
    assert.equal(first.saved[1].lastOpenedQuestionIndex, 8);
    assert.equal(first.saved[1].lastOpenedQuestionUpdatedAt, 6003);
    assert.equal(JSON.parse(first.storage.get(key)).lastOpenedQuestionUpdatedAt, 6003);

    // A newer shadow for the same question still reconciles stale metadata.
    first.task.lastOpenedQuestionUpdatedAt = 100;
    assert.equal(remember(first, 8), false);
    assert.equal(first.task.lastOpenedQuestionUpdatedAt, 6003);
    assert.equal(first.saved.length, 3);
    console.log(file + ': last-opened exercise position checks passed.');
}
