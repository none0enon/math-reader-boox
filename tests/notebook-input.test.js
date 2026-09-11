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
    nbScheduleSave: () => { context.saveRequests++; context.nbState.dirty = true; }, saveRequests: 0, nbNativeRefresh: noop,
    nbHideSelToolbar: noop, nbPositionSelToolbar: noop, nbPositionTextToolbar: noop,
    nbSelectTextBox: noop, nbShowTextToolbar: noop, nbGetMediaData: async () => null,
    nbFinishLasso: noop, nbEraseAt: noop, nbShapePaths: () => [[0, 0], [10, 10]],
    nbAddTextBox: () => { context.textCreated++; }, textCreated: 0,
    nbCtx: () => ({ save: noop, restore: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, clearRect: noop, arc: noop }),
    setTimeout: callback => callback(), clearTimeout: noop,
    requestAnimationFrame: callback => callback(), cancelAnimationFrame: noop,
});
const functions = ['booxReaderIsPen', 'nbDisplayScale', 'nbEventPoint', 'nbLayout',
    'nbZoomSet', 'nbInitCanvasEvents', 'nbPointerDown', 'nbPointerMove', 'nbPointerUp', 'nbCancelDrawing',
    'nbEraseAt', 'nbStrokeHits', 'nbSegDist', 'nbSelStrokes', 'nbCopySelStrokes', 'nbSelBBox',
    'nbTranslateSelection', 'nbClearSelection', 'nbBuildTextEl', 'nbBuildMediaEl', 'nbApplyOp'];
