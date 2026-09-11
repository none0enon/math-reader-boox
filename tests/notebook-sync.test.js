// Run with: node tests/notebook-sync.test.js. Production helpers; storage/network stay in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
const start = html.indexOf('        const _nbPageStoreLocks =');
const end = html.indexOf('        function r2NotebookPositionKey(', start);
assert(start >= 0 && end > start);
const source = html.slice(start, end);
const body = (...ids) => JSON.stringify({ strokes: ids.map(id => ({ id, paths: [[[1, 2]]] })), texts: [], media: [] });
const key = id => 'notebooks/pages/nbpage_' + id;

function environment() {
    const local = new Map(), cloud = new Map(), puts = [], notices = [];
    let etagId = 0, uid = 0;
    const hooks = {};
    const setCloud = (id, raw, etag = '"e' + ++etagId + '"') => cloud.set(key(id), { data: raw, etag, missing: false });
    const context = vm.createContext({
        console, Map, Set, Promise, JSON, Math,
        appData: { notebooks: { items: [{ id: 'book', pages: [{ id: 'page', template: 'blank' }] }], tombstones: [] } },
        nbState: { pageId: null, notebookId: null, content: null, dirty: false, drawing: null },
        sha256Hex: async text => createHash('sha256').update(text).digest('hex'),
        nbUid: prefix => prefix + '_' + ++uid,
        nbUpdatePageNo() {}, showToast: text => notices.push(text),
        saveData: () => hooks.metadata !== false,
        getFileData: async id => local.get(id) || null,
        saveFileData: async (id, data) => local.set(id, data),
        saveFilePairAtomic: async (a, av, b, bv) => {
            if (hooks.storageFailure) throw new Error('synthetic storage failure');
            local.set(a, av); local.set(b, bv);
        },
        listFileKeys: async () => [...local.keys()],
        nbSerializePageContent: () => JSON.stringify(context.nbState.content, (k, v) => k.startsWith('_') ? undefined : v),
        r2GetObject: async (objectKey, options) => {
            if (hooks.get) await hooks.get(objectKey);
            const entry = cloud.get(objectKey) || { data: null, etag: null, missing: true };
            if (hooks.afterGet) await hooks.afterGet(objectKey, entry);
            return options?.withMetadata ? { ...entry } : entry.data;
        },
        r2PutObject: async (objectKey, raw, type, conditions = {}) => {
            puts.push({ objectKey, raw, conditions });
            if (hooks.put) await hooks.put(objectKey, raw, conditions);
            if (objectKey.startsWith('notebooks/pages/')) {
                assert(conditions.ifMatch || conditions.ifNoneMatch, 'every page PUT is conditional');
                const entry = cloud.get(objectKey);
                if ((conditions.ifNoneMatch && entry) || (conditions.ifMatch && entry?.etag !== conditions.ifMatch)) {
                    throw Object.assign(new Error('synthetic conflict'), { status: 412 });
                }
            }
            cloud.set(objectKey, { data: raw, etag: '"e' + ++etagId + '"', missing: false });
        },
        syncTimestamp: value => Date.parse(value) || 0,
    });
    vm.runInContext(source, context);
    const importStart = html.indexOf('        async function importBackupAsset(');
    assert(importStart >= 0);
    vm.runInContext(html.slice(importStart, html.indexOf('\n        }', importStart) + 10), context);
    const seed = async (raw, base) => {
        local.set('nbpage_page', raw);
        local.set('nbpagebase_page', base ? await context.nbPageFingerprint(base) : '');
    };
    const copies = () => context.appData.notebooks.items[0].pages.filter(page => page.conflictOf === 'page');
    return { context, local, cloud, puts, notices, hooks, setCloud, seed, copies };
}

