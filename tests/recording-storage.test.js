'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    RecordingStore,
    manifestKey,
    chunkKey,
    FORMAT
} = require('../app/src/main/assets/www/recording-storage.js');

class MemoryAdapter {
    constructor() {
        this.values = new Map();
        this.failPair = 0;
        this.failPutKey = null;
    }
    async get(key) { return this.values.has(key) ? this.values.get(key) : null; }
    async put(key, value) {
        if (this.failPutKey === key) {
            this.failPutKey = null;
            throw new Error('injected manifest commit failure');
        }
        this.values.set(key, structuredClone(value));
    }
    async putPair(keyA, valueA, keyB, valueB) {
        if (this.failPair-- > 0) throw new Error('injected transaction abort');
        // Commit both values together, like one IndexedDB transaction.
        const next = new Map(this.values);
        next.set(keyA, structuredClone(valueA));
        next.set(keyB, structuredClone(valueB));
        this.values = next;
    }
    async delete(key) { this.values.delete(key); }
    async keys() { return [...this.values.keys()]; }
}

function makeStore(adapter = new MemoryAdapter(), options) {
    return { adapter, store: new RecordingStore(adapter, options) };
}

test('concurrent chunks are serialized, contiguous, and byte exact', async () => {
    const { adapter, store } = makeStore();
    const id = 'recording_concurrent_001';
    await store.begin({ id, mimeType: 'audio/webm', material: { folderId: 'f', sessionId: 's' } });
    const expected = [];
    const writes = [];
    for (let i = 0; i < 100; i++) {
        const bytes = new Uint8Array([i, i ^ 0x5a, 255 - i]);
        expected.push(...bytes);
        writes.push(store.append(id, new Blob([bytes], { type: 'audio/webm' })));
    }
    await Promise.all(writes);
    const manifest = await store.complete(id, { duration: 100 });
    assert.equal(manifest.chunkCount, 100);
    assert.equal(manifest.byteLength, 300);
    for (let i = 0; i < 100; i++) assert.ok(adapter.values.has(chunkKey(id, i)));
    const actual = new Uint8Array(await (await store.getBlob(id)).arrayBuffer());
    assert.deepEqual([...actual], expected);
});

test('an aborted chunk transaction exposes neither chunk nor manifest increment', async () => {
    const { adapter, store } = makeStore();
    const id = 'recording_atomic_001';
    await store.begin({ id, mimeType: 'audio/webm' });
    adapter.failPair = 1;
    await assert.rejects(store.append(id, new Blob(['first'])));
    assert.equal((await adapter.get(manifestKey(id))).chunkCount, 0);
    assert.equal(await adapter.get(chunkKey(id, 0)), null);

    await store.append(id, new Blob(['first']));
    assert.equal((await adapter.get(manifestKey(id))).chunkCount, 1);
    assert.equal(await (await store.getBlob(id)).text(), 'first');
});

test('recording manifests recover idempotently when metadata was not committed', async () => {
    const { adapter, store } = makeStore();
    const id = 'recording_recovery_001';
    await store.begin({ id, mimeType: 'audio/webm', startedAt: '2026-07-10T00:00:00.000Z' });
    await store.append(id, new Blob(['a']));
    await store.append(id, new Blob(['b']));
    await store.markMetadataPending(id, true);

    const reloaded = new RecordingStore(adapter);
    let manifests = await reloaded.listManifests();
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].status, 'recording');
    assert.equal(manifests[0].metadataPending, true);
    await reloaded.complete(id, { duration: 2, recovered: true });
    await reloaded.markMetadataPending(id, false);

    manifests = await new RecordingStore(adapter).listManifests();
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].status, 'complete');
    assert.equal(manifests[0].metadataPending, false);
    assert.equal(await (await reloaded.getBlob(id)).text(), 'ab');
});

test('large imported audio is sliced without a data URL and can be reconstructed', async () => {
    const chunkBytes = 256 * 1024;
    const { store } = makeStore(undefined, { importChunkBytes: chunkBytes });
    const id = 'recording_import_001';
    const sourceBytes = new Uint8Array(chunkBytes * 5 + 17);
    for (let i = 0; i < sourceBytes.length; i++) sourceBytes[i] = i % 251;
    const source = new Blob([sourceBytes], { type: 'audio/webm' });
    const manifest = await store.importBlob({ id, mimeType: source.type, duration: 10 }, source);
    assert.equal(manifest.format, FORMAT);
    assert.equal(manifest.chunkCount, 6);
    assert.equal(manifest.byteLength, source.size);
    const restored = new Uint8Array(await (await store.getBlob(id)).arrayBuffer());
    assert.deepEqual(restored, sourceBytes);
});

test('remote grouped chunks restore with size verification and delete cleanly', async () => {
    const { adapter, store } = makeStore();
    const id = 'recording_remote_001';
    const groups = [new Blob(['one']), new Blob(['two']), new Blob(['three'])];
    const remote = {
        format: FORMAT,
        id,
        mimeType: 'audio/webm',
        chunkCount: groups.length,
        byteLength: groups.reduce((n, blob) => n + blob.size, 0),
        duration: 3,
        externalBackup: true,
        material: { name: 'remote' }
    };
    const restoredManifest = await store.restore(remote, index => groups[index]);
    assert.equal(restoredManifest.externalBackup, true,
        'portable incomplete state must persist on the committed journal manifest');
    assert.equal(await (await store.getBlob(id)).text(), 'onetwothree');
    await store.remove(id);
    assert.equal(await adapter.get(manifestKey(id)), null);
    assert.equal((await adapter.keys()).filter(key => String(key).includes(id)).length, 0);
});