vm.runInContext('let _nbActivePointerId = null, _nbActivePointerIsPen = false, _nbTouchGesture = null;\n'
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
function touch(x, y, type = 'direct', identifier = 1) {
    return { clientX: x, clientY: y, touchType: type, identifier };
}
function dispatch(type, touches, target = element('nbCanvas')) {
    const event = { type, touches, target,
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

function reset(tool = 'pen') {
    context.nbCancelDrawing();
    dispatch('touchend', []);
    context.document.activeElement = null;
    context.applePencilMode = false;
    Object.assign(context.nbState, { tool, zoom: 1, fitScale: 1, drawing: null,
        selection: null, dirty: false, content: { strokes: [], texts: [], media: [] } });
    context.operations.length = 0;
    context.saveRequests = 0;
    context.nbHitBoxAt = () => null;
    wrap.scrollLeft = 200; wrap.scrollTop = 200;
}
const twoFingers = [touch(100, 100), touch(200, 100, 'direct', 2)];
function startFinger(x = 10, y = 20) {
    context.nbPointerDown(pointer('touch', 11, x, y));
    dispatch('touchstart', [touch(x, y)]);
}
function startPinch(target) {
    context.nbPointerDown({ ...pointer('touch', 12), isPrimary: false });
    dispatch('touchstart', twoFingers, target);
}
function docPointer(type, x, y, pointerType = 'touch') {
    for (const callback of [...(documentListeners[type] || [])]) callback({ ...pointer(pointerType, 11, x, y), type });
}

// Default mode: the first finger's uncommitted preview disappears when a second
// finger takes over. Navigation never adds undo entries or finishes a lasso/text tap.
for (const tool of ['pen', 'shape', 'lasso', 'text']) {
    reset(tool);
    const saved = { id: 'saved', paths: [[[400, 400], [500, 500]]] };
    context.nbState.content.strokes.push(saved);
    const existingOp = { t: 'existing' };
    context.operations.push(existingOp);
    const textCount = context.textCreated;
    startFinger();
    context.nbPointerMove(pointer('touch', 11, 50, 60));
    startPinch();
    assert.equal(context.nbState.drawing, null, tool + ' preview cancelled');
    context.nbPointerUp(pointer('touch', 11));
    assert.deepEqual(context.nbState.content.strokes, [saved]);
    assert.deepEqual(context.operations, [existingOp], 'navigation preserves undo history');
    assert.equal(context.textCreated, textCount);
    assert.equal(context.nbState.dirty, false, 'discarded preview needs no save');
    dispatch('touchmove', [touch(100, 50), touch(200, 50, 'direct', 2)]);
    assert.equal(wrap.scrollTop, 250, tool + ' allows two-finger pan');
    dispatch('touchmove', [touch(50, 50), touch(250, 50, 'direct', 2)]);
    assert.equal(context.nbState.zoom, 2, tool + ' allows two-finger zoom');
    dispatch('touchend', [touch(50, 50)]);
    const stoppedAt = wrap.scrollTop;
    dispatch('touchmove', [touch(50, 100)]);
    context.nbPointerMove(pointer('touch', 11, 80, 90));
    assert.equal(wrap.scrollTop, stoppedAt, 'remaining finger cannot resume navigation or drawing');
    assert.equal(context.nbState.drawing, null);
    dispatch('touchend', []);
}

// Erasure mutates content immediately. Two separate removals use indices from
// different array states, so undoing their chronological order is significant.
reset('eraser');
const original = [
    { id: 'a', w: 1, paths: [[[10, 10]]] },
    { id: 'b', w: 1, paths: [[[100, 100]]] },
    { id: 'c', w: 1, paths: [[[60, 20]]] },
];
context.nbState.content.strokes.push(...original);
startFinger(10, 10);
context.nbPointerMove(pointer('touch', 11, 60, 20));
assert.deepEqual(context.nbState.content.strokes.map(s => s.id), ['b']);
startPinch();
assert.deepEqual(context.nbState.content.strokes, original, 'restore exact pre-gesture stroke order');
assert.equal(context.nbState.dirty, false, 'cancelled erasure must not schedule a page upload');
assert.equal(context.saveRequests, 0);
assert.equal(context.operations.length, 0);

reset('lasso');
context.nbState.content.strokes.push({ id: 'selected', paths: [[[10, 20], [20, 30]]] });
const addSelectionOp = { t: 'add', list: [context.nbState.content.strokes[0]] };
context.nbState.selection = { ids: ['selected'], bbox: context.nbSelBBox(['selected']) };
const beforeMove = JSON.stringify(context.nbState.content.strokes);
const beforeBounds = JSON.stringify(context.nbState.selection.bbox);
startFinger();
context.nbPointerMove(pointer('touch', 11, 30, 40));
assert.notEqual(JSON.stringify(context.nbState.content.strokes), beforeMove);
startPinch();
assert.equal(JSON.stringify(context.nbState.content.strokes), beforeMove);
assert.equal(JSON.stringify(context.nbState.selection.bbox), beforeBounds);
assert.equal(context.operations.length, 0);
assert.equal(context.nbState.dirty, false);
assert.equal(context.saveRequests, 0);
context.nbApplyOp(addSelectionOp, true);
context.nbApplyOp(addSelectionOp, false);
assert.equal(JSON.stringify(context.nbState.content.strokes), beforeMove, 'undo/redo keeps the restored stroke reference');

reset();
const hitBox = { id: 'hit', x: 10, y: 20 };
context.nbHitBoxAt = () => ({ kind: 'text', obj: hitBox });
startFinger();
context.nbPointerMove(pointer('touch', 11, 30, 40));
assert.equal(hitBox.x, 30);
context.nbPointerMove(pointer('touch', 11, 10, 20));
startPinch();
assert.deepEqual(hitBox, { id: 'hit', x: 10, y: 20 });
assert.equal(context.nbState.dirty, false);
assert.equal(context.saveRequests, 0);

// Text/media DOM drags and resize handles participate in the same cancellation,
// including removing their document listeners so later pointer events cannot move them.
for (const kind of ['text', 'image', 'audio', 'resize']) {
    reset();
    const obj = { id: kind, x: 10, y: 20, w: 220, fontSize: 18, type: kind };
    const el = (kind === 'text' || kind === 'resize') ? context.nbBuildTextEl(obj) : context.nbBuildMediaEl(obj);
    const target = kind === 'resize' ? el.children.find(c => c.dataset.c === 'br') : el;
    const before = JSON.stringify(obj);
    target.listeners.pointerdown[0]({ ...pointer('touch', 11), target });
    dispatch('touchstart', [touch(10, 20)], target);
    docPointer('pointermove', 50, 70);
    assert.notEqual(JSON.stringify(obj), before, kind + ' actually moved');
    docPointer('pointermove', 10, 20);
    startPinch(target);
    assert.equal(JSON.stringify(obj), before, kind + ' restored');
    assert.equal(context.nbState.drawing, null);
    assert.equal(context.nbState.dirty, false);
    assert.equal(context.saveRequests, 0);
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) assert.equal(documentListeners[type].length, 0);
    docPointer('pointermove', 90, 100);
    assert.equal(JSON.stringify(obj), before);
    dispatch('touchmove', [touch(100, 50), touch(200, 50, 'direct', 2)], target);
    assert.equal(wrap.scrollTop, 250, kind + ' surface allows navigation');
    assert.equal(context.operations.length, 0);
}

// A stale open page must not become a fresh save merely by touching an object
// and cancelling or starting navigation. Existing unsaved edits stay dirty.
for (const dirty of [false, true]) {
    for (const kind of ['canvas-box', 'text', 'image', 'audio', 'resize']) {
        for (const cancel of ['pinch', 'pointercancel']) {
            if (kind === 'canvas-box' && cancel === 'pointercancel') continue;
            reset();
            context.nbState.dirty = dirty;
            const obj = { id: 'cancel-' + kind, x: 10, y: 20, w: 220, fontSize: 18, type: kind };
            let target;
            if (kind === 'canvas-box') {
                context.nbHitBoxAt = () => ({ kind: 'text', obj });
                startFinger();
            } else {
                const el = (kind === 'text' || kind === 'resize') ? context.nbBuildTextEl(obj) : context.nbBuildMediaEl(obj);
                target = kind === 'resize' ? el.children.find(c => c.dataset.c === 'br') : el;
                target.listeners.pointerdown[0]({ ...pointer('touch', 11), target });
            }
            if (cancel === 'pinch') startPinch(target);
            else docPointer('pointercancel', 10, 20);
            assert.equal(context.saveRequests, 0, kind + ' ' + cancel + ' must not request a save');
            assert.equal(context.nbState.dirty, dirty, 'cancellation preserves the previous dirty state');
        }
    }
}

// A real pen stroke or object drag is never rolled back by two fingers, even
// when the Pencil-only preference is disabled.
for (const pencilOnly of [false, true]) {
    reset();
    context.applePencilMode = pencilOnly;
    context.nbPointerDown(pointer('pen', 11));
    const penDrawing = context.nbState.drawing;
    startPinch();
    dispatch('touchmove', [touch(100, 50), touch(200, 50, 'direct', 2)]);
    assert.equal(context.nbState.drawing, penDrawing);
    assert.equal(wrap.scrollTop, 200);
    context.nbPointerUp(pointer('pen', 11));
    assert.equal(context.saveRequests, 1, 'completed pen stroke still saves');

    reset();
    context.applePencilMode = pencilOnly;
    const obj = { id: 'pen-box', x: 10, y: 20 };
    const el = context.nbBuildTextEl(obj);
    el.listeners.pointerdown[0]({ ...pointer('pen', 11), target: el });
    const penDrag = context.nbState.drawing;
    startPinch(el);
    assert.equal(context.nbState.drawing, penDrag);
    docPointer('pointermove', 40, 50, 'pen');
    docPointer('pointerup', 40, 50, 'pen');
    assert.equal(obj.x, 40);
    assert.equal(context.saveRequests, 1, 'completed object drag still saves');
}

reset('text');
const textCount = context.textCreated;
startFinger();
assert.equal(context.textCreated, textCount, 'text creation waits for tap release');
context.nbPointerUp(pointer('touch', 11));
assert.equal(context.textCreated, textCount + 1);
reset('text');
startFinger();
context.nbPointerUp({ ...pointer('touch', 11), type: 'pointercancel' });
assert.equal(context.textCreated, textCount + 1, 'a cancelled touch never creates text');
reset();
startFinger();
context.nbPointerMove(pointer('touch', 11, 30, 40));
context.nbPointerUp(pointer('touch', 11));
assert.equal(context.nbState.content.strokes.length, 1, 'single-finger writing still commits');
assert.equal(context.saveRequests, 1, 'completed finger stroke still saves');
console.log('Notebook input checks passed');
