const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const docsHtml = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');
const appHtml = fs.readFileSync(
    path.join(root, 'app/src/main/assets/www/index.html'), 'utf8');

function crc32(bytes) {
    if (!crc32.table) {
        crc32.table = Array.from({ length: 256 }, (_, n) => {
            let value = n;
            for (let bit = 0; bit < 8; bit++) {
                value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
            }
            return value >>> 0;
        });
    }
    let value = -1;
    for (const byte of bytes) value = (value >>> 8) ^ crc32.table[(value ^ byte) & 0xff];
    return (value ^ -1) >>> 0;
}

function makeZip(files, { deflate = false, descriptor = false, damageCentral = false } = {}) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const [name, text] of Object.entries(files)) {
        const nameBytes = Buffer.from(name);
        const data = Buffer.from(text);
        const packed = deflate ? zlib.deflateRawSync(data) : data;
        const checksum = crc32(data);
        const flags = 0x0800 | (descriptor ? 0x08 : 0);
        const method = deflate ? 8 : 0;
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(flags, 6);
        local.writeUInt16LE(method, 8);
        if (!descriptor) {
            local.writeUInt32LE(checksum, 14);
            local.writeUInt32LE(packed.length, 18);
            local.writeUInt32LE(data.length, 22);
        }
        local.writeUInt16LE(nameBytes.length, 26);
        localParts.push(local, nameBytes, packed);

        let trailingLength = 0;
        if (descriptor) {
            const trailing = Buffer.alloc(16);
            trailing.writeUInt32LE(0x08074b50, 0);
            trailing.writeUInt32LE(checksum, 4);
            trailing.writeUInt32LE(packed.length, 8);
            trailing.writeUInt32LE(data.length, 12);
            localParts.push(trailing);
            trailingLength = trailing.length;
        }

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(flags, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(localOffset, 42);
        centralParts.push(central, nameBytes);
        localOffset += local.length + nameBytes.length + packed.length + trailingLength;
    }

    const centralOffset = localOffset;
    const centralDirectory = Buffer.concat(centralParts);
    if (damageCentral && centralDirectory.length) centralDirectory[0] = 0;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(Object.keys(files).length, 8);
    eocd.writeUInt16LE(Object.keys(files).length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(centralOffset, 16);
    return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function loadZipReader() {
    const start = docsHtml.indexOf('function dataZipReadU16');
    const end = docsHtml.indexOf('async function _readRecordingExportCandidate', start);
    assert.ok(start >= 0 && end > start, 'ZIP reader source block exists');
    const context = {
        Blob,
        DataView,
        DecompressionStream,
        FileReader: globalThis.FileReader,
        Response,
        TextDecoder,
        Uint8Array,
        console: { warn() {} },
        i18n(key, ...args) { return [key, ...args].join(':'); }
    };
    vm.createContext(context);
    vm.runInContext(
        `${docsHtml.slice(start, end)}\nthis.zipReader = { dataZipRead, dataZipText };`, context);
    return context.zipReader;
}

test('keeps the hosted page and APK asset identical', () => {
    assert.equal(appHtml, docsHtml);
});

test('reads standard deflated ZIP entries that use data descriptors', async () => {
    const reader = loadZipReader();
    const metadata = JSON.stringify({ exportFormat: 'math-reader-full-zip-v2', books: [] });
    const zip = new Blob([makeZip({ 'metadata.json': metadata, 'idb/sample': 'payload' }, {
        deflate: true,
        descriptor: true
    })]);
    const entries = await reader.dataZipRead(zip);
    assert.equal(await reader.dataZipText(entries['metadata.json']), metadata);
    assert.equal(await reader.dataZipText(entries['idb/sample']), 'payload');
});

test('falls back to local headers for legacy damaged central directories', async () => {
    const reader = loadZipReader();
    const metadata = JSON.stringify({ exportFormat: 'math-reader-full-zip-v1' });
    const zip = new Blob([makeZip({ 'metadata.json': metadata }, { damageCentral: true })]);
    const entries = await reader.dataZipRead(zip);
    assert.equal(await reader.dataZipText(entries['metadata.json']), metadata);
});

test('iOS selection guard preserves the thumbnail contextmenu event path', () => {
    const guardStart = docsHtml.indexOf('function nbBlockNotebookNativeSelection');
    const guardEnd = docsHtml.indexOf('function nbClearNotebookNativeSelection', guardStart);
    const guard = docsHtml.slice(guardStart, guardEnd);
    assert.match(guard, /e\.preventDefault\(\)/);
    assert.doesNotMatch(guard, /stop(?:Immediate)?Propagation/);
    assert.match(docsHtml, /thumb\.addEventListener\('contextmenu'/);
    assert.match(docsHtml, /document\.addEventListener\(type, nbBlockNotebookNativeSelection, true\)/);
});

test('Android initializes the Onyx touch listener only for BOOX stylus hardware', () => {
    const java = fs.readFileSync(path.join(root,
        'app/src/main/java/com/mathreader/boox/BooxPenBridge.java'), 'utf8');
    const guard = java.indexOf('if (!hasBooxStylus(activity))');
    const create = java.indexOf('TouchHelper.create(webView, rawInputCallback)');
    assert.ok(guard >= 0 && create > guard);
    assert.match(java, /DeviceFeatureUtil\.hasStylus\(activity\)/);
    assert.match(java, /device\.contains\("onyx"\) \|\| device\.contains\("boox"\)/);
});
