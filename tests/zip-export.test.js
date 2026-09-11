const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

function zipFunctions(file) {
    const page = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = page.indexOf('        function dataZipCrc32(bytes)');
    const end = page.indexOf('        function dataZipReadU16', start);
    assert.ok(start >= 0 && end > start, 'ZIP functions must exist');
    return page.slice(start, end);
}

const source = zipFunctions('app/src/main/assets/www/index.html');
assert.equal(zipFunctions('docs/index.html'), source, 'APK and web ZIP writers must match');
const context = vm.createContext({ Blob, Uint8Array, ArrayBuffer, TextEncoder, i18n: key => key });
vm.runInContext(source, context);

(async () => {
    const files = [
        { name: 'metadata.json', data: '{"books":[]}' },
        { name: '课堂/笔记.txt', data: '数学 · 中文' },
        { name: 'binary.bin', data: new Blob([Uint8Array.of(0, 255, 128, 42)]) },
        { name: 'bytes.bin', data: Uint8Array.of(1, 2, 3) },
        { name: 'empty.txt', data: '' }
    ];
    const expected = await Promise.all(files.map(async file => [file.name,
        Buffer.from(await new Blob([file.data]).arrayBuffer()).toString('hex')]));
    const zip = await context.dataZipCreate(files);
    const result = spawnSync('python3', ['-c', `
import io, json, sys, zipfile
expected = json.loads(sys.argv[1])
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    assert archive.namelist() == [name for name, _ in expected]
    assert archive.testzip() is None
    for name, hex_data in expected:
        assert archive.read(name) == bytes.fromhex(hex_data), name
`, JSON.stringify(expected)], { input: Buffer.from(await zip.arrayBuffer()) });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr.toString());

    await assert.rejects(context.dataZipCreate(new Array(0x10000)), /backup_file_too_large/);
    await assert.rejects(context.dataZipCreate([
        { name: '界'.repeat(21846), data: '' }
    ]), /backup_file_too_large/, 'filename limit must count UTF-8 bytes');

    // Virtual sizes exercise ZIP32 overflow without allocating multi-gigabyte data.
    class SizedBlob extends Blob {
        constructor(size) { super([]); this.virtualSize = size; }
        get size() { return this.virtualSize; }
    }
    context.dataZipCrc32Blob = async () => 0;
    for (const entries of [
        [{ name: 'a', data: new SizedBlob(0x100000000) }],
        [{ name: 'a', data: new SizedBlob(0xffffffff - 32) }, { name: 'b', data: '' }],
        [{ name: 'a', data: new SizedBlob(0xffffffff - 31) }]
    ]) {
        await assert.rejects(context.dataZipCreate(entries), /backup_file_too_large/);
    }
    console.log('ZIP export: standard ZIP roundtrip and ZIP32 limits passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
