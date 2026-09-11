const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
for (const file of ['app/src/main/assets/www/index.html', 'docs/index.html']) {
    const page = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const start = page.indexOf('                appData = {', page.indexOf('async function importDataZip('));
    const end = page.indexOf('\n                };', start) + '\n                };'.length;
    const imported = {
        lectureDrafts: { chapter: { html: 'draft', canvas: 'data:image/png;base64,AA==' } },
        lectureDrawings: { chapter: 'data:image/png;base64,AA==' },
        lectureStrokesData: { chapter: [{ points: [{ x: 4, y: 8 }] }] }
    };
    const ctx = vm.createContext({ imported, oldSettings: {}, pickApiSettingsFrom: () => ({}),
        mergeClassroomTombstones: value => value || [] });
    vm.runInContext(page.slice(start, end), ctx);
    for (const key of Object.keys(imported)) assert.equal(ctx.appData[key], imported[key], key);
    ctx.imported = {};
    vm.runInContext(page.slice(start, end), ctx);
    for (const key of Object.keys(imported)) assert.equal(JSON.stringify(ctx.appData[key]), '{}', key);
}
console.log('PWA ZIP import: lecture drafts, drawings, strokes and legacy defaults passed');
