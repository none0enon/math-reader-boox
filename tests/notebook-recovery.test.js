// Run with: node tests/notebook-recovery.test.js
// Lifecycle recovery uses real application functions and isolated memory stores.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
function source(name) {
    const start = html.search(new RegExp('        (?:async )?function ' + name + '\\('));
    assert.notEqual(start, -1, name);
    const end = html.indexOf('\n', start);
    return html.slice(start, html.slice(start, end).trimEnd().endsWith('}')
        ? end : html.indexOf('\n        }', end) + 10);
}
const key = 'mathReaderNotebookRecovery_p';
const content = id => ({ strokes: [{ id }], texts: [], media: [] });
const raw = id => JSON.stringify(content(id));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const noop = () => {};
function setup() {
    const local = new Map(), files = new Map(), conflicts = [], toasts = [];
    let finish;
    const context = vm.createContext({
        appData: { notebooks: { items: [{ id: 'n', pages: [{ id: 'p' }] }], tombstones: [] } },
        nbState: { notebookId: 'n', pageId: 'p', content: content('new'), dirty: true, drawing: null },
        localStorage: {
            get length() { return local.size; }, key: i => [...local.keys()][i],
            getItem: k => local.get(k) ?? null, setItem: (k, v) => local.set(k, v),
            removeItem: k => local.delete(k),
        },
        getFileData: async k => files.get(k),
        saveFilePairAtomic: async (k, v, b, bv) => { files.set(k, v); files.set(b, bv); },
        nbPreserveNotebookConflict: async (id, value, base, rebind) => {
            conflicts.push({ id, value, base, rebind }); files.set('nbpage_copy', value);
        },
        nbCurrentPage: () => ({ id: 'p' }),
        nbCancelDrawing: () => {
            const d = context.nbState.drawing;
            Object.assign(d.obj, d.before); context.nbState.drawing = null;
        },
        nbPointerUp: event => {
            assert.equal(event.pointerId, 1);
            context.nbState.content.strokes.push(context.nbState.drawing.stroke);
            context.nbState.drawing = null; context.nbState.dirty = true;
        },
        nbGetNotebook: id => context.appData.notebooks.items.find(n => n.id === id),
        nbSavePageNow: () => new Promise(resolve => { finish = resolve; }),
        sha256Hex: async value => hash(value),
        showToast: value => toasts.push(value), console: { error: noop },
    });
    vm.runInContext("const NB_PAGE_RECOVERY_PREFIX = 'mathReaderNotebookRecovery_'; const _nbPageStoreLocks = new Map();\n" +
        'let _nbActivePointerId = 1, _nbTouchGesture = null;\n' +
        ['nbWithPageStoreLock', 'nbPageFingerprint', 'nbSerializePageContent', 'nbFinishPageInput',
            'nbSavePageOnLeave', 'nbRecoverPageOnLeave'].map(source).join('\n'), context);
    return { context, local, files, conflicts, toasts, finish: value => finish(value) };
}
async function main() {
    // The recovery copy exists synchronously, even when the database save has not finished.
    const pending = setup();
    pending.context.nbState.content.texts.push({ id: 't', x: 99 });
    pending.context.nbState.drawing = { mode: 'object', obj: pending.context.nbState.content.texts[0], before: { x: 10 } };
    const leave = pending.context.nbSavePageOnLeave();
    assert.equal(JSON.parse(JSON.parse(pending.local.get(key)).content).texts[0].x, 10,
        'cancelable object previews must not enter the recovery record');
    pending.context.nbState.dirty = false;
    pending.finish(true);
    await leave;
    assert.equal(pending.local.has(key), false, 'a completed save clears its matching record');

    // Leaving during the first visible stroke must finish it before testing dirty/capturing bytes.
    const drawing = setup();
    drawing.context.nbState.dirty = false;
    drawing.context.nbState.drawing = { mode: 'stroke', stroke: { id: 'still-down' } };
    const interrupted = drawing.context.nbSavePageOnLeave();
    assert.equal(JSON.parse(JSON.parse(drawing.local.get(key)).content).strokes.at(-1).id, 'still-down');
    drawing.finish(false); await interrupted;
    assert.equal(drawing.local.has(key), true);

    // dirty is cleared at the start of a save: an in-flight page lock still needs recovery.
    const running = setup();
    running.context.nbState.dirty = false;
    vm.runInContext("_nbPageStoreLocks.set('p', Promise.resolve())", running.context);
    const flight = running.context.nbSavePageOnLeave();
    assert.equal(running.local.has(key), true);
    const storedRecord = running.local.get(key);
    running.local.set(key, storedRecord + ' ');
    running.finish(true);
    await flight;
    assert.equal(running.local.get(key), storedRecord + ' ', 'a later record must not be removed');

    // Reload replays the committed snapshot over its unchanged base before any cloud work.
    const recovered = setup();
    const base = await recovered.context.nbPageFingerprint(raw('base'));
    const record = JSON.stringify({ notebookId: 'n', pageId: 'p', base, content: raw('new') });
    recovered.local.set(key, record); recovered.files.set('nbpage_p', raw('base'));
    await recovered.context.nbRecoverPageOnLeave();
    assert.equal(recovered.files.get('nbpage_p'), raw('new'));
    assert.equal(recovered.files.get('nbpagebase_p'), base);
    assert.equal(recovered.local.has(key), false);

    // A divergent on-disk version remains intact; the recovery copy stays separately accessible.
    const conflict = setup();
    conflict.local.set(key, record); conflict.files.set('nbpage_p', raw('other'));
    await conflict.context.nbRecoverPageOnLeave();
    assert.equal(conflict.files.get('nbpage_p'), raw('other'));
    assert.equal(conflict.files.get('nbpage_copy'), raw('new'));
    assert.equal(conflict.conflicts[0].rebind, false);

    // Failed writes and explicit deletions retain the recovery bytes without resurrecting a page.
    const failure = setup();
    failure.local.set(key, record);
    failure.context.saveFilePairAtomic = async () => { throw new Error('quota'); };
    await failure.context.nbRecoverPageOnLeave();
    assert.equal(failure.local.get(key), record);
    assert.equal(failure.toasts.length, 1);
    failure.context.appData.notebooks.tombstones.push({ kind: 'page', id: 'p' });
    await failure.context.nbRecoverPageOnLeave();
    assert.equal(failure.files.size, 0);
    assert.equal(failure.local.get(key), record);

    // Storage quota and corrupt entries must not block startup or discard the current dirty page.
    const quota = setup();
    quota.context.localStorage.setItem = () => { throw new Error('quota'); };
    const unsaved = quota.context.nbSavePageOnLeave();
    assert.equal(quota.context.nbState.dirty, true);
    assert.equal(quota.toasts.length, 1);
    quota.finish(false); await unsaved;
    quota.local.set(key, 'broken');
    await quota.context.nbRecoverPageOnLeave();
    assert.equal(quota.local.get(key), 'broken');
    assert.ok(html.indexOf('await nbRecoverPageOnLeave();') < html.indexOf('await recoverDurableClassroomEntries();'));
    assert.ok(html.includes("window.addEventListener('pagehide', () => { nbSaveQuizDraftToReview(true); nbSavePageOnLeave(); });"));
    console.log('notebook lifecycle recovery checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
