'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
    NOTE_FORMAT,
    noteContentKey,
    stripClassroomData,
    mergeClassroomMaterials,
    mergeClassroomNotes
} = require('../app/src/main/assets/www/classroom-storage.js');

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

const INDEX_HTML_PATH = path.join(__dirname, '../app/src/main/assets/www/index.html');

function readIndexHtml() {
    return fs.readFileSync(INDEX_HTML_PATH, 'utf8');
}

function sliceSource(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.ok(start >= 0, 'source marker not found: ' + startMarker);
    assert.ok(end > start, 'source end marker not found: ' + endMarker);
    return source.slice(start, end);
}

function loadIsolatedFunction(source, name, globals = {}) {
    const context = vm.createContext({ ...globals });
    const fn = vm.runInContext('(' + source.trim() + ')', context);
    return { fn, context };
}

test('note content identifiers are stable and validated', () => {
    assert.equal(NOTE_FORMAT, 'classroom-note-v1');
    assert.equal(noteContentKey('cnote_20260715_abcd'), 'classroom_note_cnote_20260715_abcd');
    assert.throws(() => noteContentKey(''), /Invalid classroom note id/);
    assert.throws(() => noteContentKey('../escape'), /Invalid classroom note id/);
});

test('cloud metadata excludes uncommitted payloads and strips large transient fields', () => {
    const classroom = {
        courses: [{
            id: 'course-1',
            sessions: [{
                id: 'session-1',
                sourceFolder: [
                    { id: 'photo-pending', type: 'image', assetCloudCommitted: false, data: 'data:image/jpeg;base64,pending' },
                    { id: 'photo-legacy', type: 'image', data: 'data:image/jpeg;base64,legacy' },
                    { id: 'photo-ready', type: 'image', assetCloudCommitted: true, data: 'data:image/jpeg;base64,ready' },
                    { id: 'recording-pending', type: 'recording', recordingCloudCommitted: false, data: 'audio' },
                    { id: 'recording-legacy', type: 'recording', data: 'audio-old' },
                    { id: 'recording-ready', type: 'recording', recordingCloudCommitted: true, data: 'audio-ready' }
                ],
                notes: [
                    { id: 'note-pending', contentKey: 'classroom_note_note-pending', contentCloudCommitted: false, content: 'pending body' },
                    { id: 'note-ready', contentKey: 'classroom_note_note-ready', contentCloudCommitted: true, content: 'ready body', _contentCache: 'cache', data: 'scratch' },
                    { id: 'note-legacy', content: 'legacy inline body', _contentCache: 'legacy cache', data: 'scratch' }
                ]
            }]
        }],
        seminars: []
    };
    const before = plain(classroom);

    const cloud = stripClassroomData(classroom, true);
    const session = cloud.courses[0].sessions[0];
    assert.deepEqual(session.sourceFolder.map(item => item.id), [
        'photo-legacy', 'photo-ready', 'recording-ready'
    ]);
    session.sourceFolder.forEach(item => assert.equal(Object.hasOwn(item, 'data'), false));
    assert.deepEqual(session.notes.map(note => note.id), ['note-ready', 'note-legacy']);
    assert.equal(Object.hasOwn(session.notes[0], 'content'), false);
    assert.equal(Object.hasOwn(session.notes[0], '_contentCache'), false);
    assert.equal(Object.hasOwn(session.notes[0], 'data'), false);
    assert.equal(session.notes[1].content, 'legacy inline body');
    assert.equal(Object.hasOwn(session.notes[1], '_contentCache'), false);
    assert.equal(Object.hasOwn(session.notes[1], 'data'), false);
    assert.deepEqual(classroom, before, 'stripClassroomData must not mutate its input');
});

test('local backup metadata keeps pending entries while still removing detached payloads', () => {
    const classroom = {
        courses: [{ sessions: [{
            sourceFolder: [{ id: 'photo', type: 'image', assetCloudCommitted: false, data: 'large photo' }],
            notes: [{
                id: 'note', contentKey: 'classroom_note_note', contentCloudCommitted: false,
                content: 'large note', _contentCache: 'cache'
            }]
        }] }],
        seminars: []
    };

    const local = stripClassroomData(classroom, false);
    const session = local.courses[0].sessions[0];
    assert.deepEqual(session.sourceFolder.map(item => item.id), ['photo']);
    assert.deepEqual(session.notes.map(item => item.id), ['note']);
    assert.equal(Object.hasOwn(session.sourceFolder[0], 'data'), false);
    assert.equal(Object.hasOwn(session.notes[0], 'content'), false);
    assert.equal(Object.hasOwn(session.notes[0], '_contentCache'), false);
});

test('payload commit and metadata commit remain separate crash-safe phases', () => {
    const asset = {
        id: 'photo-two-phase', type: 'image', assetCloudCommitted: true,
        assetMetadataCloudCommitted: false, uploadedAt: '2020-01-01T00:00:00.000Z'
    };
    const note = {
        id: 'note-two-phase', contentKey: 'classroom_note_note-two-phase',
        contentCloudCommitted: true, contentMetadataCloudCommitted: false,
        generatedAt: '2020-01-01T00:00:00.000Z'
    };
    const classroom = {
        courses: [{ sessions: [{ sourceFolder: [asset], notes: [note] }] }], seminars: []
    };

    const outbound = stripClassroomData(classroom, true).courses[0].sessions[0];
    assert.deepEqual(outbound.sourceFolder.map(item => item.id), ['photo-two-phase']);
    assert.deepEqual(outbound.notes.map(item => item.id), ['note-two-phase']);
    assert.equal(outbound.sourceFolder[0].assetMetadataCloudCommitted, true);
    assert.equal(outbound.notes[0].contentMetadataCloudCommitted, true);
    assert.equal(asset.assetMetadataCloudCommitted, false, 'projection must not clear the live pending flag');
    assert.equal(note.contentMetadataCloudCommitted, false, 'projection must not clear the live pending flag');

    assert.deepEqual(mergeClassroomMaterials([], [asset], Number.MAX_SAFE_INTEGER)
        .map(item => item.id), ['photo-two-phase']);
    assert.deepEqual(mergeClassroomNotes([], [note], Number.MAX_SAFE_INTEGER)
        .map(item => item.id), ['note-two-phase']);
});

