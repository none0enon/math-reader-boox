const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adapter = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/boox-pen.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');

function harness(failure) {
    const state = { chunks: [], aborted: [], reads: [], toasts: [], finished: false };
    class Anchor { click() {} }
    const context = {
        navigator: {}, console: { log() {}, warn() {}, error() {} },
        HTMLAnchorElement: Anchor, document: { addEventListener() {} },
        Blob, ArrayBuffer, Uint8Array, TextEncoder, setTimeout,
        FileReader: class {
            readAsDataURL(blob) {
                state.reads.push(blob.size);
                Promise.resolve(state.gate).then(async () => {
                    if (failure === 'read') { this.error = new Error('read failed'); this.onerror(); return; }
                    if (failure === 'abort') { this.onabort(); return; }
                    this.result = 'data:application/octet-stream;base64,' +
                        Buffer.from(await blob.arrayBuffer()).toString('base64');
                    this.onload();
                });
            }
        },
        BooxDownloadNative: {
            beginSave(name, mime, size) {
                state.name = name; state.size = size;
                return JSON.stringify(failure === 'begin' ? { error: 'busy' } : { id: 'test' });
            },
            appendBase64(id, data) {
                assert.equal(id, 'test');
                assert.ok(data.length <= 350000);
                if (failure === 'write' && state.chunks.length) return 'disk full';
                state.chunks.push(Buffer.from(data, 'base64'));
                return '';
            },
            finishSave(id) {
                assert.equal(id, 'test');
                assert.equal(Buffer.concat(state.chunks).length, state.size);
                if (failure === 'finish') return JSON.stringify({ error: 'close failed' });
                state.finished = true;
                return JSON.stringify({ location: 'Downloads/' + state.name });
            },
            abortSave(id) { state.aborted.push(id); }
        },
        showToast(message) { state.toasts.push(message); },
        i18n: key => key,
        classroomRecordingState: null,
        appData: { books: [], papers: [], archived: [], classroom: {}, exercises: {} },
        backupAppDataToIDB() {},
        stripLectureContent: x => x, stripClassroomData: x => x, stripExercisesData: x => x,
        cleanDocForSync: x => x,
        listFileKeys: async () => [],
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(adapter, context);
    vm.runInContext(page.slice(page.indexOf('        function dataZipCrc32('),
        page.indexOf('        function dataZipReadU16(')), context);
    vm.runInContext(page.slice(page.indexOf('        async function exportData()'),
        page.indexOf('        async function importDataZip(')), context);
    return { context, state };
}

(async () => {
    const data = Buffer.alloc(4 * 1024 * 1024 + 13);
    for (let i = 0; i < data.length; i++) data[i] = i % 251;
    const blob = new Blob([data], { type: 'application/zip' });
    const { context, state } = harness();
    assert.equal(await context.__booxDownloadBlob(blob, '备份.zip'), 'Downloads/备份.zip');
    assert.deepEqual(Buffer.concat(state.chunks), data, 'all bytes must arrive in order');
    assert.ok(state.reads.length > 1);
    assert.ok(state.reads.every(size => size <= 256 * 1024), 'never read the full backup into JS');
    assert.equal(state.finished, true);
    assert.deepEqual(state.aborted, []);
    const empty = harness();
    await empty.context.__booxDownloadBlob(new Blob([]), 'empty.bin');
    assert.equal(empty.state.finished, true);
    assert.equal(empty.state.reads.length, 0);

    for (const failure of ['begin', 'write', 'read', 'abort', 'finish']) {
        const h = harness(failure);
        await assert.rejects(h.context.__booxDownloadBlob(blob, 'failed.zip'));
        assert.equal(h.state.finished, false, failure);
        assert.deepEqual(h.state.aborted, failure === 'begin' ? [] : ['test'], failure);
    }

    const exporting = harness();
    let release;
    exporting.state.gate = new Promise(resolve => { release = resolve; });
    const pending = exporting.context.exportData();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(!exporting.state.toasts.some(x => x.includes('toast_export_success')),
        'export must wait for the native write before reporting success');
    release();
    await pending;
    assert.equal(exporting.state.finished, true);
    assert.ok(exporting.state.toasts.at(-1).includes('Downloads/'));
    const failed = harness('finish');
    await failed.context.exportData();
    assert.ok(failed.state.toasts.at(-1).includes('export_failed'));
    assert.ok(!failed.state.toasts.some(x => x.includes('toast_export_success')));
    console.log('BOOX bounded download, failure cleanup and completion checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