test('failed remote restore leaves the previous complete generation byte exact', async () => {
    const { adapter, store } = makeStore();
    const id = 'recording_restore_atomic_001';
    await store.importBlob({ id, mimeType: 'audio/webm', duration: 3 }, new Blob(['old-complete-audio']));

    const remote = {
        format: FORMAT,
        id,
        mimeType: 'audio/webm',
        chunkCount: 3,
        byteLength: 15,
        duration: 6
    };
    await assert.rejects(store.restore(remote, async index => {
        if (index === 1) throw new Error('injected network interruption');
        return new Blob(['12345']);
    }), /network interruption/);

    const reloaded = new RecordingStore(adapter);
    assert.equal(await (await reloaded.getBlob(id)).text(), 'old-complete-audio');
    const visible = await reloaded.listManifests();
    assert.equal(visible.filter(item => item.id === id).length, 1);
    assert.equal(visible.some(item => item.stagingFor), false);
});

test('failed restore commit never switches away from the old generation', async () => {
    const { adapter, store } = makeStore();
    const id = 'recording_restore_commit_001';
    await store.importBlob({ id, mimeType: 'audio/webm' }, new Blob(['old-generation']));
    adapter.failPutKey = manifestKey(id);

    await assert.rejects(store.restore({
        format: FORMAT,
        id,
        mimeType: 'audio/webm',
        chunkCount: 2,
        byteLength: 10
    }, index => new Blob([index ? '67890' : '12345'])), /commit failure/);

    const reloaded = new RecordingStore(adapter);
    assert.equal(await (await reloaded.getBlob(id)).text(), 'old-generation');
});

test('R2 publishing guards active recordings and never rewrites the local journal', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8');
    const start = html.indexOf('async function r2SyncRecording(material)');
    const end = html.indexOf('async function r2GetRecordingManifest(material)', start);
    assert.ok(start >= 0 && end > start, 'r2SyncRecording function not found');
    const body = html.slice(start, end);
    assert.ok(body.indexOf('classroomRecordingState?.id') < body.indexOf('_recordingSourceCandidates'),
        'active recording guard must run before source selection');
    assert.doesNotMatch(body, /recordingStore\.(remove|importBlob)\s*\(/,
        'cloud publishing must not mutate or replace the local journal');
    assert.match(body, /\/generations\//,
        'R2 groups must use immutable generation keys');
});

test('manual R2 restore snapshots local classroom in the same function scope', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8');
    const start = html.indexOf('async function syncFromR2()');
    const end = html.indexOf('// ==================== Data Management', start);
    assert.ok(start >= 0 && end > start, 'syncFromR2 function not found');
    const body = html.slice(start, end);
    const declaration = body.indexOf('const localClassroomBeforeRestore = appData.classroom');
    const mergeUse = body.indexOf('localClassroomBeforeRestore', declaration + 1);
    assert.ok(declaration >= 0, 'manual restore must snapshot local classroom data');
    assert.ok(mergeUse > declaration, 'manual restore must declare the classroom snapshot before using it');
});

test('manual R2 restore passes the pre-restore classroom snapshot to the merge', async () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8');
    const start = html.indexOf('async function syncFromR2()');
    const end = html.indexOf('// ==================== Data Management', start);
    assert.ok(start >= 0 && end > start, 'syncFromR2 function not found');

    const localClassroom = {
        courses: [{ id: 'local-course', sessions: [] }],
        seminars: []
    };
    let mergeLocal = null;
    const metadata = {
        books: [], papers: [], notes: {}, archived: [], lectures: {}, drafts: {},
        classroom: { courses: [], seminars: [] },
        exercises: { folders: [], wrongByFolder: {}, archivedWrong: {} },
        notebooks: { items: [], reviews: [] }, settings: {}
    };
    const context = {
        appData: {
            books: [], papers: [], classroom: localClassroom,
            settings: { r2Config: { accessKeyId: 'test' } }
        },
        r2GetObject: async () => JSON.stringify(metadata),
        metaDataCounts: () => ({ total: 0 }),
        pickApiSettingsFrom: () => ({}),
        deleteFileData: async () => {},
        mergeClassroomTombstones: (...sources) => sources.flat().filter(Boolean),
        applyClassroomOutboxTombstones: classroom => classroom || { courses: [], seminars: [] },
        r2SyncInProgress: false,
        r2PendingSyncQueue: [],
        triggerSyncOnFileChange: () => {},
        mergeClassroomData: (_cloud, local) => {
            mergeLocal = local;
            throw new Error('stop-after-classroom-merge');
        },
        confirm: () => true,
        i18n: key => key,
        showToast: () => {},
        showModal: () => {},
        loadR2Config: () => {},
        console: { log: () => {}, warn: () => {}, error: () => {} }
    };
    await vm.runInNewContext(html.slice(start, end) + '\nsyncFromR2();', context);
    assert.equal(mergeLocal, localClassroom);
});