test('recording stays pending until both body and metadata commit, then honors remote deletion', () => {
    const recording = {
        id: 'recording-two-phase', type: 'recording',
        recordingCloudCommitted: true,
        recordingMetadataCloudCommitted: false,
        uploadedAt: '2020-01-01T00:00:00.000Z'
    };
    const classroom = {
        courses: [{ sessions: [{ sourceFolder: [recording], notes: [] }] }],
        seminars: []
    };

    const outbound = stripClassroomData(classroom, true).courses[0].sessions[0].sourceFolder[0];
    assert.equal(outbound.recordingMetadataCloudCommitted, true,
        'the metadata candidate must publish the body-committed recording');
    assert.equal(recording.recordingMetadataCloudCommitted, false,
        'building the metadata candidate must leave the live recording pending');
    assert.deepEqual(mergeClassroomMaterials([], [recording], Number.MAX_SAFE_INTEGER)
        .map(item => item.id), ['recording-two-phase'],
    'a remote snapshot cannot delete a recording between the body and metadata commits');

    const fullyCommitted = { ...recording, recordingMetadataCloudCommitted: true };
    assert.deepEqual(mergeClassroomMaterials([], [fullyCommitted], Number.MAX_SAFE_INTEGER), [],
        'after both commits, an authoritative remote deletion must remove the local recording');
});

test('material merge always retains pending assets and uses timestamps for legacy assets', () => {
    const baseline = Date.parse('2026-07-15T12:00:00.000Z');
    const cloud = [{ id: 'cloud-only', type: 'image', uploadedAt: '2026-07-15T10:00:00.000Z' }];
    const local = [
        { id: 'photo-pending', type: 'image', assetCloudCommitted: false, uploadedAt: '2020-01-01T00:00:00.000Z', data: 'local bytes' },
        { id: 'legacy-old', type: 'image', uploadedAt: '2026-07-15T11:00:00.000Z' },
        { id: 'legacy-new', type: 'image', uploadedAt: '2026-07-15T13:00:00.000Z' },
        { id: 'recording-pending', type: 'recording', recordingCloudCommitted: false, uploadedAt: '2020-01-01T00:00:00.000Z' },
        { id: 'recording-legacy', type: 'recording', uploadedAt: '2020-01-01T00:00:00.000Z' }
    ];
    const cloudBefore = plain(cloud);
    const localBefore = plain(local);

    const merged = mergeClassroomMaterials(cloud, local, baseline);
    assert.deepEqual(merged.map(item => item.id), [
        'cloud-only', 'photo-pending', 'legacy-new', 'recording-pending', 'recording-legacy'
    ]);
    assert.deepEqual(cloud, cloudBefore);
    assert.deepEqual(local, localBefore);
    assert.notEqual(merged[0], cloud[0]);
    assert.notEqual(merged[1], local[0]);
});

test('pending local material wins an existing cloud id so a failed old upload can retry', () => {
    const cloud = [{ id: 'photo', type: 'image', name: 'cloud index', assetCloudCommitted: true }];
    const local = [{
        id: 'photo', type: 'image', name: 'local pending payload', assetCloudCommitted: false,
        uploadedAt: '2020-01-01T00:00:00.000Z', data: 'bytes'
    }];

    const merged = mergeClassroomMaterials(cloud, local, Number.MAX_SAFE_INTEGER);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, 'local pending payload');
    assert.equal(merged[0].assetCloudCommitted, false);
    assert.equal(merged[0].data, 'bytes');
});

test('note merge always retains pending content and uses timestamps for legacy notes', () => {
    const baseline = Date.parse('2026-07-15T12:00:00.000Z');
    const cloud = [{ id: 'cloud-note', content: 'cloud', progress: 10, maxProgress: 20 }];
    const local = [
        {
            id: 'pending-note', contentKey: 'classroom_note_pending-note',
            contentCloudCommitted: false, content: 'local body',
            generatedAt: '2020-01-01T00:00:00.000Z'
        },
        { id: 'legacy-old', content: 'old', generatedAt: '2026-07-15T11:00:00.000Z' },
        { id: 'legacy-new', content: 'new', generatedAt: '2026-07-15T13:00:00.000Z' }
    ];
    const cloudBefore = plain(cloud);
    const localBefore = plain(local);

    const merged = mergeClassroomNotes(cloud, local, baseline);
    assert.deepEqual(merged.map(note => note.id), ['cloud-note', 'pending-note', 'legacy-new']);
    assert.deepEqual(cloud, cloudBefore);
    assert.deepEqual(local, localBefore);
});

test('pending local note wins an existing cloud id while preserving maximum progress', () => {
    const cloud = [{
        id: 'note', title: 'cloud title', contentKey: 'classroom_note_note',
        contentCloudCommitted: true, progress: 80, maxProgress: 80
    }];
    const local = [{
        id: 'note', title: 'local pending title', contentKey: 'classroom_note_note',
        contentCloudCommitted: false, content: 'local body', progress: 20, maxProgress: 90
    }];

    const merged = mergeClassroomNotes(cloud, local, Number.MAX_SAFE_INTEGER);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, 'local pending title');
    assert.equal(merged[0].content, 'local body');
    assert.equal(merged[0].contentCloudCommitted, false);
    assert.equal(merged[0].progress, 80);
    assert.equal(merged[0].maxProgress, 90);
});