async function main() {
    {
        const e = environment();
        assert.equal(await e.context.nbPageFingerprint('{"strokes":[],"texts":[],"media":[],"updatedAt":"old","_cloudBase":"x"}'),
            await e.context.nbPageFingerprint('{"media":[],"texts":[],"strokes":[],"updatedAt":"future"}'));
        await e.seed(body('old', 'new'), body('old'));
        e.setCloud('page', body('old'));
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.cloud.get(key('page')).data, body('old', 'new'));
        assert.equal(e.copies().length, 0);
        assert.equal(e.local.get('nbpagebase_page'), await e.context.nbPageFingerprint(body('old', 'new')));
    }
    {
        const e = environment();
        await e.seed(body('old', 'new'), body('old')); e.setCloud('page', body('old'));
        await Promise.all([e.context.r2SyncNotebookPageBundle('page'), e.context.r2SyncNotebookPageBundle('page')]);
        assert.equal(e.puts.length, 1, 'same-page uploads serialize and the second observes the completed first upload');
    }
    for (const mode of ['unknown-base', 'remote-edit', 'no-etag', '412', 'create-412']) {
        const e = environment();
        const old = body('old'), local = body('old', 'local'), remote = body('old', 'remote');
        await e.seed(local, mode === 'unknown-base' ? null : old);
        if (mode !== 'create-412') e.setCloud('page', mode === 'remote-edit' || mode === 'unknown-base' ? remote : old,
            mode === 'no-etag' ? null : '"initial"');
        let raced = false;
        if (mode.includes('412')) e.hooks.put = objectKey => {
            if (!raced && objectKey === key('page')) { raced = true; e.setCloud('page', remote); }
        };
        await e.context.r2SyncNotebookPageBundle('page');
        const expected = mode === 'no-etag' ? old : remote;
        assert.equal(e.cloud.get(key('page')).data, expected, mode + ': remote body survives');
        assert.equal(e.local.get('nbpage_page'), expected, mode + ': original IDB adopts remote only after preservation');
        assert.equal(e.copies().length, 1, mode + ': visible local conflict copy');
        const copyId = e.copies()[0].id;
        assert.equal(e.local.get('nbpage_' + copyId), local);
        assert.equal(e.cloud.get(key(copyId)).data, local, mode + ': local version is independently recoverable in cloud');
        assert(e.local.has('nbconflict_' + copyId));
    }
    {
        const e = environment();
        const old = body('old'), persisted = body('old', 'disk-edit'), live = body('old', 'live-edit'), remote = body('remote');
        await e.seed(persisted, old);
        Object.assign(e.context.nbState, { notebookId: 'book', pageId: 'page', content: JSON.parse(live), dirty: true, drawing: { mode: 'stroke' } });
        e.context.nbState.content._cloudBase = await e.context.nbPageFingerprint(old);
        const liveObject = e.context.nbState.content, drawing = e.context.nbState.drawing;
        const result = await e.context.nbAcceptCloudPage('page', remote);
        assert.equal(e.local.get('nbpage_page'), remote);
        assert.equal(e.context.nbState.content, liveObject, 'pull does not replace the active editor object');
        assert.equal(e.context.nbState.drawing, drawing);
        assert.equal(e.context.nbState.dirty, true);
        assert.equal(result.conflictPageIds.length, 2, 'both differing IDB and live editor bodies survive');
        assert.deepEqual(new Set(result.conflictPageIds.map(id => e.local.get('nbpage_' + id))), new Set([persisted, live]));
        assert.equal(e.context.nbState.pageId, result.conflictPageId);
        assert.equal(e.context.nbState.content._cloudBase, '');
    }
    {
        const e = environment();
        const old = body('old'), remote = body('remote');
        await e.seed(remote, null);
        Object.assign(e.context.nbState, { notebookId: 'book', pageId: 'page', content: JSON.parse(old), dirty: false });
        e.context.nbState.content._cloudBase = '';
        const result = await e.context.nbAcceptCloudPage('page', remote);
        assert(result.conflictPageId, 'IDB equality cannot claim an unrelated old active editor');
        assert.equal(e.local.get('nbpage_' + result.conflictPageId), old);
    }
    {
        const e = environment();
        const old = JSON.stringify({ ...JSON.parse(body('old')), updatedAt: '2099-01-01T00:00:00Z' });
        const remote = JSON.stringify({ ...JSON.parse(body('remote')), updatedAt: '2000-01-01T00:00:00Z' });
        await e.seed(old, old);
        e.context.appData.notebooks.items[0].pages[0].updatedAt = '2000-01-01T00:00:00Z';
        e.setCloud('page', remote);
        await e.context.r2PullNotebookAssetsFromCloud({ missingOnly: true });
        assert.equal(e.local.get('nbpage_page'), remote, 'clock skew cannot hide a changed cloud body');
    }
    {
        const e = environment();
        const old = body('old'), pending = body('old', 'pending');
        await e.seed(pending, old); e.setCloud('page', old);
        await e.context.r2PullNotebookAssetsFromCloud({ missingOnly: false });
        assert.equal(e.local.get('nbpage_page'), pending, 'an unchanged remote baseline cannot roll back local pending edits');
        assert.equal(e.copies().length, 0, 'ordinary pending edits do not become conflict copies');
        let pulled = false;
        e.hooks.put = async objectKey => {
            if (!pulled && objectKey === key('page')) {
                pulled = true;
                // A1 is still remote while A2 is uploading; a pull must not replace A2 before its acknowledgement.
                await e.context.r2PullNotebookAssetsFromCloud({ missingOnly: false });
            }
        };
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.local.get('nbpage_page'), pending);
        assert.equal(e.local.get('nbpagebase_page'), await e.context.nbPageFingerprint(pending));
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.cloud.get(key('page')).data, pending, 'acknowledgement cannot authorize a pulled older body to overwrite A2');
        assert.equal(e.puts.length, 1);
        assert.equal(e.copies().length, 0);
    }
    {
        const e = environment();
        const old = body('old'), newer = body('old', 'saved-and-uploaded');
        await e.seed(old, old); e.setCloud('page', old);
        let uploaded = false;
        e.hooks.afterGet = async objectKey => {
            if (!uploaded && objectKey === key('page')) {
                uploaded = true;
                // The GET response is already A; before JS receives it, a newer save/upload completes.
                await e.context.nbWithPageStoreLock('page', async () => {
                    e.local.set('nbpage_page', newer);
                    e.local.set('nbpagebase_page', await e.context.nbPageFingerprint(newer));
                });
                e.setCloud('page', newer);
            }
        };
        await e.context.r2PullNotebookAssetsFromCloud({ missingOnly: false });
        assert.equal(e.local.get('nbpage_page'), newer, 'a delayed GET response cannot roll back a newer confirmed local save');
        assert.equal(e.local.get('nbpagebase_page'), await e.context.nbPageFingerprint(newer));
    }
    {
        const e = environment();
        const old = body('old'), first = body('old', 'first'), latest = body('old', 'first', 'second');
        await e.seed(first, old); e.setCloud('page', old);
        let edited = false;
        e.hooks.put = async objectKey => {
            if (!edited && objectKey === key('page')) {
                edited = true;
                await e.context.nbWithPageStoreLock('page', async () => e.local.set('nbpage_page', latest));
            }
        };
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.local.get('nbpage_page'), latest, 'an upload completion cannot write an older snapshot back to IDB');
        assert.equal(e.local.get('nbpagebase_page'), await e.context.nbPageFingerprint(first));
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.cloud.get(key('page')).data, latest);
        assert.equal(e.copies().length, 0);
    }
    {
        const e = environment();
        const old = body('old'), remote = body('remote');
        await e.seed(remote, null);
        Object.assign(e.context.nbState, { notebookId: 'book', pageId: 'page', content: JSON.parse(old) });
        e.context.nbState.content._cloudBase = '';
        await e.context.nbConfirmCloudPage('page', remote, '');
        assert.equal(e.context.nbState.content._cloudBase, '', 'unknown editor ancestry remains unknown after another snapshot uploads');
    }
    {
        const e = environment();
        const sent = body('sent'), imported = body('imported-different-history');
        await e.seed(sent, null);
        let restored = false;
        e.hooks.put = async objectKey => {
            if (!restored && objectKey === key('page')) {
                restored = true;
                await e.context.importBackupAsset('nbpage_page', imported);
            }
        };
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.local.get('nbpage_page'), imported);
        assert.equal(e.local.get('nbpagebase_page'), '', 'an upload with unknown ancestry cannot claim an unrelated imported snapshot');
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.cloud.get(key('page')).data, sent, 'the imported history cannot overwrite the just-uploaded original');
        assert.equal(e.copies().length, 1);
        assert.equal(e.cloud.get(key(e.copies()[0].id)).data, imported);
    }
    {
        const e = environment();
        const original = body('local');
        await e.seed(original, null);
        e.hooks.storageFailure = true;
        await assert.rejects(e.context.nbAcceptCloudPage('page', body('remote')), /storage failure/);
        assert.equal(e.local.get('nbpage_page'), original, 'failed conflict preservation never overwrites local body');
        assert.equal(e.copies().length, 0);
        e.hooks.storageFailure = false;
        e.hooks.metadata = false;
        await assert.rejects(e.context.nbAcceptCloudPage('page', body('remote')), /conflict index/);
        assert.equal(e.local.get('nbpage_page'), original, 'failed recovery-index persistence must not replace original');
        const manifestKey = [...e.local.keys()].find(key => key.startsWith('nbconflict_'));
        assert(manifestKey, 'body and restoration manifest survive metadata failure');
        e.context.appData.notebooks.items[0].pages = [{ id: 'page' }];
        e.context.console = { ...console, error() {} };
        await e.context.nbRecoverNotebookConflicts();
        assert.equal(e.copies().length, 1, 'quota failure still leaves recovered pages accessible in memory');
        assert(e.local.has(manifestKey), 'quota failure retains the durable recovery manifest');
        e.context.appData.notebooks.items[0].pages = [{ id: 'page' }];
        e.hooks.metadata = true;
        await e.context.nbRecoverNotebookConflicts();
        assert.equal(e.copies().length, 1);
        e.context.appData.notebooks.tombstones.push({ kind: 'page', id: e.copies()[0].id });
        e.context.appData.notebooks.items[0].pages = [{ id: 'page' }];
        await e.context.nbRecoverNotebookConflicts();
        assert.equal(e.copies().length, 0, 'recovery respects explicit deletion');
        e.local.set('nbconflict_corrupt', 'corrupt');
        e.context.console = { ...console, warn() {} };
        await e.context.nbRecoverNotebookConflicts();
        assert.equal(e.local.get('nbconflict_corrupt'), 'corrupt', 'bad manifest does not abort recovery or erase original bytes');
    }
    {
        const e = environment();
        await e.seed(body('local'), null);
        const copy = await e.context.nbWithPageStoreLock('page', () => e.context.nbPreserveNotebookConflict('page', body('local')));
        e.local.set('nbpage_' + copy, body('local', 'edited-copy'));
        const next = await e.context.nbWithPageStoreLock('page', () => e.context.nbPreserveNotebookConflict('page', body('local')));
        assert.notEqual(next, copy);
        assert.equal(e.local.get('nbpage_' + copy), body('local', 'edited-copy'));
    }
    {
        const e = environment();
        e.local.set('nbpage_page', 'corrupt'); e.setCloud('page', body('remote'));
        await assert.rejects(e.context.r2SyncNotebookPageBundle('page'));
        assert.equal(e.puts.length, 0);
        assert.equal(e.local.get('nbpage_page'), 'corrupt');
        e.local.delete('nbpage_page');
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.puts.length, 0, 'missing local body cannot upload an empty page');
        assert.equal(e.local.get('nbpage_page'), body('remote'));
        await assert.rejects(e.context.nbAcceptCloudPage('page', '{}'), /Invalid notebook page/);
        assert.equal(e.local.get('nbpage_page'), body('remote'), 'missing body arrays are corruption, not an empty page');
        e.context.appData.notebooks.tombstones.push({ kind: 'page', id: 'page' });
        e.local.set('nbpage_page', body('stale'));
        await e.context.r2SyncNotebookPageBundle('page');
        assert.equal(e.puts.length, 0, 'queued stale update cannot resurrect an explicitly deleted page');
        const result = await e.context.nbAcceptCloudPage('page', body('cloud-after-delete'));
        assert.equal(result.accepted, false);
        assert.equal(e.local.get('nbpage_page'), body('stale'), 'in-flight pull cannot rewrite an explicitly deleted page');
    }
    assert.equal((html.match(/r2PutObject\('notebooks\/pages\/nbpage_'/g) || []).length, 1,
        'periodic and manual notebook uploads must use the single protected PUT');
    console.log('Notebook sync preservation checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
