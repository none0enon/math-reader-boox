// Run with: node tests/notebook-cloud-sync.test.js
// Execute product declarations unchanged, with storage and R2 only in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const restoreTest = fs.readFileSync(path.join(__dirname, 'cloud-sync-restore.test.js'), 'utf8');
const helperEnd = restoreTest.indexOf('async function checkImport');
assert.ok(helperEnd > 0, 'existing restore harness is available');
const { data, harness } = vm.runInNewContext(restoreTest.slice(0, helperEnd) + '\n({ data, harness })', { require });
const OLD = '2026-09-01T00:00:00.000Z', NEW = '2026-09-10T00:00:00.000Z';
const LOCAL_KEY = 'nbpage_p1', CLOUD_KEY = 'notebooks/pages/' + LOCAL_KEY;
const ink = (at, id) => JSON.stringify({ updatedAt: at, strokes: [
    { id, tool: 'pen', color: '#000000', w: 2, paths: [[[10, 20], [30, 40]]] }
], texts: [], media: [], recognized: null });
const notebook = (at, ids = ['p1']) => ({ items: [{ id: 'nb', updatedAt: at,
    pages: ids.map(id => ({ id, createdAt: OLD, updatedAt: at })) }], reviews: [] });
const pagePuts = h => h.calls.filter(call => call.startsWith('PUT notebooks/pages/'));
const noErrors = h => assert.equal(h.errors.length, 0, JSON.stringify(h.errors));
function setup(html, localRaw, cloudRaw, metadataAt = NEW) {
    const local = data(true), remote = data(true);
    local.notebooks = notebook(metadataAt);
    remote.notebooks = notebook(metadataAt);
    const h = harness(html, local, remote);
    if (localRaw) h.idb.set(LOCAL_KEY, localRaw);
    if (cloudRaw) h.cloud.set(CLOUD_KEY, cloudRaw);
    return h;
}
async function checkEntrypoints(html) {
    for (const [entrypoint, repair] of [['performAutoSync', false],
        ['autoSyncFromR2OnStartup', false], ['autoSyncFromR2OnStartup', true]]) {
        const local = data(true), remote = data(true);
        remote.notebooks = notebook(NEW, ['p1', 'p2']);
        // Exercise metadata repair triggered the notebook overwrite introduced by PR 92.
        if (repair) local.exercises.wrongByFolder.folder = [{ taskId: 'old-task',
            questions: [{ questionIndex: 0, score: 1 }] }];
        const h = harness(html, local, remote);
        if (repair) h.idb.set('exercise_drawing_old-task_0', 'existing local answer');
        for (const id of ['p1', 'p2']) h.cloud.set('notebooks/pages/nbpage_' + id, ink(NEW, id));
        for (let round = 0; round < 2; round++) {
            await h.context[entrypoint]();
            await h.drainTimers();
            noErrors(h);
            assert.equal(h.context.appData.notebooks.items[0].pages.length, 2);
            for (const id of ['p1', 'p2']) {
                assert.equal(h.cloud.get('notebooks/pages/nbpage_' + id), ink(NEW, id),
                    entrypoint + ' preserves cloud ink');
                assert.equal(h.idb.get('nbpage_' + id), ink(NEW, id), entrypoint + ' downloads ink');
            }
            assert.equal(pagePuts(h).length, 0, 'downloaded pages are not uploaded again');
        }
        if (repair) assert.ok(h.calls.includes('PUT metadata.json'), 'startup metadata repair ran');
    }
}
async function checkBundles(html) {
    for (const localRaw of [null, ink(OLD, 'old-local')]) {
        const cloudRaw = ink(NEW, 'cloud');
        const h = setup(html, localRaw, cloudRaw);
        await h.context.r2SyncNotebookPageBundle('p1');
        await h.context.r2SyncNotebookPageBundle('p1');
        noErrors(h);
        assert.equal(h.cloud.get(CLOUD_KEY), cloudRaw);
        assert.equal(h.idb.get(LOCAL_KEY), cloudRaw, 'missing or stale local ink pulls newer cloud ink');
        assert.equal(pagePuts(h).length, 0);
    }
    const localRaw = ink(NEW, 'local');
    const h = setup(html, localRaw, ink(OLD, 'old-cloud'));
    await h.context.r2SyncNotebookPageBundle('p1');
    await h.context.r2SyncNotebookPageBundle('p1');
    noErrors(h);
    assert.equal(h.cloud.get(CLOUD_KEY), localRaw, 'newer local ink uploads');
    assert.equal(pagePuts(h).length, 1, 'unchanged ink uploads only once');

    const blank = setup(html, null, null);
    await blank.context.r2SyncNotebookPageBundle('p1');
    await blank.context.r2SyncNotebookPageBundle('p1');
    noErrors(blank);
    assert.deepEqual(JSON.parse(blank.cloud.get(CLOUD_KEY)),
        { strokes: [], texts: [], media: [], recognized: null, updatedAt: NEW },
        'a newly created empty page still uploads');
    assert.equal(pagePuts(blank).length, 1);

    const legacyContent = JSON.parse(ink(NEW, 'legacy'));
    delete legacyContent.recognized;
    const legacyRaw = JSON.stringify(legacyContent);
    const legacy = setup(html, null, legacyRaw);
    await legacy.context.r2SyncNotebookPageBundle('p1');
    await legacy.context.r2SyncNotebookPageBundle('p1');
    noErrors(legacy);
    assert.deepEqual(JSON.parse(legacy.idb.get(LOCAL_KEY)), { ...legacyContent, recognized: null },
        'old notebook bodies normalize the missing recognized field');
    assert.equal(legacy.cloud.get(CLOUD_KEY), legacyRaw);
    assert.equal(pagePuts(legacy).length, 0, 'schema normalization does not trigger repeated uploads');
}
async function checkPullAndOpen(html) {
    for (const read of ['r2PullNotebookAssetsFromCloud', 'nbLoadPageContent']) {
        for (const newerLocal of [false, true]) {
            const localRaw = ink(newerLocal ? NEW : OLD, 'local');
            const cloudRaw = ink(newerLocal ? OLD : NEW, 'cloud');
            // A newer page index must not make an older cloud body replace newer local ink.
            const h = setup(html, localRaw, cloudRaw, '2026-09-11T00:00:00.000Z');
            const result = await h.context[read](...(read === 'nbLoadPageContent' ? ['p1'] : []));
            noErrors(h);
            assert.ok(h.calls.includes('GET ' + CLOUD_KEY), read + ' checks cloud content');
            const expected = newerLocal ? localRaw : cloudRaw;
            assert.equal(h.idb.get(LOCAL_KEY), expected, read + ' keeps the newer body');
            assert.equal(h.cloud.get(CLOUD_KEY), cloudRaw);
            if (read === 'nbLoadPageContent') assert.equal(JSON.stringify(result), expected);
            assert.equal(pagePuts(h).length, 0);
        }
    }
}
async function checkRetry(html) {
    const localRaw = ink(NEW, 'local'), cloudRaw = ink(OLD, 'cloud');
    const h = setup(html, localRaw, cloudRaw);
    const get = h.context.r2GetObject, timer = h.context.setTimeout, delays = [];
    let failed = false;
    h.context.r2GetObject = async (key, options) => {
        if (key === CLOUD_KEY && !failed) { failed = true; throw new Error('transient notebook GET failure'); }
        return get(key, options);
    };
    h.context.setTimeout = (fn, delay) => { delays.push(delay); return timer(fn, delay); };
    await h.context.triggerSyncOnFileChange('p1', 'notebook_page_update');
    assert.equal(h.cloud.get(CLOUD_KEY), cloudRaw, 'failed cloud read cannot overwrite cloud ink');
    assert.equal(h.idb.get(LOCAL_KEY), localRaw, 'failed cloud read preserves local ink');
    assert.equal(pagePuts(h).length, 0);
    assert.equal(h.errors.length, 1);
    assert.match(h.errors[0], /transient notebook GET failure/);
    assert.deepEqual(delays, [750], 'existing retry backoff schedules the notebook update');
    assert.equal(h.context.r2ClassroomRetryTimers.size, 1);
    await h.drainTimers();
    assert.equal(h.errors.length, 1, 'retry succeeds without another error');
    assert.equal(h.cloud.get(CLOUD_KEY), localRaw, 'retry publishes the newer local ink');
    assert.equal(pagePuts(h).length, 1);
    assert.equal(h.context.r2ClassroomRetryTimers.size, 0, 'successful retry clears its timer');
}
(async () => {
    for (const file of ['app/src/main/assets/www/index.html', 'docs/index.html']) {
        const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        await checkEntrypoints(html);
        await checkBundles(html);
        await checkPullAndOpen(html);
        await checkRetry(html);
        console.log(file + ': notebook startup, periodic sync, conflicts, blank pages and retry passed');
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