test('classroom tombstones filter cloud and local trees in periodic, startup, and manual pulls', () => {
    const html = readIndexHtml();
    const applySource = sliceSource(html,
        'function applyClassroomOutboxTombstones(',
        'async function r2PublishMetadataWithCas(');
    const { fn: applyTombstones } = loadIsolatedFunction(
        applySource, 'applyClassroomOutboxTombstones', { stripClassroomData });
    const classroom = id => ({
        courses: [{ id: 'folder-' + id, sessions: [{
            sourceFolder: [
                { id: 'keep-' + id, type: 'image' },
                { id: 'deleted-material', type: 'recording' }
            ],
            notes: [
                { id: 'keep-note-' + id },
                { id: 'deleted-note' }
            ]
        }] }, { id: 'deleted-folder', sessions: [] }],
        seminars: []
    });
    const remoteTombstones = [
        { fileId: 'deleted-material', action: 'recording_delete' },
        { fileId: 'deleted-note', action: 'classroom_note_delete' },
        { fileId: 'deleted-folder', action: 'classroom_folder_delete' }
    ];

    for (const side of ['cloud', 'local']) {
        const filtered = plain(applyTombstones(classroom(side), remoteTombstones));
        assert.deepEqual(filtered.courses.map(folder => folder.id), ['folder-' + side]);
        assert.deepEqual(filtered.courses[0].sessions[0].sourceFolder.map(item => item.id),
            ['keep-' + side]);
        assert.deepEqual(filtered.courses[0].sessions[0].notes.map(note => note.id),
            ['keep-note-' + side]);
    }

    const paths = [
        sliceSource(html, 'async function performAutoSync()',
            'function metaDataCounts('),
        sliceSource(html, 'async function autoSyncFromR2OnStartup()',
            'async function syncFromR2()'),
        sliceSource(html, 'async function syncFromR2()',
            'function dataZipCrc32(')
    ];
    for (const body of paths) {
        assert.match(body,
            /mergeClassroomTombstones\(\s*metadata\.classroomTombstones,\s*appData\.classroomTombstones\s*\)/,
            'the pull path must merge remote tombstones into the durable local set');
        assert.match(body,
            /applyClassroomOutboxTombstones\(\s*metadata\.classroom,\s*\w+Tombstones\s*\)/,
            'the pull path must filter the cloud classroom before merging');
        assert.match(body,
            /applyClassroomOutboxTombstones\(\s*localClassroom\w*,\s*\w+Tombstones\s*\)/,
            'the pull path must filter the local classroom before merging');
    }
});

test('classroom-only CAS preserves non-classroom fields from its fresh remote read', async () => {
    const html = readIndexHtml();
    const publishSource = sliceSource(html,
        'async function r2PublishMetadataWithCas(',
        'async function r2SyncMetadataOnly(');
    const remote = {
        books: [{ id: 'remote-book' }],
        papers: [{ id: 'remote-paper' }],
        settings: { theme: 'remote-theme' },
        remoteOnlyExtension: { preserved: true },
        classroom: { courses: [], seminars: [] },
        classroomTombstones: [],
        syncedAt: '2026-07-15T12:00:00.000Z'
    };
    const local = {
        books: [{ id: 'stale-local-book' }],
        papers: [],
        settings: { theme: 'stale-local-theme' },
        classroom: { courses: [], seminars: [] },
        classroomTombstones: []
    };
    const intent = {
        courses: [{ id: 'new-classroom', sessions: [] }],
        seminars: []
    };
    let uploaded = null;
    const appData = {
        classroom: plain(intent),
        classroomTombstones: [],
        classroomSyncOutbox: []
    };
    const { fn: publish } = loadIsolatedFunction(publishSource,
        'r2PublishMetadataWithCas', {
            appData,
            r2GetObject: async () => ({
                data: JSON.stringify(remote), etag: 'etag-remote', missing: false
            }),
            r2PutObject: async (_key, body) => { uploaded = JSON.parse(body); },
            stripClassroomData,
            mergeClassroomTombstones: (...sources) => sources.flat().filter(Boolean),
            applyClassroomOutboxTombstones: classroom => plain(classroom || {
                courses: [], seminars: []
            }),
            mergeClassroomData: (_cloud, classroomIntent) => plain(classroomIntent),
            r2ProtectMetadataOverwrite: async () => true,
            cleanupClassroomEntriesRemovedByMerge: async () => {},
            markClassroomMetadataCloudCommitted: async () => {},
            saveData: () => {}
        });

    const result = await publish(local, intent, { classroomOnly: true, allowEmpty: true });
    assert.equal(result.casCommitted, true);
    assert.deepEqual(plain(uploaded.books), remote.books);
    assert.deepEqual(plain(uploaded.papers), remote.papers);
    assert.deepEqual(plain(uploaded.settings), remote.settings);
    assert.deepEqual(plain(uploaded.remoteOnlyExtension), remote.remoteOnlyExtension);
    assert.deepEqual(plain(uploaded.classroom), intent);
});

