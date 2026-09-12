// Run with: node tests/cloud-sync-restore.test.js
// Product functions run unchanged; ZIP decoding, DOM, IndexedDB and R2 stay in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const clone = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const asyncNoop = async () => {};
function source(html, start) {
    const lineEnd = html.indexOf('\n', start);
    const end = html.slice(start, lineEnd).trimEnd().endsWith('}')
        ? lineEnd : html.indexOf('\n        }', lineEnd) + 10;
    return html.slice(start, end);
}
function data(newer = false) {
    return {
        books: [], papers: [], archived: [], notes: { note: newer ? 'new cloud note' : 'old backup note' },
        drafts: { draft: { html: newer ? 'new cloud draft' : 'old backup draft' } },
        settings: { r2Config: { accessKeyId: 'memory-only', autoSyncEnabled: true } },
        lectures: {}, lectureDrafts: {}, classroom: { courses: [], seminars: [] },
        classroomTombstones: [], classroomSyncOutbox: [], notebooks: { items: [], reviews: [] },
        exercises: { folders: [{ id: 'folder', name: 'Folder', tasks: [] },
            ...(newer ? [{ id: 'cloud-only-folder', name: 'New cloud folder', tasks: [] }] : [])],
            wrongByFolder: {}, archivedWrong: {} },
        syncedAt: newer ? '2026-09-10T00:00:00.000Z' : '2026-09-01T00:00:00.000Z'
    };
}
function harness(html, local, remote) {
    const cloud = new Map([['metadata.json', JSON.stringify(remote)]]), idb = new Map(), storage = new Map();
    const calls = [], errors = [], toasts = [], timers = new Map();
    let nextTimer = 0;
    const element = { style: {}, classList: { remove: noop, add: noop, contains: () => false },
        innerHTML: '', textContent: '', querySelectorAll: () => [] };
    const context = vm.createContext({ appData: clone(local), appDataLoaded: true, window: {},
        document: { body: element, createElement: () => ({ ...element }), getElementById: () => element,
            querySelectorAll: () => [] },
        console: { log: noop, warn: (...a) => errors.push(a.map(String).join(' ')),
            error: (...a) => errors.push(a.map(String).join(' ')) },
        localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
        setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
        clearTimeout: id => timers.delete(id),
        currentExerciseFolder: null, currentExerciseTask: null, exDoingState: null,
        _chatSyncTimer: null, activeLectureGenerationCount: 0, r2SyncInProgress: false,
        r2PendingSyncQueue: [], r2DeferredMetadataPublish: false, r2ClassroomRetryTimers: new Map(),
        r2LastSyncTime: null, _resolveR2StartupMetadataReady: null, _cloudMetaBackupDay: null,
        _exercisesDataSavePromise: Promise.resolve(true), _exGradedPagesSavePromise: Promise.resolve(),
        _exGradedCloudCommitCounter: 0, _exPendingGradedCloudCommits: new Map(),
        _exPositionSyncGeneration: 0, _exPendingPositionChoices: {}, _exPositionSyncTimer: null,
        _exPositionSyncTarget: null,
    });
    // Load declarations only: no app initialization, listeners, real fetch or credentials.
    for (const match of html.matchAll(/^        (?:async )?function [\w$]+\(/gm)) {
        vm.runInContext(source(html, match.index), context);
    }
    for (const name of ['API_LOCAL_ONLY_KEYS', 'CLASSROOM_DELETE_ACTIONS']) {
        const declaration = html.match(new RegExp('        const ' + name + ' = \\[[\\s\\S]*?\\];'));
        assert.ok(declaration, name + ' exists');
        vm.runInContext(declaration[0], context);
    }
    Object.assign(context, {
        confirm: () => true, i18n: key => key, showToast: key => toasts.push(key),
        dataZipRead: async () => ({ 'metadata.json': JSON.stringify(local) }), dataZipText: async value => value,
        saveFileData: async (key, value) => idb.set(key, value), getFileData: async key => idb.get(key) ?? null,
        deleteFileData: async key => idb.delete(key), saveBlobsToIDB: asyncNoop,
        backupAppDataToIDB: noop, restoreBlobsFromIDB: asyncNoop,
        applySettings: noop, renderLibrary: noop, renderNotesPage: noop, renderClassroomPage: noop,
        renderNotebooksPage: noop, refreshAllUIFromAppData: noop,
        cleanupClassroomEntriesRemovedByMerge: asyncNoop,
        r2GetObject: async (key, options) => {
            calls.push('GET ' + key);
            const value = cloud.get(key);
            return options?.withMetadata ? { data: value, etag: 'memory-etag', missing: !value } : value;
        },
        r2PutObject: async (key, value) => { calls.push('PUT ' + key); cloud.set(key, value); }
    });
    async function drainTimers() {
        for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); }
        // Debounced callbacks start async work without returning its promise.
        for (let i = 0; i < 100; i++) await Promise.resolve();
        assert.equal(context.r2SyncInProgress, false, 'scheduled sync finished');
    }
    return { context, cloud, idb, calls, errors, toasts, drainTimers };
}
async function checkImport(html) {
    const local = data(), remote = data(true);
    remote.notes.cloudOnly = 'new cloud-only note';
    local.exercises.wrongByFolder.folder = [{ taskId: 'task', taskName: 'Task', questions: [
        { questionIndex: 0, score: 1 }, { questionIndex: 0, score: 2 }
    ] }];
    const h = harness(html, local, remote);
    await h.context.importDataZip({ target: { value: 'old.zip', files: [{}] } });
    await h.drainTimers();
    assert.ok(h.toasts.includes('import_complete_files'), 'ZIP import completed');
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.calls, [], 'importing an old backup must not read or overwrite cloud metadata');
    assert.deepEqual(JSON.parse(h.cloud.get('metadata.json')), remote, 'all newer cloud modules survive import');
    assert.equal(h.context.appData.notes.note, 'old backup note', 'import actually restored the old local data');
    const wrong = h.context.appData.exercises.wrongByFolder.folder[0].questions;
    assert.equal(wrong.length, 1, 'import still deduplicates old wrong questions locally');
    assert.equal(wrong[0].score, 2, 'deduplication keeps the latest wrong answer');
    // The restore fix must preserve normal user-initiated metadata publication.
    h.context.appData.notes.note = 'intentional local edit';
    await h.context.triggerSyncOnFileChange(null, 'metadata_update');
    assert.deepEqual(h.errors, []);
    assert.equal(h.calls.filter(call => call === 'PUT metadata.json').length, 1);
    assert.equal(JSON.parse(h.cloud.get('metadata.json')).notes.note, 'intentional local edit');
}
async function checkStartup(html) {
    const local = data(), remote = data(true);
    const notebook = at => ({ items: [{ id: 'nb', updatedAt: at, pages: [{ id: 'p1', updatedAt: at }] }], reviews: [] });
    local.notebooks = notebook(local.syncedAt);
    remote.notebooks = notebook(remote.syncedAt);
    remote.notebooks.items[0].pages.push({ id: 'p2', updatedAt: remote.syncedAt });
    local.exercises.wrongByFolder.folder = [{ taskId: 'old-task', questions: [{ questionIndex: 0, score: 1 }] }];
    const h = harness(html, local, remote);
    const page = (updatedAt, text) => JSON.stringify({ updatedAt, strokes: [], texts: [{ text }], media: [], recognized: null });
    h.idb.set('nbpage_p1', page(local.syncedAt, 'OLD BACKUP PAGE'));
    h.idb.set('exercise_drawing_old-task_0', 'old local exercise image');
    h.cloud.set('notebooks/pages/nbpage_p1', page(remote.syncedAt, 'NEW CLOUD PAGE'));
    h.cloud.set('notebooks/pages/nbpage_p2', page(remote.syncedAt, 'CLOUD ONLY PAGE'));
    const before = new Map(h.cloud);
    await h.context.autoSyncFromR2OnStartup();
    await h.drainTimers();
    assert.deepEqual(h.errors, []);
    assert.deepEqual(h.calls.filter(call => call.startsWith('PUT notebooks/')), [],
        'exercise metadata repair must not upload old or missing notebook pages');
    assert.ok(h.calls.includes('PUT metadata.json'), 'merged exercise metadata still uploads');
    const metadata = JSON.parse(h.cloud.get('metadata.json'));
    assert.equal(metadata.notes.note, remote.notes.note);
    assert.equal(metadata.drafts.draft.html, remote.drafts.draft.html);
    assert.ok(metadata.exercises.folders.some(folder => folder.id === 'cloud-only-folder'));
    assert.equal(metadata.exercises.wrongByFolder.folder[0].taskId, 'old-task');
    for (const id of ['p1', 'p2']) {
        assert.equal(h.cloud.get('notebooks/pages/nbpage_' + id), before.get('notebooks/pages/nbpage_' + id),
            'newer cloud page remains unchanged: ' + id);
        assert.ok(h.calls.includes('GET notebooks/pages/nbpage_' + id), 'downloads ' + id);
        assert.equal(h.idb.get('nbpage_' + id), h.cloud.get('notebooks/pages/nbpage_' + id));
    }
    assert.equal(h.context.appData.notes.note, remote.notes.note);
    assert.equal(h.context.appData.drafts.draft.html, remote.drafts.draft.html);
    assert.ok(h.context.appData.exercises.folders.some(folder => folder.id === 'cloud-only-folder'));
}
async function checkOldGrading(html) {
    for (const imported of [true, false]) {
        const local = data(), remote = data(true);
        const task = (score, id, committed) => ({ id: 'task', questions: [{ index: 0, status: 'done', score,
            gradedDrawingCommitId: id, gradedDrawingCloudCommitted: committed, userDrawingPages: 1 }] });
        local.exercises.folders[0].tasks = [task(10, 'local-pending', false)];
        remote.exercises.folders[0].tasks = [task(99, 'cloud-committed', true)];
        const h = harness(html, local, remote);
        const key = 'exercise_drawing_task_0';
        h.idb.set(key, 'LOCAL PENDING IMAGE');
        h.cloud.set('exercises/drawings/' + key, 'CLOUD COMMITTED IMAGE');
        if (imported) {
            await h.context.importDataZip({ target: { value: 'old.zip', files: [{}] } });
            await h.drainTimers();
            assert.ok(h.toasts.includes('import_complete_files'));
            assert.equal(h.context.appData.exercises.folders[0].tasks[0].questions[0].gradedDrawingCloudCommitted,
                undefined, 'backup import discards old pending upload intent');
            const persisted = JSON.parse(h.idb.get('__exercises_data__'));
            assert.equal(persisted.folders[0].tasks[0].questions[0].gradedDrawingCloudCommitted, undefined,
                'immediate refresh cannot reload old pending intent from IndexedDB');
            assert.deepEqual(h.calls, [], 'import does not publish the old pending drawing');
        }
        await h.context.autoSyncFromR2OnStartup();
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        const metadata = JSON.parse(h.cloud.get('metadata.json'));
        const question = metadata.exercises.folders[0].tasks[0].questions[0];
        assert.equal(question.score, imported ? 99 : 10,
            'cloud score wins after import; genuine pending offline grading still recovers');
        assert.equal(question.gradedDrawingCommitId, imported ? 'cloud-committed' : 'local-pending');
        assert.equal(question.gradedDrawingCloudCommitted, true);
        assert.equal(h.cloud.get('exercises/drawings/' + key),
            imported ? 'CLOUD COMMITTED IMAGE' : 'LOCAL PENDING IMAGE');
        assert.equal(h.calls.includes('PUT exercises/drawings/' + key), !imported);
    }
}
(async () => {
    for (const file of ['app/src/main/assets/www/index.html', 'docs/index.html']) {
        const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        await checkImport(html);
        await checkStartup(html);
        await checkOldGrading(html);
        console.log(file + ': old ZIP import, explicit upload, startup restore and old grading passed');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
