const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../app/src/main/assets/boox-pen.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
function pageFunction(name) {
    const match = page.match(new RegExp('        function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n        \\}'));
    assert.ok(match, 'missing page function ' + name);
    return match[0];
}

for (const [canvasId, clipId, eraserId, widthFlag] of [
    ['lectureDrawCanvas', 'lectureViewerContent', 'lecturePenEraser', '__lectureNativeWidth'],
    ['lectureDraftCanvas', 'lectureDraftCanvasWrapper', 'lectureDraftEraserToggle', '__lectureDraftNativeWidth'],
    ['nbCanvas', 'nbCanvasWrap', 'nbEraserBtn', '__nbNativeWidth']
]) {
    const calls = [], events = [], classes = new Set(), listeners = {};
    let covered = false, pointerEvents = 'auto', eraserToggles = 0;
    // A long canvas scrolled into its middle: none of its original five sample
    // points are visible. The SDK must sample and register only the viewport.
    const rect = { left: -20, top: -1000, right: 920, bottom: 5000, width: 940, height: 6000 };
    const clip = { left: 0, top: 60, right: 900, bottom: 750, width: 900, height: 690 };
    const canvas = {
        isConnected: true, classList: { contains: () => false },
        getBoundingClientRect: () => rect,
        setPointerCapture() {},
        addEventListener(type, fn, capture) {
            const handlers = listeners[type] || (listeners[type] = []);
            capture === true ? handlers.unshift(fn) : handlers.push(fn);
        },
        dispatchEvent(e) {
            events.push(e);
            e.target = canvas;
            for (const handler of listeners[e.type] || []) handler(e);
        }
    };
    const elements = {
        [canvasId]: canvas,
        [clipId]: { getBoundingClientRect: () => clip, scrollLeft: 0, scrollTop: 0 },
        [eraserId]: { classList: { contains: c => classes.has(c) } }
    };
    const context = {
        navigator: {}, console: { log() {}, warn() {} },
        devicePixelRatio: 2, innerWidth: 1000, innerHeight: 800,
        [widthFlag]: 3,
        addEventListener() {}, setInterval() {}, setTimeout() {}, clearTimeout() {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', pointerEvents }),
        PointerEvent: class {
            constructor(type, values) { Object.assign(this, values, { type }); }
            preventDefault() {} stopPropagation() {}
        },
        document: {
            getElementById: id => elements[id] || null,
            querySelectorAll: () => [], addEventListener() {},
            elementFromPoint: (x, y) => !covered && x >= clip.left && x <= clip.right
                && y >= clip.top && y <= clip.bottom ? canvas : null
        },
        BooxPenNative: {
            isAvailable: () => true,
            setRects: json => calls.push(JSON.parse(json)),
            disable: () => calls.push(null)
        },
        toggleLecturePenEraser() {
            eraserToggles++;
            if (classes.has('active')) classes.delete('active');
            else classes.add('active');
        }
    };
    context.window = context;
    vm.runInNewContext(source, context);
    const pen = context.__booxPen;
    const lines = [], saves = [], timers = [];
    if (canvasId === 'lectureDraftCanvas') {
        canvas.getContext = () => ({
            beginPath() {}, moveTo: (x, y) => lines.push(['from', x, y]),
            lineTo: (x, y) => lines.push(['to', x, y]), stroke() {},
            getImageData: () => ({ lines: lines.slice() })
        });
        context.saveLectureDraft = () => saves.push('saved');
        context.setTimeout = (fn, delay) => { timers.push({ fn, delay }); return timers.length; };
        vm.runInNewContext(
            page.slice(page.indexOf('        let lectureDraftCanvas = null;'), page.indexOf('        function toggleLectureDraftPanel()'))
            + page.slice(page.indexOf('        let lectureDraftPanActive = false;'), page.indexOf('        function handleLectureDraftTouchStart(e)'))
            + '\nlet applePencilMode = true; let _lectureDraftSaveTimer = null;\n'
            + ['booxReaderIsPen', 'initLectureDraftCanvas', 'startLectureDraftDraw', 'doLectureDraftDraw',
                'endLectureDraftDraw', 'handleLectureDraftTouchStart', 'handleLectureDraftTouchMove',
                'handleLectureDraftTouchEnd', 'saveLectureDraftCanvasState', 'debouncedSaveLectureDraft']
                .map(pageFunction).join('\n')
            + '\nlectureDraftPenEnabled = true; initLectureDraftCanvas();', context);
    }
    pen.syncRegions();
    assert.deepEqual(calls.at(-1), { rects: [[0, 120, 1800, 1500]], width: 6 }, canvasId);
    pen.syncRegions();
    assert.equal(calls.length, 1, 'unchanged regions must not restart native drawing');

    pen.onStroke([[200, 300, 0.4], [240, 360, 0.8]], false);
    assert.deepEqual(events.map(e => [e.type, e.clientX, e.clientY, e.pointerType, e.buttons]), [
        ['pointerdown', 100, 150, 'pen', 1],
        ['pointermove', 120, 180, 'pen', 1],
        ['pointerup', 120, 180, 'pen', 0]
    ], 'native strokes must reach the existing pointer drawing/save handlers');
    if (canvasId === 'lectureDraftCanvas') {
        assert.deepEqual(lines, [['from', 120, 1150], ['to', 140, 1180]]);
        assert.equal(vm.runInNewContext('lectureDraftHistory.length', context), 1, 'native replay must save an undo snapshot');
        assert.equal(vm.runInNewContext('lectureDraftCanvasDirty', context), true);
        assert.equal(timers.at(-1).delay, 1000, 'native replay must schedule the existing draft save');
        timers.at(-1).fn();
        assert.deepEqual(saves, ['saved']);

        // Apple Pencil mode: direct finger pointers do not write; their touch
        // events retain one-finger scroll. Normal mode retains two-finger pan.
        const touch = (x, y) => ({ clientX: x, clientY: y, touchType: 'direct' });
        const touchEvent = touches => ({ touches, preventDefault() {} });
        context.startLectureDraftDraw(new context.PointerEvent('pointerdown', { pointerType: 'touch', pointerId: 9 }));
        assert.equal(vm.runInNewContext('lectureDraftDrawing', context), false);
        context.handleLectureDraftTouchStart(touchEvent([touch(100, 150)]));
        context.handleLectureDraftTouchMove(touchEvent([touch(110, 170)]));
        assert.deepEqual([elements[clipId].scrollLeft, elements[clipId].scrollTop], [-10, -20]);
        context.handleLectureDraftTouchEnd(touchEvent([]));
        vm.runInNewContext('applePencilMode = false', context);
        context.handleLectureDraftTouchStart(touchEvent([touch(100, 150), touch(200, 150)]));
        context.handleLectureDraftTouchMove(touchEvent([touch(120, 180), touch(220, 180)]));
        assert.deepEqual([elements[clipId].scrollLeft, elements[clipId].scrollTop], [-30, -50]);
        context.handleLectureDraftTouchEnd(touchEvent([]));
        assert.equal(vm.runInNewContext('lectureDraftHistory.length', context), 1, 'scrolling must not create handwriting');
    }
    if (canvasId === 'lectureDrawCanvas') {
        pen.onStroke([[200, 300, 0.4]], true);
        assert.equal(eraserToggles, 2, 'side eraser toggles on for replay then restores pen');
        assert.equal(classes.has('active'), false);
    }

    classes.add('active');
    pen.syncRegions();
    assert.equal(calls.at(-1), null, 'eraser must use the page erase handler');
    classes.delete('active');
    context[widthFlag] = 5;
    pen.syncRegions();
    assert.equal(calls.at(-1).width, 10, 'native width must follow the selected brush');

    covered = true;
    pen.syncRegions();
    assert.equal(calls.at(-1), null, 'an obscured canvas must not capture native input');
    covered = false;
    pen.syncRegions();
    pointerEvents = 'none';
    pen.syncRegions();
    assert.equal(calls.at(-1), null, 'leaving pen mode must disable the native region');
    pointerEvents = 'auto';
    pen.syncRegions();
    rect.bottom = 50;
    pen.syncRegions();
    assert.equal(calls.at(-1), null, 'a canvas outside its scroll viewport must stay disabled');
}

console.log('BOOX handwriting regions and native stroke replay checks passed');
