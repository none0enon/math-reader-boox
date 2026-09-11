// Run with: node tests/notebook-save.test.js
// Real save/load/input functions, with delayed in-memory storage instead of device/cloud data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
function source(name) {
    const start = html.search(new RegExp('        (?:async )?function ' + name + '\\('));
    assert.notEqual(start, -1, name);
    const lineEnd = html.indexOf('\n', start);
    return html.slice(start, html.slice(start, lineEnd).trimEnd().endsWith('}')
        ? lineEnd : html.indexOf('\n        }', lineEnd) + 10);
}
const copy = value => JSON.parse(JSON.stringify(value));
const noop = () => {};
const stroke = id => ({ id, tool: 'pen', w: 2, paths: [[[1, 1], [2, 2]]] });
const content = id => ({ strokes: [stroke(id)], texts: [], media: [] });
const functions = ['nbWithPageStoreLock', 'nbPageFingerprint', 'syncTimestamp', 'nbData',
    'nbGetNotebook', 'nbCurrentNotebook', 'nbCurrentPage', 'nbTouch', 'nbEmptyContent', 'nbStoreNewPage',
    'nbLoadPageContent', 'nbSerializePageContent', 'nbScheduleSave', 'nbSavePageNow', 'nbLoadPage',
    'nbFinishPageInput', 'nbCancelDrawing', 'nbPointerDown', 'nbPointerUp',
    'mergeNotebookTombstones', 'mergeNotebooksData', 'nbCommitDeletion', 'nbDeletePageAt',
    'nbNextPage', 'importBackupAsset'];

function setup() {
    const files = new Map([['nbpage_p1', JSON.stringify(content('old'))],
        ['nbpage_p2', JSON.stringify(content('other'))]]);
    const events = [], hooks = { read: noop, write: noop };
    let metadataSaved = true;
    let nextId = 0;
    const context = vm.createContext({
        appData: { settings: {}, notebooks: { items: [{ id: 'n', pages: [{ id: 'p1' }, { id: 'p2' }] }], reviews: [] } },
        nbState: { notebookId: 'n', pageId: 'p1', pageIndex: 0, content: content('old'),
            dirty: false, switching: false, drawing: null, undoStack: [], redoStack: [] },
        nbSnippetCache: {}, nbThumbCache: {}, console: { error: noop }, i18n: key => key,
        document: { querySelector: () => null, getElementById: () => ({ style: {} }) },
        confirm: () => true,
        setTimeout: () => 1, clearTimeout: noop,
        getFileData: async key => { const value = files.get(key); await hooks.read(key); return value; },
        saveFilePairAtomic: async (key, value, baseKey, base) => {
            await hooks.write(key);
            files.set(key, value); files.set(baseKey, base); events.push(['write', key]);
        },
        saveData: () => metadataSaved,
        nbUid: () => 'new-' + (++nextId),
        saveFileData: async (key, value) => { files.set(key, value); },
        deleteFileData: async key => { files.delete(key); events.push(['delete', key]); },
        nbSyncNotebookEvent: (...args) => events.push(['sync', ...args]),
        nbPreserveNotebookConflict: async () => { throw new Error('Unexpected conflict in this scenario'); },
        sha256Hex: async value => crypto.createHash('sha256').update(value).digest('hex'),
        nbRememberOpenedPage: () => false, nbSchedulePositionSync: noop,
        nbClearSelection: noop, nbHideTextToolbar: noop, nbUpdatePageNo: noop,
        nbUpdateReviewBtn: noop, nbLayout: noop, nbRenderTexts: noop,
        nbNativeRefresh: noop, nbRedraw: noop, nbDrawOverlay: noop, showToast: noop,
        nbPushOp: noop, nbPositionSelToolbar: noop, nbPositionTextToolbar: noop,
        nbRefreshOutline: noop,
    });
    vm.runInContext('const _nbPageStoreLocks = new Map(); let _nbPageLoadToken = 0, _nbSaveTimer = null;\n' +
        'let _nbActivePointerId = 1, _nbActivePointerIsPen = true, _nbTouchGesture = null;\n' +
        functions.map(source).join('\n'), context);
    function blockOnce(type, key) {
        let release, entered;
        const waiting = new Promise(resolve => { release = resolve; });
        const reached = new Promise(resolve => { entered = resolve; });
        hooks[type] = async actual => {
            if (actual !== key) return;
            hooks[type] = noop; entered(); await waiting;
        };
        return { reached, release };
    }
    return { context, files, hooks, events, blockOnce, failMetadata: () => { metadataSaved = false; },
        read: id => JSON.parse(files.get('nbpage_' + id)) };
}

