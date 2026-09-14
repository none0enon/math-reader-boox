// Run: node tests/exercise-page-render.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['docs/index.html', 'app/src/main/assets/www/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const source = name => {
        const start = html.indexOf('        function ' + name + '(');
        assert.ok(start >= 0, file + ': ' + name);
        return html.slice(start, html.indexOf('\n        }', start) + 10);
    };
    const noop = () => {};
    const wrap = { clientWidth: 1200, clientHeight: 420, scrollTop: 0, scrollLeft: 0 };
    function canvas() {
        const result = { width: 2400, height: 840, style: {}, parentElement: wrap };
        const ctx = {
            save: noop, restore: noop, scale: noop, setTransform: noop,
            clearRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop,
            drawImage: noop,
        };
        result.getContext = () => ctx;
        result.toDataURL = () => JSON.stringify({ width: result.width, height: result.height });
        return result;
    }
    const main = canvas(), overlay = canvas();
    const context = vm.createContext({
        document: { getElementById: id => id === 'exerciseDoingCanvas' ? main : overlay,
            createElement: canvas },
        window: { matchMedia: () => ({ matches: true }) },
        exCanvasCtx: main.getContext(), exStrokes: [], exBaseImage: null, exPages: [], exPageIndex: 0,
        exDrawing: false, exEraserMode: false, exLassoMode: false,
        exOpHistory: [], exRedoStack: [], exDirtyLocal: false, exDirtyCloud: false,
        exDrawOverlay: noop, updateExPageNav: noop,
    });
    vm.runInContext(['exComputeBBox', 'exDrawStrokePath', 'exRedrawCanvas', 'exPageImageSize',
        'exRenderPageToDataURL', 'exCollectPageImages', 'exStoreCurrentPage', 'exLoadPage',
        'exApplyRestoredPage', 'exSizeOverlay'].map(source).join('\n')
        + '\nfunction exOverlayCanvas() { return document.getElementById("exerciseDoingOverlay"); }', context);
    const stroke = (x, y, width = 2) => ({ color: '#000', width, points: [[20, 20], [x, y]] });
    const page = (strokes = [], baseImage = null) => ({ strokes, baseImage,
        opHistory: [], redoStack: [], dirtyLocal: false, dirtyCloud: false });

    // Restore a BOOX portrait page into a short desktop viewport.
    context.exPages = [page(), page(), page()];
    context.exApplyRestoredPage(0, [stroke(700, 1100)], null);
    assert.equal(main.height, 2204, file + ': bottom of active portrait page is rendered');
    assert.equal(main.style.height, '1102px');
    assert.equal(overlay.height, main.height, 'lasso overlay follows the full page');
    assert.equal(overlay.style.height, main.style.height);
    assert.equal(context.exCanvasCtx.lineCap, 'round', 'resizing restores the pen context');

    // A later, unvisited page can be taller and wider than the active page.
    context.exApplyRestoredPage(1, [stroke(1450, 1600, 10)], null);
    context.exApplyRestoredPage(2, null, { naturalWidth: 1800, naturalHeight: 3000 });
    wrap.scrollTop = 500;
    const images = Array.from(context.exCollectPageImages(), JSON.parse);
    assert.deepEqual(images, [
        { width: 2400, height: 2204 },
        { width: 2912, height: 3212 },
        { width: 2400, height: 3000 },
    ], file + ': grading gets every complete page before visiting later pages');
    assert.equal(wrap.scrollTop, 500, 'collecting grading images does not move the viewport');

    context.exLoadPage(1);
    context.exRedrawCanvas();
    assert.equal(main.height, 3212);
    assert.equal(main.width, 2912);
    assert.equal(overlay.width, main.width);
    context.exStoreCurrentPage();
    context.exLoadPage(2);
    context.exRedrawCanvas();
    assert.ok(main.height >= 3000, 'legacy PNG remains fully visible');
    assert.deepEqual(Array.from(context.exCollectPageImages(), JSON.parse), images,
        'changing the active page cannot change another page export');

    // Short pages keep the viewport minimum, regardless of the last visible page.
    assert.deepEqual(JSON.parse(context.exRenderPageToDataURL(page())), { width: 2400, height: 840 });
    assert.equal(JSON.parse(context.exRenderPageToDataURL(page([stroke(30, 40)],
        { width: 1600, height: 4000 }))).height, 4000, 'PNG bounds survive additional vector ink');

    // Existing BOOX native canvas sizing is unchanged; export still includes all ink.
    context.window.BooxPenNative = {};
    main.width = 2400; main.height = 840;
    context.exStrokes = [stroke(700, 1100)];
    context.exBaseImage = null;
    context.exRedrawCanvas();
    assert.equal(main.height, 840, 'do not resize native BOOX writing surface');
    context.exStoreCurrentPage();
    assert.equal(JSON.parse(context.exCollectPageImages()[2]).height, 2204);
    delete context.window.BooxPenNative;
    context.window.matchMedia = () => ({ matches: false });
    context.exRedrawCanvas();
    assert.equal(main.height, 840, 'touch-only devices keep existing writing surface sizing');

    assert.match(html, /@media \(hover: hover\) and \(pointer: fine\)\s*\{\s*#exerciseDoingView \.exercise-doing-canvas-wrap \{ overflow: auto; \}/,
        'mouse scrolling is scoped to the desktop exercise view');
}
console.log('Exercise page rendering checks passed (web and Android).');
