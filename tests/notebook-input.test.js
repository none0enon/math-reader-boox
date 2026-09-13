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
const nodes = [];
const documentListeners = {};
function node(tagName = 'DIV') {
    const el = { tagName: tagName.toUpperCase(), style: {}, dataset: {}, children: [], listeners: {}, className: '',
        addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
        appendChild(child) { this.children.push(child); child.parentElement = this; },
        closest: () => null, contains(target) { return target === this || this.children.some(c => c.contains(target)); },
        offsetWidth: 220, offsetHeight: 40,
        focus() { context.document.activeElement = this; },
        querySelector(selector) { return this.children.find(c => c.className === selector.slice(1)); },
    };
    el.classList = {
        contains: name => el.className.split(' ').includes(name),
        add: name => { el.className += ' ' + name; },
        remove: name => { el.className = el.className.split(' ').filter(c => c !== name).join(' '); },
        toggle: noop,
    };
    nodes.push(el);
    return el;
}
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
    i18n: key => key,
    document: { getElementById: element, querySelectorAll: () => [], createElement: node,
        querySelector: selector => nodes.find(n => n.dataset.id && selector.includes('"' + n.dataset.id + '"')),
        addEventListener: (type, callback) => { (documentListeners[type] ||= []).push(callback); },
        removeEventListener: (type, callback) => { documentListeners[type] = (documentListeners[type] || []).filter(f => f !== callback); },
    },
    applePencilMode: true, NB_PAGE_W: 1000, NB_PAGE_H: 1414, NB_MM: 4,
    nbState: {
        tool: 'pen', shapeType: 'rect', fitScale: 1, zoom: 1, brushIndex: 0,
        brushes: [{ type: 'pen', color: '#111111', mm: 0.5 }],
        drawing: null, selection: null, content: { strokes: [], texts: [], media: [] },
    },
    nbHidePanel: noop, nbHideOutline: noop, nbHideTextToolbar: noop,
    nbHitBoxAt: () => null, nbUid: () => 'stroke', nbPushOp: op => context.operations.push(op), operations: [],
    nbRedraw: noop, nbDrawOverlay: noop, nbDrawBg: noop, nbRenderTexts: noop,
    nbScheduleSave: () => { context.nbState.dirty = true; }, nbNativeRefresh: noop,
    nbHideSelToolbar: noop, nbPositionSelToolbar: noop, nbPositionTextToolbar: noop,
    nbSelectTextBox: noop, nbShowTextToolbar: noop, nbGetMediaData: async () => null,
    nbFinishLasso: noop, nbEraseAt: noop, nbShapePaths: () => [[0, 0], [10, 10]],
    nbAddTextBox: () => { context.textCreated++; }, textCreated: 0,
    nbCtx: () => ({ save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, clearRect: noop, arc: noop }),
    setTimeout: callback => callback(), clearTimeout: noop,
    requestAnimationFrame: callback => callback(), cancelAnimationFrame: noop,
});
const functions = ['booxReaderIsPen', 'nbDisplayScale', 'nbEventPoint', 'nbLayout',
    'nbZoomSet', 'nbInitCanvasEvents', 'nbPointerDown', 'nbPointerMove', 'nbPointerUp',
    'nbEraseAt', 'nbStrokeHits', 'nbSegDist', 'nbSelStrokes', 'nbCopySelStrokes', 'nbSelBBox',
    'nbTranslateSelection', 'nbClearSelection', 'nbBuildTextEl', 'nbBuildMediaEl', 'nbApplyOp'];
vm.runInContext('let _nbActivePointerId = null;\n'
    + functions.map(source).join('\n'), context);

function pointer(type, id = 1, x = 10, y = 20) {
    return { pointerType: type, pointerId: id, button: 0, clientX: x, clientY: y,
        target: element('nbCanvas'), preventDefault() { this.prevented = true; }, stopPropagation: noop };
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
// No custom touch navigation remains in either Pencil mode or normal mode.
for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    assert.equal(wrap.listeners[type], undefined, 'no notebook ' + type + ' navigation handler');
}
for (const pencilOnly of [false, true]) {
    context.applePencilMode = pencilOnly;
    const before = [wrap.scrollLeft, wrap.scrollTop, context.nbState.zoom];
    context.nbPointerDown(pointer('touch', 11));
    context.nbPointerDown({ ...pointer('touch', 12), isPrimary: false });
    context.nbPointerMove(pointer('touch', 12, 200, 300));
    context.nbPointerUp(pointer('touch', 12));
    context.nbPointerMove(pointer('touch', 11, 100, 200));
    context.nbPointerUp(pointer('touch', 11));
    assert.deepEqual([wrap.scrollLeft, wrap.scrollTop, context.nbState.zoom], before);
}

// Existing text/media pointer cancellation still restores edits and removes listeners.
context.applePencilMode = false;
for (const kind of ['text', 'image', 'audio', 'resize']) {
    context.document.activeElement = null;
    const obj = { id: kind, x: 10, y: 20, w: 220, fontSize: 18, type: kind };
    const el = (kind === 'text' || kind === 'resize') ? context.nbBuildTextEl(obj) : context.nbBuildMediaEl(obj);
    const target = kind === 'resize' ? el.children.find(c => c.dataset.c === 'br') : el;
    const before = JSON.stringify(obj);
    target.listeners.pointerdown[0]({ ...pointer('touch', 11), target });
    for (const callback of [...documentListeners.pointermove]) callback(pointer('touch', 11, 50, 70));
    assert.notEqual(JSON.stringify(obj), before);
    for (const callback of [...documentListeners.pointercancel]) callback({ ...pointer('touch', 11), type: 'pointercancel' });
    assert.equal(JSON.stringify(obj), before);
    assert.equal(context.nbState.drawing, null);
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) assert.equal(documentListeners[type].length, 0);
}

context.nbState.tool = 'text';
const textCount = context.textCreated;
context.nbPointerDown(pointer('touch', 11));
context.nbPointerUp({ ...pointer('touch', 11), type: 'pointercancel' });
assert.equal(context.textCreated, textCount, 'a cancelled touch never creates text');
context.nbPointerDown(pointer('touch', 11));
context.nbPointerUp(pointer('touch', 11));
assert.equal(context.textCreated, textCount + 1);
context.nbZoomSet(150);
assert.equal(context.nbState.zoom, 1.5, 'existing zoom buttons remain available');
console.log('Notebook input checks passed');