test('metadata sync remains compatible when legacy R2 CORS does not expose ETag', async () => {
    const html = readIndexHtml();
    const publishSource = sliceSource(html,
        'async function r2PublishMetadataWithCas(',
        'async function r2SyncMetadataOnly(');
    const remote = {
        books: [{ id: 'remote-book' }],
        papers: [],
        classroom: { courses: [], seminars: [] },
        classroomTombstones: [],
        syncedAt: '2026-07-15T12:00:00.000Z'
    };
    const local = plain(remote);
    const intent = { courses: [{ id: 'local-classroom', sessions: [] }], seminars: [] };
    const appData = {
        classroom: plain(intent),
        classroomTombstones: [],
        classroomSyncOutbox: []
    };
    let writeOptions = null;
    const { fn: publish } = loadIsolatedFunction(publishSource,
        'r2PublishMetadataWithCas', {
            appData,
            r2GetObject: async () => ({
                data: JSON.stringify(remote), etag: null, missing: false
            }),
            r2PutObject: async (_key, _body, _contentType, options) => {
                writeOptions = plain(options);
            },
            stripClassroomData,
            mergeClassroomTombstones: (...sources) => sources.flat().filter(Boolean),
            applyClassroomOutboxTombstones: classroom => plain(classroom || {
                courses: [], seminars: []
            }),
            mergeClassroomData: (_cloud, classroomIntent) => plain(classroomIntent),
            r2ProtectMetadataOverwrite: async () => true,
            cleanupClassroomEntriesRemovedByMerge: async () => {},
            markClassroomMetadataCloudCommitted: async () => {},
            saveData: () => {}
        });

    const result = await publish(local, intent, { classroomOnly: true, allowEmpty: true });
    assert.equal(result.casCommitted, true);
    assert.deepEqual(writeOptions, {}, 'legacy CORS must use the pre-PR #56 write path');
});

test('R2 connection test treats ETag as an optional conditional-write capability', () => {
    const html = readIndexHtml();
    const source = sliceSource(html,
        'async function testR2Connection()',
        '// AWS Signature V4 for R2');
    assert.match(source, /readBack\?\.data\s*!==\s*testData/);
    assert.match(source, /if\s*\(readBack\.etag\)/);
    assert.doesNotMatch(source, /R2_ETAG_NOT_EXPOSED|CORS[^\n]*ETag/);
});

test('classroom cloud writes publish payloads before metadata and acknowledge metadata last', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8');
    const triggerStart = html.indexOf('async function triggerSyncOnFileChange(');
    const triggerEnd = html.indexOf('async function testR2Connection()', triggerStart);
    const trigger = html.slice(triggerStart, triggerEnd);
    const assetBranch = trigger.indexOf("action === 'classroom_upload'");
    const assetPayload = trigger.indexOf('await r2SyncClassroomAsset(found.material)', assetBranch);
    const assetMetadata = trigger.indexOf(
        'await r2SyncMetadataOnly({ classroomOnly: true })', assetPayload);
    assert.ok(assetBranch >= 0 && assetPayload > assetBranch && assetMetadata > assetPayload);
    const noteBranch = trigger.indexOf("action === 'classroom_note_upload'");
    const notePayload = trigger.indexOf('await r2SyncClassroomNote(found.note)', noteBranch);
    const noteMetadata = trigger.indexOf(
        'await r2SyncMetadataOnly({ classroomOnly: true })', notePayload);
    assert.ok(noteBranch >= 0 && notePayload > noteBranch && noteMetadata > notePayload);

    const metadataStart = html.indexOf('async function r2SyncMetadataOnly(');
    const metadataEnd = html.indexOf('// 清理doc对象用于同步', metadataStart);
    const metadataBody = html.slice(metadataStart, metadataEnd);
    assert.match(metadataBody, /await r2PublishMetadataWithCas\(metadata, classroomIntent, options\)/);

    const publishStart = html.indexOf('async function r2PublishMetadataWithCas(');
    const publishEnd = html.indexOf('async function r2SyncMetadataOnly(', publishStart);
    const publish = html.slice(publishStart, publishEnd);
    assert.ok(publish.indexOf("await r2PutObject('metadata.json'") <
        publish.indexOf('await markClassroomMetadataCloudCommitted(candidate.classroom)'));
    assert.match(publish, /ifMatch:\s*remoteResult\.etag/);
    assert.match(publish, /e\?\.status\s*!==\s*412/);
});

test('periodic sync publishes classroom CAS before flushing the deletion outbox', () => {
    const html = readIndexHtml();
    const periodic = sliceSource(html,
        'async function performAutoSync()', 'function metaDataCounts(');
    const publish = periodic.indexOf('const metadataPublishResult = await r2SyncMetadataOnly()');
    const committed = periodic.indexOf('metadataPublishResult.casCommitted', publish);
    const flush = periodic.indexOf('await flushClassroomDeletionOutboxAfterMetadata()', committed);
    assert.ok(publish >= 0 && committed > publish && flush > committed,
        'periodic sync must not delete remote payloads until its metadata CAS is committed');
});

