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
        ensureFileDB: async () => true,
        fileDB: { transaction: () => {
            const tx = {};
            tx.objectStore = () => ({
                get: key => {
                    const request = {};
                    queueMicrotask(() => {
                        request.result = idb.has(key) ? { id: key, data: idb.get(key) } : undefined;
                        request.onsuccess();
                        queueMicrotask(() => tx.oncomplete());
                    });
                    return request;
                },
                put: record => idb.set(record.id, record.data)
            });
            return tx;
        } },
        backupAppDataToIDB: noop, restoreBlobsFromIDB: asyncNoop,
        applySettings: noop, renderLibrary: noop, renderNotesPage: noop, renderClassroomPage: noop,
        renderNotebooksPage: noop, refreshAllUIFromAppData: noop,
        cleanupClassroomEntriesRemovedByMerge: asyncNoop,
        r2GetObject: async (key, options) => {
            calls.push('GET ' + key);
            const value = cloud.get(key);
            return options?.withMetadata ? { data: value, etag: 'memory-etag', missing: !value } : value;
        },
        r2PutObject: async (key, value, type, conditions = {}) => {
            calls.push('PUT ' + key);
            if (conditions.ifNoneMatch === '*' && cloud.has(key)) {
                throw Object.assign(new Error('conditional create conflict'), { status: 412 });
            }
            cloud.set(key, value);
        }
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
    h.idb.set('exercise_drawing_task_0', 'IMPORTED WRONG ANSWER');
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
    // Reading position may be newer in an older backup while the cloud body is newer.
    Object.assign(local.notebooks.items[0], { lastOpenedPageId: 'p1',
        lastOpenedPageUpdatedAt: Date.parse(local.syncedAt) });
    Object.assign(remote.notebooks.items[0], { lastOpenedPageId: 'p1',
        lastOpenedPageUpdatedAt: Date.parse('2026-08-01') });
    remote.notebooks.items[0].pages.push({ id: 'p2', updatedAt: remote.syncedAt });
    local.exercises.wrongByFolder.folder = [{ taskId: 'old-task', questions: [{ questionIndex: 0, score: 1 }] }];
    const h = harness(html, local, remote);
    const page = (updatedAt, text) => JSON.stringify({ updatedAt, strokes: [], texts: [{ text }], media: [] });
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
async function checkEmptyShelf(html) {
    for (const shelf of ['books', 'papers']) {
        const local = data(), remote = data(true);
        local[shelf] = [{ id: 'backup-pdf', addedAt: local.syncedAt }];
        remote.notes.cloudOnly = 'CLOUD ONLY NOTE';
        local.notebooks = remote.notebooks = { items: [{ id: 'nb', updatedAt: remote.syncedAt,
            pages: [{ id: 'p', updatedAt: remote.syncedAt }] }], reviews: [] };
        const h = harness(html, local, remote);
        h.idb.set('backup-pdf', 'LOCAL PDF');
        h.idb.set('nbpage_p', JSON.stringify({ updatedAt: local.syncedAt, texts: [{ text: 'BACKUP PAGE' }] }));
        const newPage = JSON.stringify({ updatedAt: remote.syncedAt, texts: [{ text: 'CLOUD PAGE' }] });
        h.cloud.set('notebooks/pages/nbpage_p', newPage);
        await h.context.importDataZip({ target: { value: 'old.zip', files: [{}] } });
        await h.drainTimers();
        assert.deepEqual(h.calls, []);
        const put = h.context.r2PutObject;
        let publications = 0;
        h.context.r2PutObject = async (key, value, ...args) => {
            if (key === 'metadata.json') {
                const published = JSON.parse(value);
                assert.deepEqual(published.notes, remote.notes, 'first shelf repair must keep newer cloud notes');
                assert.deepEqual(published.drafts, remote.drafts);
                assert.deepEqual(published.exercises, remote.exercises);
                assert.equal(published[shelf][0].id, 'backup-pdf');
                publications++;
            }
            return put(key, value, ...args);
        };
        await h.context.autoSyncFromR2OnStartup();
        await h.drainTimers();
        assert.equal(publications, 1, 'startup repairs the shelf after all cloud modules merge');
        assert.equal(h.idb.get('backup-pdf'), 'LOCAL PDF');
        assert.equal(h.calls.some(call => call.startsWith('PUT notebooks/')), false);
        assert.equal(h.idb.get('nbpage_p'), newPage);
        await h.context.performAutoSync();
        await h.drainTimers();
        assert.equal(publications, 2);
        assert.equal(h.errors.filter(error => !error.includes('云端书籍索引为空')).length, 0,
            h.errors.join('\n'));
    }
    const local = data(), remote = data(true);
    local.books = [{ id: 'deleted', addedAt: local.syncedAt }];
    remote.books = [{ id: 'kept', addedAt: remote.syncedAt }];
    const h = harness(html, local, remote);
    h.idb.set('deleted', 'OLD PDF');
    await h.context.autoSyncFromR2OnStartup();
    assert.equal(h.idb.has('deleted'), false, 'nonempty cloud shelf still applies deletions');
    assert.equal(h.context.appData.books[0].id, 'kept');
    assert.deepEqual(h.errors, []);
}
async function checkNotebookDownloadRace(html) {
    for (const mode of ['periodic', 'manual-pull', 'idb-write', 'reimport']) {
        const local = data(), remote = data(true);
        local.notebooks = remote.notebooks = { items: [{ id: 'nb', updatedAt: remote.syncedAt,
            pages: [{ id: 'p', updatedAt: remote.syncedAt }] }], reviews: [] };
        const h = harness(html, local, remote), key = 'notebooks/pages/nbpage_p';
        h.idb.set('nbpage_p', JSON.stringify({ updatedAt: local.syncedAt, texts: [{ text: 'BACKUP' }] }));
        h.cloud.set(key, JSON.stringify({ updatedAt: remote.syncedAt, texts: [{ text: 'CLOUD' }] }));
        Object.assign(h.context, { _nbSaveTimer: null, nbSnippetCache: {}, nbThumbCache: {},
            nbState: { notebookId: 'nb', pageIndex: 0, dirty: true,
                content: { strokes: [], texts: [{ text: 'JUST SAVED' }], media: [] } } });
        const get = h.context.r2GetObject;
        let downloaded = false;
        h.context.r2GetObject = async (...args) => {
            const result = await get(...args);
            if (args[0] === key && !downloaded) {
                downloaded = true;
                if (mode === 'reimport' || mode === 'idb-write') {
                    if (mode === 'reimport') h.context.appData.notebooks = clone(h.context.appData.notebooks);
                    h.idb.set('nbpage_p', JSON.stringify({ texts: [{ text: 'NEW IMPORT' }] }));
                } else {
                    await h.context.nbSavePageNow();
                    assert.equal(JSON.parse(h.idb.get('nbpage_p')).texts[0].text, 'JUST SAVED');
                }
            }
            return result;
        };
        if (mode === 'periodic') await h.context.performAutoSync();
        else await h.context.r2PullNotebookAssetsFromCloud({ missingOnly: false });
        await h.drainTimers();
        assert.equal(downloaded, true);
        assert.deepEqual(h.errors, []);
        assert.equal(JSON.parse(h.idb.get('nbpage_p')).texts[0].text,
            ['reimport', 'idb-write'].includes(mode) ? 'NEW IMPORT' : 'JUST SAVED', 'slow download cannot overwrite a newer local save');
        if (mode === 'periodic' || mode === 'manual-pull') {
            assert.equal(JSON.parse(h.cloud.get(key)).texts[0].text, 'JUST SAVED', 'queued edit still uploads');
        }
    }
}
async function checkLegacyEmbeddedGrading(html) {
    for (const stable of [true, false]) {
        const local = data(), remote = data(true);
        const question = taskId => ({ taskId, questionIndex: 0, score: 10, userDrawingPages: 2,
            userDrawing: 'REDO 0', userDrawingExtra: ['REDO 1'],
            redoDrawings: [{ ...(stable ? { drawingId: 'r1' } : {}), drawing: 'REDO 0', extra: ['REDO 1'] }] });
        local.exercises.wrongByFolder.folder = [{ taskId: 'wrong', questions: [question('wrong')] }];
        local.exercises.archivedWrong.folder = [question('archived')];
        const h = harness(html, local, remote);
        for (const task of ['wrong', 'archived']) for (let p = 0; p < 2; p++) {
            h.idb.set('exercise_drawing_' + task + '_0' + (p ? '_p1' : ''), 'ANSWER ' + p);
        }
        await h.context.importDataZip({ target: { value: 'legacy.zip', files: [{}] } });
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        assert.ok(h.toasts.includes('import_complete_files'));
        assert.deepEqual(h.calls, [], 'legacy migration is entirely local');
        const expected = new Map();
        for (const task of ['wrong', 'archived']) for (let p = 0; p < 2; p++) {
            const suffix = p ? '_p1' : '';
            expected.set('exercise_drawing_' + task + '_0' + suffix, 'ANSWER ' + p);
            expected.set('exercise_redo_drawing_' + task + '_0_0' + suffix, 'REDO ' + p);
            if (stable) expected.set('exercise_redo_drawing_' + task + '_0_id_r1' + suffix, 'REDO ' + p);
        }
        for (const [key, value] of expected) assert.equal(h.idb.get(key), value, 'durable legacy page: ' + key);
        // Simulate reopening from stripped metadata and the durable image store.
        h.context.appData.exercises = JSON.parse(h.idb.get('__exercises_data__'));
        assert.equal(h.context.appData.exercises.wrongByFolder.folder[0].questions[0].redoDrawings[0].drawing, undefined);
        const put = h.context.r2PutObject;
        h.context.r2PutObject = async (key, ...args) => {
            if (key === 'metadata.json') for (const [k, value] of expected) {
                assert.equal(h.cloud.get('exercises/drawings/' + k), value, 'legacy images precede metadata');
            }
            return put(key, ...args);
        };
        await h.context.autoSyncFromR2OnStartup();
        await h.drainTimers();
        await h.context.performAutoSync();
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        assert.ok(h.calls.includes('PUT metadata.json'));
    }
}
async function checkLegacyNotebook(html) {
    for (const mode of ['missing', 'existing', 'create-race', 'get-fails']) {
        const local = data(), remote = data(true);
        local.notebooks = { items: [{ id: 'nb', pages: [{ id: 'p', createdAt: local.syncedAt }] }], reviews: [] };
        const h = harness(html, local, remote), key = 'notebooks/pages/nbpage_p';
        h.idb.set('nbpage_p', JSON.stringify({ strokes: [{ points: [1, 2] }], texts: [], media: [] }));
        const cloudPage = JSON.stringify({ updatedAt: remote.syncedAt, texts: [{ text: 'NEW CLOUD' }] });
        if (mode === 'existing') h.cloud.set(key, cloudPage);
        if (mode === 'create-race') {
            const put = h.context.r2PutObject;
            h.context.r2PutObject = async (...args) => {
                if (args[0] === key) h.cloud.set(key, cloudPage);
                return put(...args);
            };
        }
        if (mode === 'get-fails') {
            const get = h.context.r2GetObject;
            h.context.r2GetObject = async (...args) => {
                if (args[0] === key) throw new Error('download unavailable');
                return get(...args);
            };
        }
        await h.context.syncToR2();
        await h.drainTimers();
        if (mode === 'get-fails') {
            assert.equal(h.calls.includes('PUT metadata.json'), false);
            assert.equal(h.cloud.has(key), false);
            assert.equal(h.errors.length, 1);
        } else {
            assert.deepEqual(h.errors, []);
            assert.ok(h.calls.includes('PUT metadata.json'));
            if (mode === 'missing') {
                assert.deepEqual(JSON.parse(h.cloud.get(key)).strokes, [{ points: [1, 2] }]);
                assert.equal(JSON.parse(h.cloud.get(key)).updatedAt, local.syncedAt);
            } else assert.equal(h.cloud.get(key), cloudPage, 'undated backup must not overwrite an existing cloud body');
        }
    }
}
async function checkPdfBackgroundRetry(html) {
    const local = data(), remote = data(true);
    local.notebooks = { items: [{ id: 'nb', pages: [{ id: 'p', createdAt: local.syncedAt, bgImage: 'bg' }] }], reviews: [] };
    const h = harness(html, local, remote), key = 'notebooks/pages/nbpage_p', mediaKey = 'notebooks/media/nbmedia_bg';
    h.idb.set('nbmedia_bg', 'PDF BACKGROUND');
    const put = h.context.r2PutObject;
    let fail = true;
    h.context.r2PutObject = async (k, ...args) => {
        if (k === mediaKey && fail) { fail = false; throw new Error('background upload failed'); }
        if (k === 'metadata.json') assert.equal(h.cloud.get(mediaKey), 'PDF BACKGROUND', 'retry sends background before metadata');
        return put(k, ...args);
    };
    await h.context.syncToR2();
    assert.ok(h.cloud.has(key));
    assert.equal(h.calls.includes('PUT metadata.json'), false);
    assert.equal(h.errors.length, 1);
    h.errors.length = 0;
    await h.context.syncToR2();
    await h.drainTimers();
    assert.deepEqual(h.errors, []);
    assert.equal(h.cloud.get(mediaKey), 'PDF BACKGROUND');
    assert.ok(h.calls.includes('PUT metadata.json'));
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
                'imported', 'backup intent remains distinct from a new local grading commit');
            const persisted = JSON.parse(h.idb.get('__exercises_data__'));
            assert.equal(persisted.folders[0].tasks[0].questions[0].gradedDrawingCloudCommitted, 'imported',
                'the import origin survives an immediate restart');
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
        assert.equal(h.idb.get(key), imported ? 'CLOUD COMMITTED IMAGE' : 'LOCAL PENDING IMAGE',
            'the restored score and local drawing must belong to the same cloud version');
        await h.context.performAutoSync();
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        assert.equal(h.cloud.get('exercises/drawings/' + key),
            imported ? 'CLOUD COMMITTED IMAGE' : 'LOCAL PENDING IMAGE',
            'the next periodic sync must not upload an old imported drawing');
    }
}
async function checkNotebookUploads(html) {
    const page = (at, text) => JSON.stringify({ updatedAt: at, strokes: [], texts: [{ text }], media: [] });
    for (const mode of ['offline-edit', 'new-blank', 'create-race', 'download-failure', 'corrupt-local']) {
        const local = data(), remote = data(true);
        local.notebooks = { items: [{ id: 'nb', pages: [{ id: 'p', updatedAt: remote.syncedAt }] }], reviews: [] };
        const h = harness(html, local, remote), key = 'notebooks/pages/nbpage_p';
        const fresh = page(remote.syncedAt, 'NEW CONTENT');
        if (mode === 'offline-edit') {
            h.idb.set('nbpage_p', fresh);
            h.cloud.set(key, page(local.syncedAt, 'OLD CLOUD'));
        }
        if (mode === 'create-race') {
            const put = h.context.r2PutObject;
            h.context.r2PutObject = async (...args) => { h.cloud.set(key, fresh); return put(...args); };
        }
        if (mode === 'download-failure') h.context.r2GetObject = async () => { throw new Error('network unavailable'); };
        if (mode === 'corrupt-local') h.idb.set('nbpage_p', '{broken');
        if (mode === 'download-failure' || mode === 'corrupt-local') {
            await assert.rejects(h.context.r2SyncNotebookPageBundle('p'));
            assert.equal(h.cloud.has(key), false, mode + ' must not create blank content');
        } else {
            await h.context.r2SyncNotebookPageBundle('p');
            const result = JSON.parse(h.cloud.get(key));
            assert.equal(result.texts.length, mode === 'new-blank' ? 0 : 1, mode);
            if (mode !== 'new-blank') assert.equal(result.texts[0].text, 'NEW CONTENT', mode);
            if (mode === 'create-race') assert.equal(h.idb.has('nbpage_p'), false,
                'a failed blank create must not leave a blank local cache hiding the winning page');
        }
    }
}
async function checkImportedOfflineGrading(html) {
    for (const mode of ['complete', 'upload-fails', 'missing-image']) {
        const local = data(), remote = data(true);
        local.exercises.folders[0].tasks = [{ id: 'offline', questions: [{ index: 0, status: 'done',
            score: 10, userDrawingPages: 2, gradedDrawingCloudCommitted: false }] }];
        local.exercises.wrongByFolder.folder = [{ taskId: 'offline', questions: [{ questionIndex: 0,
            score: 10, userDrawingPages: 2, gradedDrawingCloudCommitted: false,
            redoDrawings: [{ drawingId: 'redo1', pages: 2, gradedDrawingCloudCommitted: false }] }] }];
        const h = harness(html, local, remote);
        const keys = ['exercise_drawing_offline_0', 'exercise_drawing_offline_0_p1',
            'exercise_redo_drawing_offline_0_id_redo1', 'exercise_redo_drawing_offline_0_id_redo1_p1',
            'exercise_redo_drawing_offline_0_0', 'exercise_redo_drawing_offline_0_0_p1'];
        for (const key of keys) if (mode !== 'missing-image' || !key.endsWith('_p1')) h.idb.set(key, 'ANSWER ' + key);
        await h.context.importDataZip({ target: { value: 'offline.zip', files: [{}] } });
        await h.drainTimers();
        assert.deepEqual(h.calls, [], 'offline import itself does not connect to cloud');
        const put = h.context.r2PutObject;
        let completeAtPublication = false;
        h.context.r2PutObject = async (key, ...args) => {
            if (mode === 'upload-fails' && key.endsWith('_p1')) throw new Error('upload failed');
            if (key === 'metadata.json') {
                completeAtPublication = keys.every(k => h.cloud.has('exercises/drawings/' + k));
                assert.ok(completeAtPublication, 'all pages and aliases must exist before the first metadata PUT');
            }
            return put(key, ...args);
        };
        await h.context.autoSyncFromR2OnStartup();
        await h.drainTimers();
        if (mode === 'complete') {
            assert.deepEqual(h.errors, []);
            assert.equal(completeAtPublication, true);
            const published = JSON.parse(h.cloud.get('metadata.json'));
            assert.equal(published.exercises.folders[0].tasks[0].questions[0].score, 10);
            assert.equal(published.exercises.folders[0].tasks[0].questions[0].gradedDrawingCloudCommitted, true);
        } else {
            assert.equal(h.calls.includes('PUT metadata.json'), false, 'incomplete imported answers must not publish');
            assert.deepEqual(JSON.parse(h.cloud.get('metadata.json')), remote);
            assert.equal(h.errors.length, 1);
            const stored = JSON.parse(h.idb.get('__exercises_data__'));
            assert.equal(stored.folders[0].tasks[0].questions[0].gradedDrawingCloudCommitted, 'imported',
                'failed restoration remains resumable after restarting');
        }
    }
}
async function checkImportedGradeOnNotebookEdit(html) {
    for (const kind of ['normal', 'wrong', 'archived', 'redo']) for (const race of [false, true]) {
        const local = data(), remote = data(true);
        local.notebooks = remote.notebooks = { items: [{ id: 'nb', createdAt: local.syncedAt,
            pages: [{ id: 'np', createdAt: local.syncedAt }] }], reviews: [] };
        const install = (fixture, score, committed) => {
            const q = { index: 0, questionIndex: 0, status: 'done', score, userDrawingPages: 1,
                gradedDrawingCloudCommitted: committed, gradedDrawingCommitId: 'grade-' + score };
            if (!committed) q.userDrawing = 'BACKUP IMAGE';
            if (kind === 'normal') fixture.exercises.folders[0].tasks = [{ id: 'task', questions: [q] }];
            if (kind === 'wrong' || kind === 'redo') fixture.exercises.wrongByFolder.folder = [{ taskId: 'task', questions: [q] }];
            if (kind === 'archived') fixture.exercises.archivedWrong.folder = [{ ...q, taskId: 'task', archivedAt: local.syncedAt }];
            if (kind === 'redo') q.redoDrawings = [{ drawingId: 'r1', pages: 1, score,
                gradedDrawingCloudCommitted: committed, gradedDrawingCommitId: 'redo-' + score,
                ...(!committed ? { drawing: 'BACKUP IMAGE' } : {}) }];
        };
        const question = exercises => kind === 'normal' ? exercises.folders[0].tasks[0].questions[0]
            : kind === 'archived' ? exercises.archivedWrong.folder[0]
            : exercises.wrongByFolder.folder[0].questions[0];
        install(local, 2, false); install(remote, 9, true);
        const h = harness(html, local, remote), base = 'exercise_drawing_task_0';
        h.idb.set(base, 'BACKUP IMAGE');
        h.cloud.set('exercises/drawings/' + base, 'CLOUD 9');
        if (kind === 'redo') h.cloud.set('exercises/drawings/exercise_redo_drawing_task_0_id_r1', 'CLOUD 9');
        await h.context.importDataZip({ target: { value: 'old.zip', files: [{}] } });
        await h.drainTimers();
        assert.deepEqual(h.calls, []);
        const put = h.context.r2PutObject;
        let conflict = race;
        h.context.setTimeout = fn => { queueMicrotask(fn); return 1; };
        h.context.r2PutObject = async (key, value, ...args) => {
            if (key === 'metadata.json') {
                if (conflict) {
                    conflict = false;
                    install(remote, 8, true);
                    h.cloud.set(key, JSON.stringify(remote));
                    h.cloud.set('exercises/drawings/' + base, 'CLOUD 8');
                    if (kind === 'redo') h.cloud.set('exercises/drawings/exercise_redo_drawing_task_0_id_r1', 'CLOUD 8');
                    throw Object.assign(new Error('another device graded during publication'), { status: 412 });
                }
                const q = question(JSON.parse(value).exercises);
                assert.equal(q.score, race ? 8 : 9, 'first successful publication must use the cloud grading snapshot');
                if (kind === 'redo') assert.equal(q.redoDrawings[0].score, race ? 8 : 9);
            }
            return put(key, value, ...args);
        };
        let pending;
        Object.assign(h.context, { _nbSaveTimer: null, nbSnippetCache: {}, nbThumbCache: {},
            nbState: { notebookId: 'nb', pageIndex: 0, dirty: true,
                content: { strokes: [], texts: [{ text: 'NEW NOTE' }], media: [] } },
            nbSyncNotebookEvent: (action, id) => { pending = h.context.triggerSyncOnFileChange(id, action); } });
        await h.context.nbSavePageNow();
        await pending;
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        assert.equal(question(h.context.appData.exercises).score, race ? 8 : 9);
        assert.equal(question(h.context.appData.exercises).userDrawing, undefined, 'stale inline display cache is cleared');
        const imageKey = kind === 'redo' ? 'exercise_redo_drawing_task_0_id_r1' : base;
        assert.equal(h.idb.get(imageKey), race ? 'CLOUD 8' : 'CLOUD 9');
        assert.equal(h.calls.some(call => call === 'PUT exercises/drawings/' + imageKey), false);
        await h.context.performAutoSync();
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        assert.equal(question(JSON.parse(h.cloud.get('metadata.json')).exercises).score, race ? 8 : 9);
        assert.equal(h.cloud.get('exercises/drawings/' + imageKey), race ? 'CLOUD 8' : 'CLOUD 9');
    }
}
async function checkImportedPublicationConflicts(html) {
    for (const mode of ['orphan-image', 'image-create-race', 'new-local-grading']) {
        const local = data(), remote = data(true);
        local.exercises.folders[0].tasks = [{ id: 'offline', questions: [{ index: 0, status: 'done',
            score: 2, userDrawingPages: 1, gradedDrawingCloudCommitted: 'imported' }] }];
        const h = harness(html, local, remote), key = 'exercises/drawings/exercise_drawing_offline_0';
        h.idb.set('exercise_drawing_offline_0', 'BACKUP IMAGE');
        if (mode === 'orphan-image') h.cloud.set(key, 'DIFFERENT CLOUD IMAGE');
        const get = h.context.r2GetObject, put = h.context.r2PutObject;
        let changed = false;
        h.context.r2GetObject = async (...args) => {
            const value = await get(...args);
            if (mode === 'new-local-grading' && args[0] === key && !changed) {
                changed = true;
                h.context._exGradedCloudCommitCounter++;
                Object.assign(h.context.appData.exercises.folders[0].tasks[0].questions[0], {
                    score: 8, gradedDrawingCloudCommitted: false, gradedDrawingCommitId: 'new-grade' });
                h.idb.set('exercise_drawing_offline_0', 'NEW LOCAL IMAGE');
            }
            return value;
        };
        h.context.r2PutObject = async (...args) => {
            if (mode === 'image-create-race' && args[0] === key) h.cloud.set(key, 'DIFFERENT CLOUD IMAGE');
            return put(...args);
        };
        await assert.rejects(h.context.r2SyncMetadataOnly());
        assert.equal(h.calls.includes('PUT metadata.json'), false, mode + ': no mismatched grading is published');
        assert.deepEqual(JSON.parse(h.cloud.get('metadata.json')), remote);
        if (mode === 'new-local-grading') {
            await h.context.r2SyncMetadataOnly();
            assert.equal(JSON.parse(h.cloud.get('metadata.json')).exercises.folders[0].tasks[0].questions[0].score, 8);
            assert.equal(h.cloud.get(key), 'NEW LOCAL IMAGE');
        } else assert.equal(h.cloud.get(key), 'DIFFERENT CLOUD IMAGE');
    }
}
async function checkRedoPageCountIsolation(html) {
    const local = data();
    // State produced by completing a two-page redo while the one-page original is still pending.
    local.exercises.wrongByFolder.folder = [{ taskId: 'task', questions: [{ questionIndex: 0,
        score: 9, userDrawingPages: 1, pageCount: 2, gradedDrawingCloudCommitted: false,
        userDrawing: 'REDO 0', userDrawingExtra: ['REDO 1'], redoDrawings: [{ drawingId: 'r1',
            pages: 2, drawing: 'REDO 0', extra: ['REDO 1'], gradedDrawingCloudCommitted: false }] }] }];
    const h = harness(html, local, data());
    h.idb.set('exercise_drawing_task_0', 'ORIGINAL');
    h.idb.set('exercise_redo_drawing_task_0_id_r1', 'REDO 0');
    h.idb.set('exercise_redo_drawing_task_0_id_r1_p1', 'REDO 1');
    await h.context.r2SyncMetadataOnly();
    await h.drainTimers();
    assert.deepEqual(h.errors, []);
    assert.equal(h.cloud.get('exercises/drawings/exercise_drawing_task_0'), 'ORIGINAL');
    assert.equal(h.cloud.has('exercises/drawings/exercise_drawing_task_0_p1'), false);
    for (const base of ['exercise_redo_drawing_task_0_id_r1', 'exercise_redo_drawing_task_0_0']) {
        for (let p = 0; p < 2; p++) assert.equal(h.cloud.get('exercises/drawings/' + base + (p ? '_p1' : '')), 'REDO ' + p);
    }
    await h.context.r2SyncMetadataOnly();
    assert.deepEqual(h.errors, []);
}
async function checkMissingDrawingStillRestores(html) {
    for (const sync of ['autoSyncFromR2OnStartup', 'performAutoSync']) {
        const local = data(), remote = data(true);
        local.exercises.folders[0].tasks = [{ id: 'offline', questions: [{ index: 0, status: 'done',
            score: 2, userDrawingPages: 1, gradedDrawingCloudCommitted: false }] }];
        remote.books = [{ id: 'cloud-pdf', addedAt: remote.syncedAt }];
        local.notebooks = remote.notebooks = { items: [{ id: 'nb', updatedAt: remote.syncedAt,
            pages: [{ id: 'p', updatedAt: remote.syncedAt }] }], reviews: [] };
        const h = harness(html, local, remote);
        await h.context.importDataZip({ target: { value: 'missing.zip', files: [{}] } });
        await h.drainTimers();
        const page = JSON.stringify({ updatedAt: remote.syncedAt, texts: [{ text: 'CLOUD PAGE' }] });
        h.cloud.set('files/cloud-pdf.pdf', 'CLOUD PDF');
        h.cloud.set('notebooks/pages/nbpage_p', page);
        const run = h.context[sync]();
        if (sync === 'performAutoSync') await assert.rejects(run, /drawing is missing/);
        else await run;
        await h.drainTimers();
        assert.equal(h.calls.includes('PUT metadata.json'), false, 'incomplete scores still cannot publish');
        assert.deepEqual(JSON.parse(h.cloud.get('metadata.json')), remote);
        assert.equal(h.idb.get('nbpage_p'), page, sync + ': missing grading image does not block notebook download');
        if (sync === 'autoSyncFromR2OnStartup') assert.equal(h.idb.get('cloud-pdf'), 'CLOUD PDF');
        assert.equal(h.errors.length, 1, h.errors.join('\n'));
        // After the missing image is recovered, a normal retry can complete without restarting.
        h.idb.set('exercise_drawing_offline_0', 'RECOVERED ANSWER');
        h.errors.length = 0;
        await h.context.performAutoSync();
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        assert.ok(h.calls.includes('PUT metadata.json'));
    }
}
async function checkClassroomFirstThenNotebookSync(html) {
    for (const sync of ['syncToR2', 'performAutoSync', 'autoSyncFromR2OnStartup']) {
        for (const restart of [false, true]) {
            const local = data();
            local.classroom.courses = [{ id: 'course', createdAt: local.syncedAt, sessions: [] }];
            local.notebooks = { items: [{ id: 'offline-notebook', createdAt: local.syncedAt,
                pages: ['p1', 'p2'].map(id => ({ id, createdAt: local.syncedAt })) }],
                reviews: [{ id: 'offline-review', notebookId: 'offline-notebook', createdAt: local.syncedAt }] };
            let h = harness(html, local, local);
            h.cloud.delete('metadata.json');
            const bodies = new Map(['p1', 'p2'].map(id => ['nbpage_' + id,
                JSON.stringify({ updatedAt: local.syncedAt, strokes: [{ points: [1, 2] }],
                    texts: [{ text: 'OFFLINE ' + id }], media: [] })]));
            for (const [key, value] of bodies) h.idb.set(key, value);
            await h.context.r2SyncMetadataOnly({ classroomOnly: true });
            await h.drainTimers();
            if (restart) {
                const persisted = JSON.parse(h.context.localStorage.getItem('mathReader'));
                persisted.exercises = JSON.parse(h.idb.get('__exercises_data__'));
                const reopened = harness(html, persisted, JSON.parse(h.cloud.get('metadata.json')));
                for (const [key, value] of h.idb) reopened.idb.set(key, value);
                for (const [key, value] of h.cloud) reopened.cloud.set(key, value);
                h = reopened;
            }
            await h.context[sync]();
            await h.drainTimers();
            const label = sync + (restart ? ' after restart' : ' without restart');
            assert.deepEqual(clone(h.context.appData.notebooks), local.notebooks, label + ': local directory survives');
            assert.deepEqual(JSON.parse(h.cloud.get('metadata.json')).notebooks, local.notebooks,
                label + ': cloud directory survives');
            // Startup may only restore metadata; the next ordinary sync must publish the bodies too.
            await h.context.performAutoSync();
            await h.drainTimers();
            assert.deepEqual(clone(h.context.appData.notebooks), local.notebooks, label + ': next sync stays intact');
            assert.deepEqual(JSON.parse(h.cloud.get('metadata.json')).notebooks, local.notebooks);
            for (const [key, value] of bodies) {
                assert.equal(h.idb.get(key), value, label + ': local page body survives');
                assert.equal(h.cloud.get('notebooks/pages/' + key), value, label + ': page body uploads');
            }
            assert.deepEqual(h.errors, []);
        }
    }
}
async function checkClassroomWithoutExerciseImages(html) {
    for (const mode of ['existing', 'missing', 'conflict']) for (const committed of ['imported', false]) {
        const local = data(), remote = data(true);
        local.exercises.folders[0].tasks = [{ id: 'offline', questions: [{ index: 0, status: 'done',
            score: 10, gradedDrawingCloudCommitted: committed }] }];
        local.classroom.courses = [{ id: 'new-course', name: 'Classroom edit', sessions: [] }];
        local.notebooks.items = [{ id: 'offline-notebook', createdAt: local.syncedAt,
            pages: [{ id: 'offline-page', createdAt: local.syncedAt }] }];
        local.lectures = { book: { createdAt: local.syncedAt, chapters: [] } };
        const h = harness(html, local, remote);
        if (mode === 'missing') h.cloud.delete('metadata.json');
        const before = clone(h.context.appData);
        const put = h.context.r2PutObject;
        let conflict = mode === 'conflict';
        h.context.setTimeout = fn => { queueMicrotask(fn); return 1; };
        h.context.r2PutObject = async (key, ...args) => {
            if (key === 'metadata.json' && conflict) {
                conflict = false;
                remote.exercises.folders.push({ id: 'concurrent-cloud-folder', tasks: [] });
                h.cloud.set(key, JSON.stringify(remote));
                throw Object.assign(new Error('metadata conflict'), { status: 412 });
            }
            return put(key, ...args);
        };
        await h.context.r2SyncMetadataOnly({ classroomOnly: true });
        await h.drainTimers();
        assert.deepEqual(h.errors, []);
        const published = JSON.parse(h.cloud.get('metadata.json'));
        assert.equal(published.classroom.courses[0].id, 'new-course');
        assert.deepEqual(published.exercises, mode === 'missing' ? undefined : remote.exercises,
            'classroom-only publication never includes unchecked local exercises, including initial cloud creation');
        assert.equal(h.calls.some(call => call.includes('exercises/drawings/')), false,
            'classroom-only publication neither waits for nor accesses unrelated drawings');
        assert.deepEqual(clone(h.context.appData.exercises), before.exercises);
        assert.deepEqual(clone(h.context.appData.notebooks), before.notebooks, 'classroom first upload preserves offline notebooks');
        assert.deepEqual(clone(h.context.appData.lectures), before.lectures);
        const cloudBeforeFullPublish = h.cloud.get('metadata.json');
        await assert.rejects(h.context.r2SyncMetadataOnly(), /drawing is missing/,
            'a full publication still requires every local grading image');
        assert.equal(h.cloud.get('metadata.json'), cloudBeforeFullPublish);
        if (mode === 'missing') {
            h.idb.set('exercise_drawing_offline_0', 'RECOVERED ANSWER');
            await h.context.r2SyncMetadataOnly();
            await h.context.autoSyncFromR2OnStartup();
            await h.drainTimers();
            assert.deepEqual(clone(h.context.appData.notebooks), before.notebooks,
                'repairing the missing image and continuing sync must retain the offline notebook');
            assert.deepEqual(JSON.parse(h.cloud.get('metadata.json')).notebooks, before.notebooks);
        }
    }
}
async function checkCacheRecovery(html) {
    const local = data();
    local.exercises.folders[0].tasks = [{ id: 'task', questions: [{ index: 0, status: 'done', userDrawingPages: 2 }] }];
    local.exercises.wrongByFolder.folder = [{ taskId: 'wrong', questions: [{ questionIndex: 0,
        userDrawingPages: 2, redoDrawings: [{ drawingId: 'r1', pages: 2 }] }] }];
    local.exercises.archivedWrong.folder = [{ taskId: 'arch', questionIndex: 0,
        userDrawingPages: 2, redoDrawings: [{ pages: 2 }] }];
    const groups = [['exercise_drawing_task_0'], ['exercise_drawing_wrong_0'],
        ['exercise_redo_drawing_wrong_0_id_r1', 'exercise_redo_drawing_wrong_0_0'],
        ['exercise_drawing_arch_0'], ['exercise_redo_drawing_arch_0_0']];
    const h = harness(html, local, local);
    for (const bases of groups) for (let p = 0; p < 2; p++) {
        const suffix = p ? '_p1' : '';
        for (const base of bases) h.idb.set(base + suffix, 'OLD');
        h.cloud.set('exercises/drawings/' + bases[0] + suffix, 'NEW ' + bases[0] + suffix);
    }
    await h.context.exSyncCachedGradedPages();
    assert.deepEqual(h.errors, []);
    assert.equal(h.calls.some(call => call.startsWith('PUT ')), false);
    for (const bases of groups) for (let p = 0; p < 2; p++) {
        const suffix = p ? '_p1' : '';
        for (const base of bases) assert.equal(h.idb.get(base + suffix), 'NEW ' + bases[0] + suffix);
    }
    for (const mode of ['missing-cloud', 'create-race', 'late-edit', 'completed-grading', 'new-import', 'network-failure']) {
        const fixture = data();
        fixture.exercises.folders[0].tasks = [{ id: 'task', questions: [{ index: 0, status: 'done', userDrawingPages: 1 }] }];
        const e = harness(html, fixture, fixture), key = 'exercise_drawing_task_0', cloudKey = 'exercises/drawings/' + key;
        e.idb.set(key, 'LOCAL');
        if (!['missing-cloud', 'create-race'].includes(mode)) e.cloud.set(cloudKey, 'CLOUD');
        const get = e.context.r2GetObject, put = e.context.r2PutObject;
        e.context.r2GetObject = async (...args) => {
            if (mode === 'network-failure') throw new Error('network unavailable');
            const result = await get(...args);
            if (mode === 'late-edit') e.idb.set(key, 'NEW LOCAL EDIT');
            if (mode === 'completed-grading') {
                e.context._exGradedCloudCommitCounter++;
                e.idb.set(key, 'NEW GRADE');
                e.cloud.set(cloudKey, 'NEW GRADE');
            }
            if (mode === 'new-import') {
                e.context.appData.exercises = clone(fixture.exercises);
                e.idb.set(key, 'NEW IMPORT');
            }
            return result;
        };
        if (mode === 'create-race') e.context.r2PutObject = async (...args) => {
            e.cloud.set(cloudKey, 'OTHER DEVICE');
            return put(...args);
        };
        await e.context.exSyncCachedGradedPages();
        const expected = { 'missing-cloud': 'LOCAL', 'create-race': 'OTHER DEVICE',
            'late-edit': 'NEW LOCAL EDIT', 'completed-grading': 'NEW GRADE',
            'new-import': 'NEW IMPORT', 'network-failure': 'LOCAL' };
        assert.equal(e.idb.get(key), expected[mode], mode);
        assert.equal(e.cloud.get(cloudKey), ['late-edit', 'new-import', 'network-failure'].includes(mode) ? 'CLOUD' : expected[mode], mode);
        if (mode === 'network-failure') assert.equal(e.errors.length, 1);
        else assert.deepEqual(e.errors, []);
    }
    const aliasFixture = data();
    aliasFixture.exercises.wrongByFolder.folder = [{ taskId: 'task', questions: [{ questionIndex: 0,
        redoDrawings: [{ drawingId: 'r1', pages: 1 }] }] }];
    const a = harness(html, aliasFixture, aliasFixture);
    const stable = 'exercise_redo_drawing_task_0_id_r1', legacy = 'exercise_redo_drawing_task_0_0';
    a.idb.set(stable, 'BACKUP'); a.idb.set(legacy, 'BACKUP');
    const put = a.context.r2PutObject;
    a.context.r2PutObject = async (...args) => {
        a.cloud.set('exercises/drawings/' + stable, 'CANONICAL');
        a.cloud.set('exercises/drawings/' + legacy, 'STALE ALIAS');
        return put(...args);
    };
    await a.context.exSyncCachedGradedPages();
    assert.deepEqual(a.errors, []);
    assert.equal(a.idb.get(stable), 'CANONICAL', 'a legacy alias conflict cannot undo the stable-key winner');
    assert.equal(a.idb.get(legacy), 'CANONICAL');
}
(async () => {
    for (const file of ['app/src/main/assets/www/index.html', 'docs/index.html']) {
        const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        await checkImport(html);
        await checkStartup(html);
        await checkEmptyShelf(html);
        await checkNotebookDownloadRace(html);
        await checkLegacyEmbeddedGrading(html);
        await checkLegacyNotebook(html);
        await checkPdfBackgroundRetry(html);
        await checkOldGrading(html);
        await checkImportedOfflineGrading(html);
        await checkClassroomWithoutExerciseImages(html);
        await checkClassroomFirstThenNotebookSync(html);
        await checkRedoPageCountIsolation(html);
        await checkImportedGradeOnNotebookEdit(html);
        await checkImportedPublicationConflicts(html);
        await checkMissingDrawingStillRestores(html);
        await checkNotebookUploads(html);
        await checkCacheRecovery(html);
        console.log(file + ': import/startup/periodic recovery, legacy data, concurrent edits and PDF retry passed');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
