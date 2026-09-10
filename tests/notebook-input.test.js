// Run with: node tests/notebook-input.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
function source(name) {
    const start = html.indexOf('        function ' + name + '(');
    assert.notEqual(start, -1, name + ' exists');
    const lineEnd = html.indexOf('\n', start);
    const end = html.slice(start, lineEnd).trimEnd().endsWith('}')
        ? lineEnd : html.indexOf('\n        }', lineEnd) + 10;
    return html.slice(start, end);
}

const elements = {};
function element(id) {
    return elements[id] ||= {
        id, style: {}, listeners: {}, clientWidth: 1000, clientHeight: 700,
        scrollLeft: 200, scrollTop: 200,
        classList: { contains: () => true },
        addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1414 }),
        setPointerCapture() {}, closest: () => null,
    };
}
const noop = () => {};
const context = vm.createContext({
    window: { devicePixelRatio: 1 },
    document: { getElementById: element, querySelectorAll: () => [] },
    applePencilMode: true, NB_PAGE_W: 1000, NB_PAGE_H: 1414, NB_MM: 4,
    nbState: {
        tool: 'pen', shapeType: 'rect', fitScale: 1, zoom: 1, brushIndex: 0,
        brushes: [{ type: 'pen', color: '#111111', mm: 0.5 }],
        drawing: null, selection: null, content: { strokes: [], texts: [], media: [] },
    },
    nbHidePanel: noop, nbHideOutline: noop, nbHideTextToolbar: noop,
    nbHitBoxAt: () => null, nbUid: () => 'stroke', nbPushOp: noop,
    nbRedraw: noop, nbDrawOverlay: noop, nbDrawBg: noop, nbRenderTexts: noop,
    nbScheduleSave: noop, nbNativeRefresh: noop, nbClearSelection: noop,
    nbFinishLasso: noop, nbEraseAt: noop, nbShapePaths: () => [[0, 0], [10, 10]],
    nbAddTextBox: () => { context.textCreated++; }, textCreated: 0,
    nbCtx: () => ({ save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop }),
    setTimeout: callback => callback(), clearTimeout: noop,
    requestAnimationFrame: callback => callback(), cancelAnimationFrame: noop,
});
const functions = ['booxReaderIsPen', 'nbDisplayScale', 'nbEventPoint', 'nbLayout',
    'nbZoomSet', 'nbInitCanvasEvents', 'nbPointerDown', 'nbPointerMove', 'nbPointerUp'];
vm.runInContext('let _nbActivePointerId = null;\n' + functions.map(source).join('\n'), context);

function pointer(type, id = 1, x = 10, y = 20) {
    return { pointerType: type, pointerId: id, button: 0, clientX: x, clientY: y,
        target: element('nbCanvas'), preventDefault() { this.prevented = true; } };
}

// Every canvas tool obeys the same Pencil-only boundary, including mouse input.
for (const tool of ['pen', 'eraser', 'lasso', 'shape', 'text']) {
    for (const type of ['touch', 'mouse', '']) {
        context.nbState.tool = tool;
        context.nbPointerDown(pointer(type));
        assert.equal(context.nbState.drawing, null, tool + ' rejects ' + type);
        assert.equal(context.nbState.content.strokes.length, 0);
        assert.equal(context.textCreated, 0);
    }
}

// A palm cannot replace, move, or end a Pencil stroke.
context.nbState.tool = 'pen';
context.nbPointerDown(pointer('pen', 1));
const drawing = context.nbState.drawing;
assert.ok(drawing);
context.nbPointerDown(pointer('touch', 2));
context.nbPointerDown(pointer('pen', 4));
context.nbPointerMove(pointer('touch', 2, 80, 90));
context.nbPointerUp(pointer('touch', 2));
assert.equal(context.nbState.drawing, drawing);
assert.equal(drawing.stroke.paths[0].length, 1);
context.nbPointerMove(pointer('pen', 1, 30, 40));
assert.equal(drawing.stroke.paths[0].length, 2);
context.nbPointerUp(pointer('pen', 1));
assert.equal(context.nbState.drawing, null);
assert.equal(context.nbState.content.strokes.length, 1);

// Disabling the preference preserves finger writing.
context.applePencilMode = false;
context.nbPointerDown(pointer('touch', 3));
context.nbPointerMove(pointer('touch', 3, 35, 45));
context.nbPointerUp(pointer('touch', 3));
assert.equal(context.nbState.content.strokes.length, 2);
context.applePencilMode = true;

// The shared native stylus detector also accepts BOOX pen replay events.
context.window.__booxInput = { isPen: event => event.nativePen === true };
context.nbPointerDown({ ...pointer('touch', 5), nativePen: true });
assert.ok(context.nbState.drawing);
context.nbPointerUp(pointer('touch', 5));
delete context.window.__booxInput;

// A wide/short viewport fills the writing area horizontally rather than shrinking to its height.
context.nbLayout();
assert.equal(element('nbPageBox').style.width, '1000px');
assert.equal(element('nbPageBox').style.height, '1414px');

context.nbInitCanvasEvents();
const wrap = element('nbCanvasWrap');
function touch(x, y, type = 'direct', identifier = 1) {
    return { clientX: x, clientY: y, touchType: type, identifier };
}
function dispatch(type, touches) {
    const event = { type, touches, target: element('nbCanvas'),
        preventDefault() { this.prevented = true; }, stopPropagation: noop };
    for (const callback of wrap.listeners[type] || []) callback(event);
    return event;
}
assert.ok(wrap.listeners.touchstart, 'notebook wrapper handles touch navigation');
dispatch('touchstart', [touch(100, 100)]);
dispatch('touchmove', [touch(120, 130)]);
assert.equal(wrap.scrollLeft, 180, 'one finger pans horizontally');
assert.equal(wrap.scrollTop, 170, 'one finger pans vertically');
dispatch('touchend', []);

dispatch('touchstart', [touch(100, 100), touch(200, 100, 'direct', 2)]);
dispatch('touchmove', [touch(50, 100), touch(250, 100, 'direct', 2)]);
dispatch('touchend', []);
assert.equal(context.nbState.zoom, 2, 'two fingers zoom using notebook zoom');
assert.equal(wrap.scrollLeft, 510, 'pinch preserves the horizontal content anchor');
assert.equal(wrap.scrollTop, 440, 'pinch preserves the vertical content anchor');

const zoom = context.nbState.zoom;
dispatch('touchstart', [touch(100, 100, 'stylus'), touch(200, 100, 'direct', 2)]);
dispatch('touchmove', [touch(50, 100, 'stylus'), touch(250, 100, 'direct', 2)]);
dispatch('touchend', []);
assert.equal(context.nbState.zoom, zoom, 'Pencil plus finger never becomes a pinch');

context.nbPointerDown(pointer('pen', 6));
const inkScrollTop = wrap.scrollTop;
dispatch('touchstart', [touch(100, 100)]);
dispatch('touchmove', [touch(100, 200)]);
assert.equal(wrap.scrollTop, inkScrollTop, 'a palm cannot scroll an active Pencil stroke');
context.nbPointerUp(pointer('pen', 6));
dispatch('touchend', []);

dispatch('touchstart', [touch(100, 100)]);
dispatch('touchcancel', []);
const scrollTop = wrap.scrollTop;
dispatch('touchmove', [touch(100, 200)]);
assert.equal(wrap.scrollTop, scrollTop, 'cancelled gesture cannot keep scrolling');
console.log('Notebook input checks passed');