test('classroom deletion paths roll back indexes when tombstone persistence fails', () => {
    const html = readIndexHtml();
    const folder = sliceSource(html,
        'async function deleteClassroomFolder(', 'function addClassroomSession(');
    assert.match(folder,
        /list\.splice\(idx, 1\);\s*if \(!enqueueClassroomSyncActions\(deletionActions\)\) \{\s*list\.splice\(idx, 0, folder\);\s*return;\s*\}\s*try \{/,
        'folder deletion must restore its splice and return when the tombstone batch is not durable');
    assert.ok(folder.indexOf('enqueueClassroomSyncActions(deletionActions)') <
        folder.indexOf('await recordingStore.remove(material.id)'),
    'folder bodies must remain intact until the tombstone batch succeeds');

    const material = sliceSource(html,
        'async function deleteClassroomMaterial(',
        '// 重新生成素材讲义');
    assert.match(material,
        /session\.sourceFolder\.splice\(idx, 1\);\s*if \(!enqueueClassroomSyncAction\(matId,[\s\S]*?\)\) \{\s*session\.sourceFolder\.splice\(idx, 0, material\);\s*return;\s*\}\s*try \{/,
        'single-material deletion must restore its splice and return when tombstone persistence fails');
    assert.ok(material.indexOf('enqueueClassroomSyncAction(matId') <
        material.indexOf('await recordingStore.remove(matId)'),
    'a material body must remain intact until its tombstone succeeds');

    const note = sliceSource(html,
        'async function deleteClassroomNote(', 'function downloadMarkdown(');
    assert.match(note,
        /session\.notes\.splice\(noteIdx, 1\);\s*if \(!enqueueClassroomSyncAction\(note\.id, 'classroom_note_delete'\)\) \{\s*session\.notes\.splice\(noteIdx, 0, note\);\s*return;\s*\}/,
        'single-note deletion must restore its splice and return when tombstone persistence fails');
    assert.ok(note.indexOf("enqueueClassroomSyncAction(note.id, 'classroom_note_delete')") <
        note.indexOf('await deleteClassroomNoteData(note, false)'),
    'a note body must remain intact until its tombstone succeeds');

    const expired = sliceSource(html,
        'function cleanupExpiredPhotos()', 'function savePhotoRetentionDays()');
    assert.match(expired,
        /if \(!enqueueClassroomSyncActions\([\s\S]*?\)\) \{\s*affectedSessions\.forEach\(item => \{ item\.session\.sourceFolder = item\.sourceFolder; \}\);\s*return;\s*\}\s*expired\.forEach\(material => deleteClassroomAssetData/,
        'expired-photo cleanup must restore every affected session before returning');
});

test('clear-all deletes bodies only after a successful tombstone commit and rolls back on failure', async () => {
    const html = readIndexHtml();
    const clearSource = sliceSource(html,
        'async function clearAllData()',
        '// ==================== Column Click to Import');
    const runClear = async saveResult => {
        const events = [];
        const initialAppData = {
            settings: {},
            classroomTombstones: [{
                fileId: 'prior-note', action: 'classroom_note_delete',
                deletedAt: '2026-07-15T00:00:00.000Z'
            }],
            classroomSyncOutbox: [{
                fileId: 'prior-note', action: 'classroom_note_delete',
                createdAt: '2026-07-15T00:00:00.000Z'
            }],
            classroom: {
                courses: [{ id: 'folder', sessions: [{
                    sourceFolder: [
                        { id: 'recording', type: 'recording' },
                        { id: 'photo', type: 'image' }
                    ],
                    notes: [{ id: 'note', contentKey: 'classroom_note_note' }]
                }] }],
                seminars: []
            }
        };
        const before = plain(initialAppData);
        const recordingStore = {
            remove: async id => { events.push('delete-recording:' + id); },
            listManifests: async () => []
        };
        const { fn: clearAllData, context } = loadIsolatedFunction(clearSource,
            'clearAllData', {
                appData: initialAppData,
                confirm: () => true,
                i18n: key => key,
                initRecordingStore: () => {},
                recordingStore,
                listFileKeys: async () => [],
                _callNativeRecording: action => action === 'listRecoverable'
                    ? { ok: true, items: [] } : { ok: true },
                deleteClassroomAssetData: async material => {
                    events.push('delete-asset:' + material.id);
                },
                deleteClassroomNoteData: async note => {
                    events.push('delete-note:' + note.id);
                },
                deleteFileData: async () => {},
                saveFileData: async () => {},
                mergeClassroomTombstones: (...sources) => {
                    const byKey = new Map();
                    for (const item of sources.flat()) {
                        if (item?.fileId && item?.action) {
                            byKey.set(item.action + ':' + item.fileId, item);
                        }
                    }
                    return [...byKey.values()];
                },
                triggerSyncOnFileChange: () => {},
                renderLibrary: () => {},
                renderNotesPage: () => {},
                renderClassroomPage: () => {},
                showToast: () => {},
                console: { error: () => {} }
            });
        context.saveData = () => {
            events.push({
                type: 'save',
                actions: plain(context.appData.classroomSyncOutbox || [])
                    .map(item => item.action + ':' + item.fileId).sort()
            });
            return saveResult;
        };
        await clearAllData();
        return { events, appData: plain(context.appData), before };
    };

    const required = [
        'classroom_delete:photo',
        'classroom_folder_delete:folder',
        'classroom_note_delete:note',
        'recording_delete:recording'
    ];
    const success = await runClear(true);
    const committedAt = success.events.findIndex(event => event?.type === 'save' &&
        required.every(key => event.actions.includes(key)));
    const firstBodyDelete = success.events.findIndex(event => typeof event === 'string' &&
        event.startsWith('delete-'));
    assert.ok(committedAt >= 0, 'the batch tombstones were never durably saved');
    assert.ok(firstBodyDelete > committedAt,
        'a local classroom body was deleted before all tombstones were durably saved');

    const failed = await runClear(false);
    assert.deepEqual(failed.appData.classroom, failed.before.classroom,
        'failed tombstone persistence must restore the classroom index');
    assert.deepEqual(failed.appData.classroomSyncOutbox, failed.before.classroomSyncOutbox,
        'failed tombstone persistence must restore the previous outbox');
    assert.deepEqual(failed.appData.classroomTombstones, failed.before.classroomTombstones,
        'failed tombstone persistence must restore the previous tombstones');
    assert.equal(failed.events.some(event => typeof event === 'string' &&
        event.startsWith('delete-')), false,
    'failed tombstone persistence must return before deleting any local body');
});

test('an unavailable recording upload stops retrying at the bounded attempt limit', async () => {
    const html = readIndexHtml();
    const triggerSource = sliceSource(html,
        'async function triggerSyncOnFileChange(',
        'async function testR2Connection()');
    let scheduled = 0;
    const retryTimers = new Map();
    const { fn: trigger } = loadIsolatedFunction(triggerSource,
        'triggerSyncOnFileChange', {
            appDataLoaded: true,
            appData: {
                settings: { r2Config: { accessKeyId: 'key', autoSyncOnChange: true } }
            },
            r2SyncInProgress: false,
            r2PendingSyncQueue: [],
            r2ClassroomRetryTimers: retryTimers,
            _findRecordingMaterial: () => ({
                material: {
                    id: 'missing-recording', type: 'recording',
                    recordingCloudCommitted: false
                }
            }),
            r2SyncRecording: async () => false,
            setTimeout: () => { scheduled++; return 1; },
            clearTimeout: () => {},
            console: { warn: () => {}, error: () => {} }
        });

    await trigger('missing-recording', 'recording_upload', 8);
    assert.equal(scheduled, 0,
        'a permanently unavailable payload must not schedule retries forever');
    assert.equal(retryTimers.size, 0);
});

test('full backup drops an orphan body when its recording is deleted during preflight', async () => {
    const html = readIndexHtml();
    const exportSource = sliceSource(html,
        'async function exportData()',
        'async function importDataZip(');
    const material = { id: 'recording-deleted-mid-export', type: 'recording' };
    const session = { id: 'session', sourceFolder: [material] };
    const classroom = {
        courses: [{ id: 'course', sessions: [session] }],
        seminars: []
    };
    const audio = new Blob(['orphan-audio'], { type: 'audio/webm' });
    let zipFiles = null;
    const { fn: exportData } = loadIsolatedFunction(exportSource, 'exportData', {
        Blob,
        ArrayBuffer,
        classroomRecordingState: null,
        appData: {
            books: [], papers: [], archived: [], lectures: {}, settings: {}, classroom,
            exercises: { folders: [], wrongByFolder: {}, archivedWrong: {} }
        },
        saveExercisesToIDB: async () => {},
        backupAppDataToIDB: () => {},
        cleanDocForSync: value => value,
        stripLectureContent: value => value,
        stripClassroomData,
        stripExercisesData: value => value,
        _prepareRecordingExport: async () => {
            session.sourceFolder = [];
            return {
                source: { kind: 'legacy', complete: true },
                byteLength: audio.size,
                mimeType: audio.type,
                idbEntries: null,
                chunks: [{ data: audio, size: audio.size, sha256: 'orphan-hash' }],
                incomplete: false
            };
        },
        listFileKeys: async () => [
            '__recording_manifest_' + material.id,
            '__recording_chunk_' + material.id + '_00000000'
        ],
        getFileData: async () => new Blob(['stale-journal']),
        dataZipCreate: async files => { zipFiles = files; return new Blob(['zip']); },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
        document: { createElement: () => ({ click() {} }) },
        window: {
            RecordingStorage: {
                MANIFEST_PREFIX: '__recording_manifest_',
                CHUNK_PREFIX: '__recording_chunk_'
            }
        },
        setTimeout: callback => { callback(); return 1; },
        showToast: () => {},
        i18n: key => key,
        console: { warn: () => {}, error: () => {} }
    });

    await exportData();

    const metadata = JSON.parse(zipFiles.find(file => file.name === 'metadata.json').data);
    assert.deepEqual(metadata.classroom.courses[0].sessions[0].sourceFolder, []);
    assert.equal(zipFiles.some(file => file.name === 'recordings/index.json'), false,
        'the deleted recording must not leave a portable body that recovery can resurrect');
    const idbIndex = JSON.parse(zipFiles.find(file => file.name === 'idb/index.json').data);
    assert.deepEqual(idbIndex, [],
        'the deleted recording must not leave a verified or raw journal in the backup');
});

test('recording backup preflight validates IDB chunks and falls back to a readable copy', async () => {
    const html = readIndexHtml();
    const readSource = sliceSource(html,
        'async function _readRecordingExportCandidate(',
        'async function _prepareRecordingExport(');
    const prepareSource = sliceSource(html,
        'async function _prepareRecordingExport(',
        'async function exportData()');
    const material = {
        id: 'recording-fallback', type: 'recording', mimeType: 'audio/webm'
    };
    const legacyBlob = new Blob(['12345'], { type: 'audio/webm' });
    const candidates = [{
        kind: 'idb', byteLength: 6, complete: true,
        manifest: { id: material.id, chunkCount: 2, byteLength: 6, mimeType: 'audio/webm' }
    }, {
        kind: 'legacy', byteLength: legacyBlob.size, complete: true, blob: legacyBlob
    }];
    const context = vm.createContext({
        Blob,
        R2_RECORDING_GROUP_BYTES: 4,
        window: {
            RecordingStorage: {
                manifestKey: id => 'manifest:' + id,
                chunkKey: (id, index) => 'chunk:' + id + ':' + index
            }
        },
        recordingStore: {
            getChunk: async (_id, index) => index === 0 ? new Blob(['abc']) : null
        },
        appData: { settings: {} },
        _recordingSourceCandidates: async () => ({ candidates }),
        r2RestoreRecording: async () => null,
        _readNativeRecordingRange: async () => { throw new Error('native source not expected'); },
        sha256Hex: async blob => 'hash-' + blob.size,
        console: { warn: () => {} }
    });
    vm.runInContext(readSource + '\n' + prepareSource +
        '\nthis.__prepareRecordingExport = _prepareRecordingExport;', context);

    const prepared = await context.__prepareRecordingExport(material);
    assert.equal(prepared.source.kind, 'legacy');
    assert.equal(prepared.incomplete, true,
        'falling back from a longer corrupt copy must be explicit');
    assert.deepEqual(Array.from(prepared.chunks, chunk => chunk.size), [4, 1]);
});

test('a shorter IDB fallback uses portable incomplete restore semantics', async () => {
    const html = readIndexHtml();
    const readSource = sliceSource(html,
        'async function _readRecordingExportCandidate(',
        'async function _prepareRecordingExport(');
    const prepareSource = sliceSource(html,
        'async function _prepareRecordingExport(',
        'async function exportData()');
    const material = {
        id: 'recording-short-idb', type: 'recording', mimeType: 'audio/webm'
    };
    const manifest = {
        id: material.id, chunkCount: 2, byteLength: 6, mimeType: 'audio/webm'
    };
    const context = vm.createContext({
        Blob,
        R2_RECORDING_GROUP_BYTES: 4,
        window: {
            RecordingStorage: {
                manifestKey: id => 'manifest:' + id,
                chunkKey: (id, index) => 'chunk:' + id + ':' + index
            }
        },
        recordingStore: {
            getChunk: async (_id, index) => new Blob([index ? 'def' : 'abc'])
        },
        appData: { settings: {} },
        _recordingSourceCandidates: async () => ({
            candidates: [{
                kind: 'native', byteLength: 10, complete: true,
                nativeStatus: { mimeType: 'audio/webm' }
            }, {
                kind: 'idb', byteLength: 6, complete: true, manifest
            }]
        }),
        r2RestoreRecording: async () => { throw new Error('cloud restore not expected'); },
        _readNativeRecordingRange: async () => { throw new Error('native body is missing'); },
        sha256Hex: async blob => 'hash-' + blob.size,
        console: { warn: () => {} }
    });
    vm.runInContext(readSource + '\n' + prepareSource +
        '\nthis.__prepareRecordingExport = _prepareRecordingExport;', context);

    const prepared = await context.__prepareRecordingExport(material);
    assert.equal(prepared.source.kind, 'idb');
    assert.equal(prepared.incomplete, true);
    assert.equal(prepared.idbEntries, null,
        'a shorter journal must not be restored through the normal complete-IDB path');
    assert.deepEqual(Array.from(prepared.chunks, chunk => chunk.size), [3, 3]);
});

test('recording candidate discovery errors degrade to one missing item', async () => {
    const html = readIndexHtml();
    const readSource = sliceSource(html,
        'async function _readRecordingExportCandidate(',
        'async function _prepareRecordingExport(');
    const prepareSource = sliceSource(html,
        'async function _prepareRecordingExport(',
        'async function exportData()');
    const context = vm.createContext({
        Blob,
        appData: { settings: {} },
        _recordingSourceCandidates: async () => { throw new Error('broken legacy data URL'); },
        console: { warn: () => {} }
    });
    vm.runInContext(readSource + '\n' + prepareSource +
        '\nthis.__prepareRecordingExport = _prepareRecordingExport;', context);

    const prepared = await context.__prepareRecordingExport({
        id: 'recording-broken-source', type: 'recording'
    });
    assert.equal(prepared.missing, true);
    assert.match(prepared.error.message, /broken legacy data URL/);
});

test('recording backup preflight replaces a shorter fallback with the complete cloud copy', async () => {
    const html = readIndexHtml();
    const readSource = sliceSource(html,
        'async function _readRecordingExportCandidate(',
        'async function _prepareRecordingExport(');
    const prepareSource = sliceSource(html,
        'async function _prepareRecordingExport(',
        'async function exportData()');
    const material = {
        id: 'recording-cloud', type: 'recording', mimeType: 'audio/webm',
        recordingCloudCommitted: true
    };
    const localChunks = [new Blob(['abc']), new Blob(['def'])];
    const restoredChunks = [new Blob(['12345']), new Blob(['67890'])];
    let restored = false;
    let manifestReads = 0;
    let restoreAttempts = 0;
    const localManifest = {
        id: material.id, chunkCount: 2, byteLength: 6, mimeType: 'audio/webm'
    };
    const restoredManifest = {
        id: material.id, chunkCount: 2, byteLength: 10, mimeType: 'audio/webm'
    };
    const remoteManifest = {
        format: 'recording-r2-groups-v1', byteLength: 10,
        groups: [{ key: 'group-0', size: 5 }, { key: 'group-1', size: 5 }]
    };
    const context = vm.createContext({
        Blob,
        R2_RECORDING_GROUP_BYTES: 4,
        window: {
            RecordingStorage: {
                manifestKey: id => 'manifest:' + id,
                chunkKey: (id, index) => 'chunk:' + id + ':' + index
            }
        },
        recordingStore: {
            getChunk: async (_id, index) => (restored ? restoredChunks : localChunks)[index]
        },
        appData: { settings: { r2Config: { accessKeyId: 'key' } } },
        _recordingSourceCandidates: async () => ({
            candidates: restored ? [{
                kind: 'idb', byteLength: 10, complete: true, manifest: restoredManifest
            }] : [{
                kind: 'idb', byteLength: 6, complete: true, manifest: localManifest
            }]
        }),
        r2GetRecordingManifest: async () => { manifestReads++; return remoteManifest; },
        r2RestoreRecording: async (_material, knownRemote) => {
            restoreAttempts++;
            assert.equal(knownRemote, remoteManifest,
                'the already-fetched commit manifest should be reused for restore');
            restored = true;
            return {};
        },
        _readNativeRecordingRange: async () => { throw new Error('native source not expected'); },
        sha256Hex: async () => 'unused',
        console: { warn: () => {} }
    });
    vm.runInContext(readSource + '\n' + prepareSource +
        '\nthis.__prepareRecordingExport = _prepareRecordingExport;', context);

    const prepared = await context.__prepareRecordingExport(material);
    assert.equal(manifestReads, 1,
        'the remote generation length must be checked even when local IDB looks complete');
    assert.equal(restoreAttempts, 1);
    assert.equal(prepared.source.kind, 'idb');
    assert.equal(prepared.byteLength, 10);
    assert.equal(prepared.incomplete, false);
    assert.deepEqual(Array.from(prepared.idbEntries, entry => entry.key), [
        'manifest:' + material.id,
        'chunk:' + material.id + ':0',
        'chunk:' + material.id + ':1'
    ]);
});

test('R2 body restore does not acknowledge an uncommitted metadata phase', async () => {
    const html = readIndexHtml();
    const restoreSource = sliceSource(html,
        'async function r2RestoreRecording(material, knownRemote)',
        'async function r2DeleteRecording(');
    const material = {
        id: 'recording-cloud-two-phase',
        type: 'recording',
        recordingMetadataCloudCommitted: false
    };
    const body = new Blob(['audio'], { type: 'audio/webm' });
    const remote = {
        id: material.id,
        mimeType: body.type,
        byteLength: body.size,
        groups: [{ key: 'recordings/group-0', size: body.size }]
    };
    const { fn: restoreRecording } = loadIsolatedFunction(restoreSource, 'r2RestoreRecording', {
        Blob,
        window: { RecordingStorage: { FORMAT: 'recording-chunks-v1' } },
        initRecordingStore: () => {},
        recordingStore: {
            restore: async (manifest, readChunk) => {
                assert.equal((await readChunk(0)).size, body.size);
                return manifest;
            }
        },
        r2GetObject: async () => body,
        sha256Hex: async () => 'unused',
        saveData: () => true
    });

    await restoreRecording(material, remote);

    assert.equal(material.recordingCloudCommitted, true);
    assert.equal(material.recordingMetadataCloudCommitted, false,
        'restoring the body cannot commit the separate metadata phase');
    assert.equal(material.recordingStatus, 'ready');
});

test('committed recordings are not kept alive after a remote metadata deletion', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8');
    const start = html.indexOf('function classroomMaterialIsPending(');
    const end = html.indexOf('function classroomNoteIsPending(', start);
    assert.ok(start >= 0 && end > start, 'classroom pending helper not found');
    const helper = html.slice(start, end);
    assert.match(helper, /recordingCloudCommitted\s*!==\s*true/);
    assert.doesNotMatch(helper, /material\.type\s*===\s*['"]recording['"]\)\s*return\s+true/);
});

test('body-committed recordings publish pending metadata without retransmitting audio', () => {
    const html = readIndexHtml();
    const trigger = sliceSource(html,
        'async function triggerSyncOnFileChange(',
        'async function testR2Connection()');
    const recordingBranch = sliceSource(trigger,
        "if (action === 'recording_upload' && fileId)",
        "} else if (action === 'classroom_upload' && fileId)");
    assert.match(recordingBranch,
        /recordingCloudCommitted\s*!==\s*true\s*&&\s*!await r2SyncRecording\(found\.material\)/,
        'event sync must skip the audio upload after its body commit');
    assert.match(recordingBranch,
        /await r2SyncMetadataOnly\(\{ classroomOnly: true \}\)/,
        'event sync must still publish the pending metadata phase');

    const periodic = sliceSource(html,
        'async function performAutoSync()', 'function metaDataCounts(');
    assert.match(periodic,
        /found\.material\.recordingCloudCommitted\s*!==\s*true\s*&&\s*!await r2SyncRecording\(found\.material\)/,
        'periodic sync must not retransmit an already committed long recording body');
});

test('recording notes segment locally, process serially, and commit only after every part succeeds', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8');
    const start = html.indexOf('async function generateClassroomRecordingNote(');
    const end = html.indexOf('async function onClassroomCameraCapture', start);
    assert.ok(start >= 0 && end > start, 'recording note generator not found');
    const body = html.slice(start, end);
    const prepare = body.indexOf('await _prepareRecordingAiSegments(material)');
    const run = body.indexOf('await window.RecordingAI.runRecordingNoteJob');
    const commit = body.indexOf('await _commitGeneratedClassroomNote');
    assert.ok(prepare >= 0 && run > prepare && commit > run);
    assert.match(body, /finally\s*\{[\s\S]*prepared\?\.cleanup/,
        'temporary native/browser segments must always be released');
});

test('photo and generated-note bodies are durably stored before their metadata references', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/www/index.html'), 'utf8');
    const uploadStart = html.indexOf('async function processClassroomUpload(files)');
    const uploadEnd = html.indexOf('async function generateClassroomNoteForMaterial', uploadStart);
    const upload = html.slice(uploadStart, uploadEnd);
    const durableSave = upload.indexOf(
        'await saveClassroomAssetRecord(material, base64, durableContext)');
    const dropInlineBody = upload.indexOf('delete material.data', durableSave);
    const publishReference = upload.indexOf('currentSession.sourceFolder.push(material)');
    assert.ok(durableSave >= 0 && dropInlineBody > durableSave && publishReference > dropInlineBody,
        'the inline photo copy must be released after durable save and before metadata publication');
    const generationLoop = upload.indexOf('for (const id of added)', publishReference);
    assert.ok(generationLoop > publishReference &&
        upload.indexOf('const found = _findRecordingMaterial(id)', generationLoop) > generationLoop,
    'auto-generation must re-resolve each uploaded material by stable id');

    const commitStart = html.indexOf('async function _commitGeneratedClassroomNote(options)');
    const commitEnd = html.indexOf('const RECORDING_AI_SEGMENT_MS', commitStart);
    const commit = html.slice(commitStart, commitEnd);
    assert.ok(commit.indexOf('await saveClassroomNoteRecord(note, content') <
        commit.indexOf('current.session.notes.push(note)'));
    assert.match(commit, /_findRecordingMaterial\(options\.materialId\)/,
        'AI completion must re-resolve the live classroom tree by stable material id');
});

test('APK and PWA classroom storage modules stay byte-identical', () => {
    const root = path.join(__dirname, '..');
    const appModule = fs.readFileSync(path.join(root, 'app/src/main/assets/www/classroom-storage.js'));
    const docsModule = fs.readFileSync(path.join(root, 'docs/classroom-storage.js'));
    assert.deepEqual(appModule, docsModule);
});
