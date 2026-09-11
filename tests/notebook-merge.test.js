// Run with: node tests/notebook-merge.test.js
// Execute the application's merge/deletion/publish functions; all storage is in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
function source(name) {
    const start = html.search(new RegExp('        (?:async )?function ' + name + '\\('));
    assert.notEqual(start, -1, name);
    const lineEnd = html.indexOf('\n', start);
    const end = html.slice(start, lineEnd).trimEnd().endsWith('}')
        ? lineEnd : html.indexOf('\n        }', lineEnd) + 10;
    return html.slice(start, end);
}
const copy = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const time = n => new Date(1700000000000 + n * 1000).toISOString();
const page = (id, n) => ({ id, createdAt: time(1), updatedAt: time(n) });
const notebook = (id, pages, n = 1) => ({ id, pages, createdAt: time(1), updatedAt: time(n) });
const tombstone = (kind, id) => ({ kind, id, deletedAt: time(4) });
let canSave = true, cloudMetadata, saved = [], syncs = [];
let cloudEtag = 'memory', cloudMissing = false, beforePublish = noop;
const publishedConditions = [];
const context = vm.createContext({
    console: { warn: noop, error: noop }, i18n: key => key,
    appData: {}, confirm: () => true,
    saveData: () => { if (canSave) saved.push(copy(context.appData.notebooks)); return canSave; },
    r2GetObject: async () => ({ data: cloudMissing ? null : JSON.stringify(cloudMetadata), etag: cloudEtag, missing: cloudMissing }),
    r2PutObject: async (key, value, _type, conditions) => {
        if (key === 'metadata.json') {
            beforePublish();
            assert.deepEqual(copy(conditions), cloudMissing ? { ifNoneMatch: '*' } : { ifMatch: cloudEtag });
            publishedConditions.push(copy(conditions)); cloudMetadata = JSON.parse(value);
        }
    },
    setTimeout: callback => { callback(); return 0; },
    exFlushGradedDrawingCloudCommits: async () => ({ exercisesForPublish: {} }),
    exMergeMatchingExerciseHistories: noop, exMarkPublishedGradingCommits: () => false,
    exPublishedGradingCommitIds: () => [],
    stripClassroomData: value => value || { courses: [], seminars: [] },
    mergeClassroomTombstones: () => [],
    applyClassroomOutboxTombstones: value => value || { courses: [], seminars: [] },
    mergeClassroomData: (_remote, local) => local,
    cleanupClassroomEntriesRemovedByMerge: async () => {},
    markClassroomMetadataCloudCommitted: async () => {}, mergeLecturesData: () => ({}),
    mergeDocsPreferringLocalProgress: local => local, cleanDocForSync: value => value,
    initRecordingStore: noop, recordingStore: { listManifests: async () => [] },
    listFileKeys: async () => [], _callNativeRecording: () => ({ ok: true, items: [] }),
    deleteFileData: async () => assert.ok(saved.at(-1).tombstones.length, 'delete intent is durable before cleanup'),
    saveFileData: async () => {}, triggerSyncOnFileChange: (...args) => syncs.push(args),
    exClearLocalPositionShadows: noop, renderLibrary: noop, renderNotesPage: noop,
    renderClassroomPage: noop, showToast: noop,
});
vm.runInContext('let _cloudMetaBackupDay = null;\n' + [
    'syncTimestamp', 'mergeNotebookTombstones', 'mergeNotebooksData', 'nbData', 'nbCommitDeletion',
    'metaDataCounts', 'r2ProtectMetadataOverwrite', 'r2PublishMetadataWithCas', 'clearAllData',
].map(source).join('\n'), context);
const merge = (cloud, local) => copy(context.mergeNotebooksData(cloud, local, Date.parse(time(100))));