async function main() {
    // Creating a page writes a blank body and baseline before its index can be published.
    {
        const e = setup(), old = e.files.get('nbpage_p1');
        assert.equal(await e.context.nbStoreNewPage({ id: 'new', updatedAt: '2026-01-01T00:00:00Z' }), true);
        assert.deepEqual(e.read('new').strokes, []);
        assert.equal(e.files.get('nbpagebase_new'), '');
        assert.equal(await e.context.nbStoreNewPage({ id: 'p1' }), false);
        assert.equal(e.files.get('nbpage_p1'), old, 'an ID collision must not overwrite an existing page');
        e.hooks.write = async () => { throw new Error('storage unavailable'); };
        assert.equal(await e.context.nbStoreNewPage({ id: 'failed' }), false);
        assert.equal(e.files.has('nbpage_failed'), false);
    }

    // Opening compares the cloud body even with an existing local body and a newer local timestamp.
    {
        const e = setup(), requested = [];
        e.context.appData.settings.r2Config = { accessKeyId: 'memory-only' };
        e.files.set('nbpage_p2', JSON.stringify({ ...content('other'), updatedAt: '2099-01-01T00:00:00Z' }));
        e.context.appData.notebooks.items[0].pages[1].updatedAt = '2000-01-01T00:00:00Z';
        e.context.r2GetObjectWithTimeout = async (...args) => { requested.push(args); return JSON.stringify(content('cloud')); };
        e.context.nbAcceptCloudPage = async (_id, raw) => ({ content: raw, base: 'cloud-base' });
        const loaded = await e.context.nbLoadPageContent('p2');
        assert.deepEqual(requested, [['notebooks/pages/nbpage_p2', 5000]]);
        assert.equal(loaded.strokes[0].id, 'cloud');
        assert.equal(loaded._cloudBase, 'cloud-base');
        e.context.r2GetObjectWithTimeout = async () => { throw new Error('offline'); };
        assert.equal((await e.context.nbLoadPageContent('p2')).strokes[0].id, 'other');
    }

    // The real add-page entry cannot publish an index without the newly created page body.
    for (const fails of [false, true]) {
        const e = setup();
        e.context.appData.notebooks.items[0].pages.pop();
        const installed = new Promise(resolve => { e.context.nbRenderTexts = resolve; });
        if (fails) e.hooks.write = async () => { throw new Error('storage unavailable'); };
        await e.context.nbNextPage();
        if (fails) {
            assert.equal(e.context.appData.notebooks.items[0].pages.length, 1);
            assert.equal(e.events.some(event => event[0] === 'sync'), false);
        } else {
            await installed;
            const id = e.context.nbState.pageId;
            assert.deepEqual(e.read(id).strokes, []);
            assert.equal(e.files.get('nbpagebase_' + id), '');
            assert.ok(e.events.findIndex(event => event[0] === 'write' && event[1] === 'nbpage_' + id) <
                e.events.findIndex(event => event[0] === 'sync' && event[1] === 'notebook_page_add'));
        }
    }

    // An imported page cannot inherit either the device's current base or a baseline from the ZIP.
    {
        const e = setup();
        e.files.set('nbpagebase_p1', 'device-base');
        await e.context.importBackupAsset('nbpage_p1', content('imported'));
        await e.context.importBackupAsset('nbpagebase_p1', 'backup-base');
        assert.equal(e.files.get('nbpagebase_p1'), '');
        assert.deepEqual(e.read('p1'), content('imported'));
        await assert.rejects(e.context.importBackupAsset('nbpage_p1', '{broken'));
        assert.deepEqual(e.read('p1'), content('imported'), 'failed import keeps the existing body');
    }

    // Missing/corrupt bodies must fail closed; they cannot become editable blank replacement pages.
    for (const raw of [undefined, '{broken', '[]', 'null']) {
        const e = setup(), current = e.context.nbState.content;
        if (raw === undefined) e.files.delete('nbpage_p2'); else e.files.set('nbpage_p2', raw);
        await assert.rejects(e.context.nbLoadPageContent('p2'), /content_load_failed/);
        assert.equal(await e.context.nbLoadPage(1), false);
        assert.equal(e.context.nbState.content, current);
        assert.equal(e.context.nbState.pageId, 'p1');
        assert.equal(e.files.get('nbpage_p2'), raw);
        assert.equal(e.context.nbState.switching, false);
    }

    // Pending older ink must save without a later gesture's uncommitted erase/translation/resize.
    for (const mode of ['erase', 'move', 'boxdrag', 'object']) {
        const e = setup(), c = e.context.nbState.content;
        const old = copy(c.strokes[0]);
        c.strokes.push(stroke('pending'));
        c.texts = [{ id: 'text', x: 5, y: 6, w: 100, fontSize: 20 }];
        e.context.nbState.dirty = true;
        if (mode === 'erase') {
            c.strokes.splice(0, 1);
            e.context.nbState.drawing = { mode, removed: [{ s: old, i: 0 }] };
        } else if (mode === 'move') {
            c.strokes[0].paths[0][0][0] = 80;
            e.context.nbState.drawing = { mode, before: [old] };
        } else {
            const box = c.texts[0], before = copy(box);
            Object.assign(box, { x: 80, y: 90, w: 300, fontSize: 60 });
            e.context.nbState.drawing = { mode, obj: box, before };
        }
        const liveBefore = JSON.stringify(c);
        assert.equal(await e.context.nbSavePageNow(), true, mode);
        const saved = e.read('p1');
        assert.deepEqual(saved.strokes.map(s => s.id), ['old', 'pending'], mode);
        assert.deepEqual(saved.strokes[0], old, mode);
        assert.deepEqual(saved.texts[0], { id: 'text', x: 5, y: 6, w: 100, fontSize: 20 });
        const withoutTimestamp = copy(c); delete withoutTimestamp.updatedAt;
        assert.equal(JSON.stringify(withoutTimestamp), liveBefore, 'saving must not mutate the live gesture');
    }

    // A second save and a page switch wait behind a delayed first write; the latest ink wins.
    {
        const e = setup(), c = e.context.nbState.content;
        c.strokes.push(stroke('first')); e.context.nbScheduleSave();
        const gate = e.blockOnce('write', 'nbpage_p1');
        const first = e.context.nbSavePageNow(); await gate.reached;
        c.strokes.push(stroke('second')); e.context.nbScheduleSave();
        const second = e.context.nbSavePageNow();
        const switched = e.context.nbLoadPage(1);
        assert.equal(e.context.nbState.pageId, 'p1');
        assert.equal(e.context.nbState.switching, true);
        e.context.nbPointerDown({ button: 0, pointerId: 2 });
        assert.equal(e.context.nbState.drawing, null, 'new input is blocked during switching');
        gate.release();
        assert.deepEqual(await Promise.all([first, second, switched]), [true, true, true]);
        assert.deepEqual(e.read('p1').strokes.map(s => s.id), ['old', 'first', 'second']);
        assert.equal(e.context.nbState.pageId, 'p2');
        assert.equal(e.context.nbState.switching, false);
    }

    // Both body-storage and metadata failure retain dirty content and abort the page installation.
    for (const failure of ['body', 'metadata']) {
        const e = setup(), current = e.context.nbState.content;
        current.strokes.push(stroke('unsaved')); e.context.nbScheduleSave();
        if (failure === 'body') e.hooks.write = async () => { throw new Error('storage unavailable'); };
        else e.failMetadata();
        assert.equal(await e.context.nbLoadPage(1), false, failure);
        assert.equal(e.context.nbState.content, current);
        assert.equal(e.context.nbState.dirty, true);
        assert.equal(e.context.nbState.pageId, 'p1');
        assert.equal(e.context.nbState.switching, false);
    }

    // After a cloud helper rebinds to a durable conflict copy, the old-page save must not rewrite it.
    {
        const e = setup(), current = e.context.nbState.content;
        current._cloudBase = 'old-base'; e.files.set('nbpagebase_p1', 'new-base');
        current.strokes.push(stroke('first')); e.context.nbScheduleSave();
        e.context.nbPreserveNotebookConflict = async (_pageId, raw) => {
            e.files.set('nbpage_copy', raw); e.files.set('nbpagebase_copy', '');
            e.context.appData.notebooks.items[0].pages.push({ id: 'copy' });
            e.context.nbState.pageId = 'copy'; current._cloudBase = '';
            current.strokes.push(stroke('after-rebind')); e.context.nbScheduleSave();
            assert.equal(await e.context.nbSavePageNow(), true);
            return 'copy';
        };
        assert.equal(await e.context.nbSavePageNow(), true);
        assert.deepEqual(e.read('copy').strokes.map(s => s.id), ['old', 'first', 'after-rebind']);
        assert.deepEqual(e.read('p1'), content('old'));
    }

    // A same-page reload must keep the live object if another edit arrives while its old snapshot is read.
    {
        const e = setup(), current = e.context.nbState.content;
        const gate = e.blockOnce('read', 'nbpage_p1');
        const loading = e.context.nbLoadPage(0); await gate.reached;
        current.strokes.push(stroke('arrived-during-read')); e.context.nbScheduleSave();
        gate.release();
        assert.equal(await loading, true);
        assert.equal(e.context.nbState.content, current);
        assert.equal(e.read('p1').strokes.length, 2);
    }

    // Reordering the metadata cannot change the page to which the active content is saved.
    {
        const e = setup();
        e.context.appData.notebooks.items[0].pages.reverse();
        e.context.nbState.content.strokes.push(stroke('after-reorder')); e.context.nbScheduleSave();
        assert.equal(await e.context.nbSavePageNow(), true);
        assert.equal(e.context.nbState.pageIndex, 1);
        assert.equal(e.read('p1').strokes.length, 2);
        assert.deepEqual(e.read('p2'), content('other'));
    }

    // A target deleted during its read is never installed over the current page.
    {
        const e = setup(), current = e.context.nbState.content;
        const gate = e.blockOnce('read', 'nbpage_p2');
        const loading = e.context.nbLoadPage(1); await gate.reached;
        e.context.appData.notebooks.items[0].pages.pop();
        gate.release();
        assert.equal(await loading, false);
        assert.equal(e.context.nbState.pageId, 'p1');
        assert.equal(e.context.nbState.content, current);
    }

    // A delete menu's page ID stays correct after reorder; deleting another page must preserve active ink.
    {
        const e = setup(), current = e.context.nbState.content;
        e.context.appData.notebooks.items[0].pages = [{ id: 'p2' }, { id: 'p3' }, { id: 'p1' }];
        e.files.set('nbpage_p3', JSON.stringify(content('third')));
        e.context.nbState.pageIndex = 1; // stale before metadata reorder; active page ID is still p1
        current.strokes.push(stroke('before-delete')); e.context.nbScheduleSave();
        await e.context.nbDeletePageAt('p3');
        assert.equal(e.context.nbState.pageId, 'p1');
        assert.equal(e.context.nbState.content, current);
        assert.equal(e.read('p1').strokes.length, 2);
        assert.equal(e.files.has('nbpage_p3'), false);
        assert.equal(e.context.appData.notebooks.tombstones[0].id, 'p3');
    }

    // Finish the old page's in-flight ink before leaving; cancel a DOM object's preview instead.
    for (const mode of ['stroke', 'object']) {
        const e = setup(), current = e.context.nbState.content;
        if (mode === 'stroke') e.context.nbState.drawing = { mode, stroke: stroke('in-flight') };
        else {
            const box = { id: 'text', x: 80, y: 90 }; current.texts.push(box);
            e.context.nbState.drawing = { mode, obj: box, before: { x: 5, y: 6 },
                cancel: () => Object.assign(box, { x: 5, y: 6 }) };
            // A previous committed edit is waiting to save while this object is being dragged.
            e.context.nbScheduleSave();
        }
        assert.equal(await e.context.nbLoadPage(1), true, mode);
        assert.equal(e.context.nbState.drawing, null);
        if (mode === 'stroke') assert.deepEqual(e.read('p1').strokes.map(s => s.id), ['old', 'in-flight']);
        else assert.deepEqual(e.read('p1').texts[0], { id: 'text', x: 5, y: 6 });
        assert.deepEqual(e.read('p2'), content('other'));
    }
    console.log('Notebook save/load race regression checks passed.');
}
const timeout = setTimeout(() => { console.error('Notebook save/load check did not settle'); process.exitCode = 1; }, 5000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(timeout));