async function main() {
    // Saving P1 on a device that has never seen P2 must not remove P2, old local notebooks or reviews.
    const remote = { items: [notebook('n', [page('p1', 1), page('p2', 2)], 2), notebook('remote', [])],
        reviews: [{ id: 'remote-review', notebookId: 'remote', updatedAt: time(1) }] };
    const local = { items: [notebook('n', [page('p1', 3), page('inserted', 1)], 3), notebook('local', [])],
        reviews: [{ id: 'local-review', notebookId: 'local', updatedAt: time(1) }] };
    const before = JSON.stringify([remote, local]);
    let result = merge(remote, local);
    assert.deepEqual(result.items.map(n => n.id).sort(), ['local', 'n', 'remote']);
    assert.deepEqual(result.items[0].pages.map(p => p.id), ['p1', 'inserted', 'p2']);
    assert.equal(result.items[0].pages[0].updatedAt, time(3));
    assert.equal(result.reviews.length, 2);
    assert.deepEqual(merge(local, remote).items[0].pages.map(p => p.id).sort(), ['inserted', 'p1', 'p2']);
    assert.equal(JSON.stringify([remote, local]), before, 'merging does not mutate inputs');

    // Explicit deletes win in either direction, including against a newer stale device edit.
    const deleted = { items: [], reviews: [], tombstones: [
        tombstone('page', 'p2'), tombstone('notebook', 'remote'), tombstone('review', 'local-review')
    ] };
    result.items[0].lastOpenedPageId = 'p2';
    result.items[0].lastOpenedPageUpdatedAt = 500;
    result.items[0].outline = [{ pageId: 'p2', title: 'deleted' }];
    result.items[0].pages.find(p => p.id === 'p2').updatedAt = time(99);
    for (const merged of [merge(result, deleted), merge(deleted, result)]) {
        assert.deepEqual(merged.items.map(n => n.id).sort(), ['local', 'n']);
        assert.deepEqual(merged.items.find(n => n.id === 'n').pages.map(p => p.id), ['p1', 'inserted']);
        assert.equal(merged.reviews.length, 0);
        assert.equal(merged.items.find(n => n.id === 'n').lastOpenedPageId, undefined);
        assert.deepEqual(merged.items.find(n => n.id === 'n').outline, []);
        assert.equal(merge(merged, result).items.find(n => n.id === 'n').pages.length, 2);
    }
    assert.equal(context.mergeNotebookTombstones([{ kind: 'page', id: 'p2' }]).length, 0);

    // A failed local deletion commit retains both the index and its deletion history.
    context.appData = { notebooks: copy(remote) };
    const oldData = context.appData.notebooks;
    canSave = false;
    assert.equal(context.nbCommitDeletion('notebook', 'n'), false);
    assert.equal(context.appData.notebooks, oldData);
    canSave = true;
    assert.equal(context.nbCommitDeletion('page', 'p2'), true);
    assert.equal(saved.at(-1).tombstones[0].id, 'p2');
    assert.equal(merge(remote, saved.at(-1)).items[0].pages.length, 1);

    // Empty snapshots still cannot wipe notebooks; explicit deletion of the last notebook can publish.
    const only = { notebooks: { items: [notebook('only', [page('p', 1)])], reviews: [] } };
    const empty = { notebooks: { items: [], reviews: [] } };
    assert.equal(await context.r2ProtectMetadataOverwrite(empty, JSON.stringify(only), only), false);
    empty.notebooks.tombstones = [tombstone('notebook', 'only')];
    assert.equal(await context.r2ProtectMetadataOverwrite(empty, JSON.stringify(only), only), true);
    const extra = copy(only);
    extra.notebooks.items.push(notebook('unseen', []));
    assert.equal(await context.r2ProtectMetadataOverwrite(empty, JSON.stringify(extra), extra), false);
    const withBook = { ...only, books: [{ id: 'book' }] };
    assert.equal(await context.r2ProtectMetadataOverwrite(empty, JSON.stringify(withBook), withBook), false);

    // Actual CAS publication also carries durable notebook deletes during a classroom-only publish.
    cloudMetadata = { ...copy(only), notes: { keep: 'remote' }, syncedAt: time(3) };
    context.appData = { notebooks: copy(empty.notebooks), notes: { stale: 'local' }, books: [], papers: [] };
    await context.r2PublishMetadataWithCas(context.appData, { courses: [], seminars: [] }, { classroomOnly: true });
    assert.deepEqual(cloudMetadata.notes, { keep: 'remote' });
    assert.equal(cloudMetadata.notebooks.items.length, 0);
    assert.equal(cloudMetadata.notebooks.tombstones[0].id, 'only');
    assert.equal(merge(cloudMetadata.notebooks, only.notebooks).items.length, 0);

    // An existing metadata object without a visible version must never receive a blind overwrite.
    const cloudBefore = JSON.stringify(cloudMetadata), publishCount = publishedConditions.length;
    cloudEtag = null;
    await assert.rejects(context.r2PublishMetadataWithCas(context.appData, null, { classroomOnly: true }), /cloud_version_unavailable/);
    assert.equal(JSON.stringify(cloudMetadata), cloudBefore);
    assert.equal(publishedConditions.length, publishCount);
    cloudEtag = 'memory';

    // A CAS retry must re-merge a newly added remote page, not just resend the previous snapshot.
    cloudMetadata = { ...copy(only), syncedAt: time(3) };
    context.appData = { ...copy(only), books: [], papers: [] };
    beforePublish = () => {
        beforePublish = noop; cloudEtag = 'changed';
        cloudMetadata.notebooks.items[0].pages.push(page('during-publish', 8));
        throw Object.assign(new Error('changed'), { status: 412 });
    };
    await context.r2PublishMetadataWithCas(context.appData, null);
    assert.deepEqual(cloudMetadata.notebooks.items[0].pages.map(p => p.id), ['p', 'during-publish']);
    assert.deepEqual(publishedConditions.at(-1), { ifMatch: 'changed' });

    // A genuinely absent object is created conditionally, even though it has no ETag yet.
    cloudMissing = true; cloudEtag = null;
    await context.r2PublishMetadataWithCas(context.appData, null);
    assert.deepEqual(publishedConditions.at(-1), { ifNoneMatch: '*' });
    cloudMissing = false; cloudEtag = 'memory';

    // Clear-all keeps the deletion records through its replacement of appData and schedules publication.
    context.appData = { notebooks: copy(remote), classroom: { courses: [], seminars: [] }, settings: {} };
    await context.clearAllData();
    assert.equal(context.appData.notebooks.items.length, 0);
    assert.equal(context.appData.notebooks.reviews.length, 0);
    assert.equal(merge(remote, context.appData.notebooks).items.length, 0);
    assert.equal(syncs.at(-1)[1], 'notebook_metadata_update');
    console.log('Notebook merge/deletion regression checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
