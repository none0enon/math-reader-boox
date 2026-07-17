'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const apkIndexPath = path.join(root, 'app/src/main/assets/www/index.html');
const pwaIndexPath = path.join(root, 'docs/index.html');
const readerHtml = fs.readFileSync(apkIndexPath, 'utf8');

// Read one top-level function without executing the complete browser bundle.
// Application functions use eight spaces of indentation.
function functionSource(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`(?:^|\\n) {8}(?:async )?function ${escaped}\\s*\\(`);
    const match = declaration.exec(readerHtml);
    assert.ok(match, `${name} function not found`);

    const start = match.index;
    const afterDeclaration = readerHtml.slice(start + match[0].length);
    const nextFunction = afterDeclaration.search(/\n {8}(?:async )?function [A-Za-z_$][\w$]*\s*\(/);
    return nextFunction < 0
        ? readerHtml.slice(start)
        : readerHtml.slice(start, start + match[0].length + nextFunction);
}

function sourceBlock(startMarker, endMarker) {
    const start = readerHtml.indexOf(startMarker);
    assert.ok(start >= 0, `source marker not found: ${startMarker}`);
    const end = readerHtml.indexOf(endMarker, start);
    assert.ok(end > start, `source end marker not found: ${endMarker}`);
    return readerHtml.slice(start, end + endMarker.length);
}

function loadFunction(name, globals = {}) {
    const context = vm.createContext({ ...globals });
    vm.runInContext(`${functionSource(name)}\nthis.__functionUnderTest = ${name};`, context);
    return { fn: context.__functionUnderTest, context };
}

function loadFunctions(names, globals = {}) {
    const context = vm.createContext({ ...globals });
    const exports = names.map(name => `this.__functionsUnderTest.${name} = ${name};`).join('\n');
    vm.runInContext(
        `${names.map(functionSource).join('\n')}\nthis.__functionsUnderTest = {};\n${exports}`,
        context
    );
    return { functions: context.__functionsUnderTest, context };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 50; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(message);
}

function createBlobFirstHarness({ appData, saveBlobsToIDB, setTimeoutImpl }) {
    const metadata = [];
    const loaded = loadFunctions([
        'stripBlobsFromSaveData',
        'markBlobMetadataPending',
        'blobMetadataCommitIsPending',
        'flushDeferredBlobMetadataSave',
        'saveBlobFailureFallbackMetadata',
        'queueBlobsSaveToIDB',
        'saveData'
    ], {
        appData,
        _annotationBlobRestoreFinished: true,
        _annotationBlobBlockedDocIds: new Set(),
        _draftBlobBlockedDocIds: new Set(),
        _annotationBlobDeletedDocIds: new Set(),
        _blobDeletionCleanupReadyDocIds: new Set(),
        _blobSaveInFlight: false,
        _blobSaveQueued: false,
        _blobSaveAllQueued: false,
        _blobSaveQueuedDocIds: new Set(),
        _blobSaveRetryTimer: null,
        _blobSaveRetryDelay: 3000,
        _blobSaveFailureNotified: false,
        _blobMetadataGenerationSequence: 0,
        _blobMetadataPendingVersions: new Map(),
        _blobMetadataSaveDeferred: false,
        _blobFailureFallbackActive: false,
        _forceInlineBlobMetadataSave: false,
        ensureDocumentAnnotationBlobIds: doc => {
            (doc && doc.annotations || []).forEach((annotation, index) => {
                if (!annotation._blobId) annotation._blobId = `${doc.id}-annotation-${index}`;
            });
        },
        saveBlobsToIDB,
        localStorage: {
            setItem: (key, value) => {
                assert.equal(key, 'mathReader');
                metadata.push(JSON.parse(value));
            }
        },
        backupAppDataToIDB: () => {},
        queueMicrotask,
        setTimeout: setTimeoutImpl || (() => 1),
        clearTimeout: () => {},
        showToast: () => {},
        i18n: key => key,
        console: { error: () => {}, warn: () => {} }
    });
    return { ...loaded, metadata };
}

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
        this.listenerOptions = new Map();
    }

    addEventListener(type, handler, options) {
        const handlers = this.listeners.get(type) || [];
        handlers.push(handler);
        this.listeners.set(type, handlers);
        this.listenerOptions.set(type, options);
    }

    dispatch(type, event = {}) {
        for (const handler of this.listeners.get(type) || []) {
            handler.call(this, event);
        }
    }
}

function pointerEvent(pointerType, pointerId = 1) {
    let prevented = 0;
    return {
        pointerType,
        pointerId,
        button: 0,
        clientX: 40,
        clientY: 60,
        preventDefault() { prevented++; },
        stopPropagation() {},
        get prevented() { return prevented; }
    };
}

function createLassoHarness(overrides = {}) {
    const layer = new FakeEventTarget();
    const container = { scrollTop: 500 };
    const calls = {
        starts: [], moves: [], ends: [], cancels: 0, pageTurns: [], hides: 0
    };
    const globals = {
        penMode: false,
        isPinching: false,
        einkMode: false,
        applePencilMode: false,
        einkPendingSelection: { stale: true },
        booxReaderIsPen: event => event.pointerType === 'pen',
        hideReaderSelectionMenu: () => { calls.hides++; },
        einkSelectStart: (...args) => { calls.starts.push(args); },
        einkSelectMove: event => { calls.moves.push(event); },
        einkSelectEnd: event => { calls.ends.push(event); return true; },
        einkSelectCancel: () => { calls.cancels++; },
        einkHandleReaderTap: () => false,
        einkPageTurnByClientX: x => { calls.pageTurns.push(x); },
        document: {
            getElementById: id => id === 'readerContainer' ? container : null
        },
        ...overrides
    };
    const { fn, context } = loadFunction('attachReaderTextLayerInput', globals);
    fn(layer, 7);
    return { layer, container, calls, context };
}

test('Apple Pencil lasso mode accepts Pencil and rejects finger pointers', () => {
    const cases = [
        {
            name: 'ordinary PWA finger',
            globals: { applePencilMode: false, einkMode: false },
            pointerType: 'touch',
            expectedStarts: 1,
            expectedPrevented: 1
        },
        {
            name: 'Apple Pencil mode finger',
            globals: { applePencilMode: true, einkMode: false },
            pointerType: 'touch',
            expectedStarts: 0,
            expectedPrevented: 0
        },
        {
            name: 'Apple Pencil mode Pencil',
            globals: { applePencilMode: true, einkMode: false },
            pointerType: 'pen',
            expectedStarts: 1,
            expectedPrevented: 1
        }
    ];

    for (const item of cases) {
        const { layer, calls } = createLassoHarness(item.globals);
        const event = pointerEvent(item.pointerType);
        layer.dispatch('pointerdown', event);
        assert.equal(calls.starts.length, item.expectedStarts, item.name);
        assert.equal(event.prevented, item.expectedPrevented, item.name);
        if (calls.starts.length) {
            assert.equal(calls.starts[0][1], 7, `${item.name} must remain bound to its page`);
            assert.equal(calls.starts[0][2], event);
        }
    }
});

test('Apple Pencil lasso layer manually scrolls one-finger touches', () => {
    const { layer, container, calls } = createLassoHarness({
        applePencilMode: true,
        einkMode: false
    });
    assert.equal(layer.listenerOptions.get('touchmove').passive, false);

    layer.dispatch('pointerdown', pointerEvent('touch'));
    assert.equal(calls.starts.length, 0, 'finger PointerEvents must not start a lasso');

    layer.dispatch('touchstart', { touches: [{ clientY: 300, touchType: 'direct' }] });
    let prevented = 0;
    layer.dispatch('touchmove', {
        touches: [{ clientY: 250, touchType: 'direct' }],
        preventDefault() { prevented++; }
    });
    assert.equal(container.scrollTop, 550, 'upward finger movement must scroll content down');
    assert.equal(prevented, 1);

    layer.dispatch('touchend', { touches: [] });
    layer.dispatch('touchmove', {
        touches: [{ clientY: 200, touchType: 'direct' }],
        preventDefault() { prevented++; }
    });
    assert.equal(container.scrollTop, 550, 'touchend must stop manual scrolling');

    layer.dispatch('touchstart', { touches: [{ clientY: 180, touchType: 'stylus' }] });
    layer.dispatch('touchmove', {
        touches: [{ clientY: 100, touchType: 'stylus' }],
        preventDefault() { prevented++; }
    });
    assert.equal(container.scrollTop, 550, 'stylus touches must remain reserved for lasso input');
});

test('lasso and E-Ink finger state ignore events from other pointer ids', () => {
    const pencil = createLassoHarness({ applePencilMode: true, einkMode: false });
    pencil.layer.dispatch('pointerdown', pointerEvent('pen', 41));
    assert.equal(pencil.calls.starts.length, 1);

    pencil.layer.dispatch('pointercancel', pointerEvent('touch', 42));
    assert.equal(pencil.calls.cancels, 0, 'a second finger must not cancel the active Pencil lasso');

    pencil.layer.dispatch('pointermove', pointerEvent('pen', 41));
    pencil.layer.dispatch('pointerup', pointerEvent('pen', 41));
    assert.equal(pencil.calls.moves.length, 1, 'the Pencil lasso must remain active after foreign cancel');
    assert.equal(pencil.calls.ends.length, 1);

    const foreignMove = createLassoHarness({ einkMode: true });
    foreignMove.layer.dispatch('pointerdown', pointerEvent('touch', 51));
    const otherMove = pointerEvent('touch', 52);
    otherMove.clientX = 200;
    otherMove.clientY = 200;
    foreignMove.layer.dispatch('pointermove', otherMove);
    foreignMove.layer.dispatch('pointerup', pointerEvent('touch', 51));
    assert.deepEqual(
        foreignMove.calls.pageTurns,
        [40],
        'movement from another pointer id must not mark the E-Ink finger as moved'
    );

    const foreignUp = createLassoHarness({ einkMode: true });
    foreignUp.layer.dispatch('pointerdown', pointerEvent('touch', 61));
    foreignUp.layer.dispatch('pointerup', pointerEvent('touch', 62));
    assert.deepEqual(foreignUp.calls.pageTurns, [], 'foreign pointerup must not consume the tracked finger');
    foreignUp.layer.dispatch('pointerup', pointerEvent('touch', 61));
    assert.deepEqual(foreignUp.calls.pageTurns, [40], 'the tracked E-Ink finger must still complete normally');
});

test('global reader pinch only steals two non-stylus touches', () => {
    const pinchInstaller = sourceBlock(
        '        (function() {\n            let initialDistance = 0;',
        '        })();'
    );
    const document = new FakeEventTarget();
    const container = {
        scrollTop: 0,
        scrollLeft: 0,
        clientHeight: 800,
        closest: selector => selector === '.page.active' ? {} : null,
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 800 })
    };
    const wrapper = { style: {} };
    document.getElementById = id => {
        if (id === 'readerContainer') return container;
        if (id === 'pdfCanvasWrapper') return wrapper;
        return null;
    };
    const calls = { hide: 0, clear: 0, rollback: 0 };
    const pendingSelection = { active: true };
    const context = vm.createContext({
        document,
        isPinching: false,
        userZoom: 1,
        totalPages: 1,
        currentPage: 1,
        pageElements: {
            1: { placeholder: { offsetTop: 0, offsetHeight: 1000 } }
        },
        hideReaderSelectionMenu: () => { calls.hide++; },
        clearReaderTextSelection: () => { calls.clear++; },
        rollbackActivePenStroke: () => { calls.rollback++; },
        einkPendingSelection: pendingSelection,
        activePenStroke: { pageNum: 1 },
        einkSel: { pointerId: 71 },
        einkMode: false,
        einkApplyPinchZoom: () => {},
        rebuildPagesForZoom: () => {},
        setTimeout: () => 1
    });
    vm.runInContext(pinchInstaller, context);

    const stylus = { touchType: 'stylus', clientX: 20, clientY: 20 };
    const finger = { touchType: 'direct', clientX: 140, clientY: 20 };
    document.dispatch('touchstart', { touches: [stylus, finger] });
    assert.equal(calls.hide, 0);
    assert.equal(calls.clear, 0, 'stylus plus finger must not clear an active Pencil lasso');
    assert.equal(calls.rollback, 0, 'stylus plus finger must not roll back an active Pencil stroke');
    assert.equal(context.isPinching, false);
    assert.equal(context.einkPendingSelection, pendingSelection);

    let blockedGestureStart = 0;
    document.dispatch('gesturestart', {
        preventDefault() { blockedGestureStart++; }
    });
    assert.equal(
        blockedGestureStart,
        1,
        'Safari gesturestart must be prevented while a Pencil stroke or lasso is active'
    );
    let blockedGestureChange = 0;
    document.dispatch('gesturechange', {
        scale: 1.5,
        preventDefault() { blockedGestureChange++; }
    });
    assert.equal(blockedGestureChange, 0, 'the blocked gesturestart must not activate legacy gesture zoom');
    assert.deepEqual(wrapper.style, {});

    const finger2 = { touchType: 'direct', clientX: 20, clientY: 20 };
    const finger3 = { touchType: 'direct', clientX: 140, clientY: 20 };
    document.dispatch('touchstart', { touches: [finger2, finger3] });
    assert.equal(calls.hide, 1);
    assert.equal(calls.clear, 1, 'two direct fingers may take over for reader pinch');
    assert.equal(calls.rollback, 1);
    assert.equal(context.isPinching, true);
    assert.equal(context.einkPendingSelection, null);
});

test('reader ink commits vector operations without full-page pixel snapshots', () => {
    const readerInkSource = [
        functionSource('createReaderDrawingState'),
        functionSource('attachPenInteraction'),
        functionSource('undoStroke'),
        functionSource('redoStroke')
    ].join('\n');
    assert.doesNotMatch(readerInkSource, /\bgetImageData\s*\(|\bputImageData\s*\(|\bnew\s+ImageData\b/);
    assert.match(functionSource('createReaderDrawingState'), /operations:\s*\[\]/);
    assert.match(functionSource('undoStroke'), /state\.operations\.splice\s*\(/);
    assert.match(functionSource('redoStroke'), /state\.operations\.push\s*\(entry\.operation\)/);

    const canvas = new FakeEventTarget();
    canvas.style = { width: '100px', height: '100px' };
    canvas.dataset = { pageNum: '3' };
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
    canvas.setPointerCapture = () => {};
    const context2d = {
        getImageData() { throw new Error('full-page snapshot attempted'); },
        putImageData() { throw new Error('full-page snapshot restore attempted'); }
    };
    const drawingState = {
        operations: [],
        activeOperation: null,
        baseReady: true,
        baseLoadFailed: false
    };
    let saveCount = 0;
    let segmentCount = 0;
    const { fn: attach, context } = loadFunction('attachPenInteraction', {
        isPinching: false,
        penMode: true,
        applePencilMode: true,
        booxReaderIsPen: event => event.pointerType === 'pen',
        currentDoc: { id: 'doc-1' },
        canEditDocumentAnnotations: () => true,
        currentAnnoCanvas: null,
        currentAnnoCtx: null,
        readerEraserMode: false,
        penColor: '#123456',
        penSize: 3,
        activePenStroke: null,
        READER_INK_HISTORY_MAX: 200,
        strokeHistory: [],
        redoHistory: [{ stale: true }],
        redrawReaderDrawingState: () => {},
        drawReaderOperationSegment: () => { segmentCount++; },
        updateUndoRedoButtons: () => {},
        saveDrawingForPage: () => { saveCount++; },
        document: { getElementById: () => ({ scrollTop: 0 }) }
    });
    attach(canvas, context2d, 3, { width: 100, height: 100 }, drawingState);

    canvas.dispatch('pointerdown', pointerEvent('touch', 1));
    assert.equal(drawingState.activeOperation, null, 'finger input must not create ink in Pencil mode');

    const down = pointerEvent('pen', 2);
    down.clientX = 10;
    down.clientY = 20;
    canvas.dispatch('pointerdown', down);
    const move = pointerEvent('pen', 2);
    move.clientX = 30;
    move.clientY = 40;
    canvas.dispatch('pointermove', move);
    canvas.dispatch('pointerup', pointerEvent('pen', 2));

    assert.equal(drawingState.operations.length, 1);
    const operation = drawingState.operations[0];
    assert.equal(operation.type, 'stroke');
    assert.equal(operation.composite, 'source-over');
    assert.equal(operation.color, '#123456');
    assert.equal(operation.width, 3);
    assert.deepEqual(JSON.parse(JSON.stringify(operation.points)), [
        { x: 10, y: 20 },
        { x: 30, y: 40 }
    ]);
    assert.equal(Object.hasOwn(operation, 'imageData'), false);
    assert.equal(context.strokeHistory.length, 1);
    assert.equal(context.strokeHistory[0].operation, operation);
    assert.equal(context.redoHistory.length, 0);
    assert.equal(segmentCount, 1);
    assert.equal(saveCount, 1);
});

test('reader ink refuses input until its durable base image is usable', () => {
    function runPointerDown(drawingState, annotationEditable = true) {
        const canvas = new FakeEventTarget();
        canvas.style = { width: '100px', height: '100px' };
        canvas.dataset = { pageNum: '8' };
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 });
        let captureCount = 0;
        canvas.setPointerCapture = () => { captureCount++; };
        let toastCount = 0;
        const { fn: attach, context } = loadFunction('attachPenInteraction', {
            isPinching: false,
            penMode: true,
            applePencilMode: false,
            booxReaderIsPen: () => true,
            currentDoc: { id: 'doc-1' },
            canEditDocumentAnnotations: () => annotationEditable,
            currentAnnoCanvas: null,
            currentAnnoCtx: null,
            readerEraserMode: false,
            penColor: '#000000',
            penSize: 2,
            activePenStroke: null,
            READER_INK_HISTORY_MAX: 200,
            strokeHistory: [],
            redoHistory: [],
            redrawReaderDrawingState: () => {},
            drawReaderOperationSegment: () => {},
            updateUndoRedoButtons: () => {},
            saveDrawingForPage: () => {},
            compactReaderDrawingState: () => {},
            showToast: () => { toastCount++; },
            i18n: key => key,
            document: { getElementById: () => ({ scrollTop: 0 }) }
        });
        attach(canvas, {}, 8, { width: 100, height: 100 }, drawingState);
        const event = pointerEvent('pen', 81);
        canvas.dispatch('pointerdown', event);
        return { context, event, captureCount, toastCount };
    }

    const loadingState = {
        baseReady: false,
        baseLoadFailed: false,
        operations: [],
        activeOperation: null
    };
    const loading = runPointerDown(loadingState);
    assert.equal(loading.event.prevented, 1);
    assert.equal(loading.captureCount, 0);
    assert.equal(loading.toastCount, 0);
    assert.equal(loadingState.activeOperation, null);
    assert.equal(loading.context.strokeHistory.length, 0);
    assert.equal(loading.context.activePenStroke, null);

    const failedState = {
        baseReady: true,
        baseLoadFailed: true,
        operations: [],
        activeOperation: null
    };
    const failed = runPointerDown(failedState);
    assert.equal(failed.event.prevented, 1);
    assert.equal(failed.captureCount, 0);
    assert.equal(failed.toastCount, 1, 'a failed base decode must report that ink is unavailable');
    assert.equal(failedState.activeOperation, null);
    assert.equal(failed.context.strokeHistory.length, 0);
    assert.equal(failed.context.activePenStroke, null);

    const blockedState = {
        baseReady: true,
        baseLoadFailed: false,
        operations: [],
        activeOperation: null
    };
    const blocked = runPointerDown(blockedState, false);
    assert.equal(blocked.event.prevented, 1);
    assert.equal(blocked.captureCount, 0);
    assert.equal(blockedState.activeOperation, null);
});

test('reader PDF and annotation canvases honor the 4 Mi-pixel cap below DPR 1', async () => {
    const renderSource = functionSource('renderSinglePage');
    assert.match(readerHtml, /const READER_MAX_CANVAS_PIXELS\s*=\s*4\s*\*\s*1024\s*\*\s*1024\s*;/);
    assert.match(renderSource, /Math\.sqrt\(READER_MAX_CANVAS_PIXELS\s*\/\s*\(viewport\.width\s*\*\s*viewport\.height\)\)/);
    assert.doesNotMatch(renderSource, /Math\.max\(\s*1\s*,\s*dpr\s*\)/);

    const cap = 4 * 1024 * 1024;
    const viewport = { width: 4096, height: 4096 };
    const createdCanvases = [];
    const makeCanvas = () => {
        const canvas = new FakeEventTarget();
        canvas.width = 0;
        canvas.height = 0;
        canvas.style = {};
        canvas.dataset = {};
        canvas.isConnected = true;
        canvas.scales = [];
        canvas.getContext = () => ({ scale: (x, y) => { canvas.scales.push([x, y]); } });
        createdCanvases.push(canvas);
        return canvas;
    };
    const classNames = new Set(['pdf-page-placeholder']);
    const placeholder = {
        children: [],
        classList: {
            add: name => classNames.add(name),
            remove: name => classNames.delete(name)
        },
        appendChild(child) { this.children.push(child); },
        set innerHTML(value) {
            assert.equal(value, '');
            this.children = [];
        }
    };
    const pageData = { viewport, placeholder, rendered: false };
    let cleanupCount = 0;
    let renderArgs;
    const page = {
        render(args) {
            renderArgs = args;
            return { promise: Promise.resolve() };
        },
        cleanup() { cleanupCount++; }
    };
    const pdfDoc = { getPage: async pageNum => {
        assert.equal(pageNum, 1);
        return page;
    } };
    let builtTextLayer = 0;
    const { fn: renderSinglePage } = loadFunction('renderSinglePage', {
        pageElements: { 1: pageData },
        readerRenderGeneration: 9,
        pdfDoc,
        READER_MAX_CANVAS_PIXELS: cap,
        window: { devicePixelRatio: 2 },
        document: { createElement: tag => {
            assert.equal(tag, 'canvas');
            return makeCanvas();
        } },
        penMode: false,
        currentDoc: { id: 'doc-1' },
        createReaderDrawingState: () => ({ operations: [] }),
        getDocAnnotation: () => null,
        attachPenInteraction: () => {},
        renderPageNoteMarkers: () => {},
        renderedPages: new Set(),
        buildReaderTextLayer: () => { builtTextLayer++; },
        Image: class {}
    });

    await renderSinglePage(1);
    assert.equal(createdCanvases.length, 2, 'PDF and annotation canvases must both be created');
    for (const canvas of createdCanvases) {
        assert.equal(canvas.width, 2048);
        assert.equal(canvas.height, 2048);
        assert.equal(canvas.width * canvas.height, cap);
        assert.deepEqual(canvas.scales, [[0.5, 0.5]], 'the cap must be allowed to lower DPR below 1');
    }
    assert.equal(renderArgs.viewport, viewport);
    assert.equal(cleanupCount, 1);
    assert.equal(pageData.rendered, true);
    assert.equal(builtTextLayer, 1);
});

test('pending PDF render canvases are tracked and zeroed on stale, error, and global release paths', async () => {
    const renderSource = functionSource('renderSinglePage');
    const trackIndex = renderSource.indexOf('pageData.renderCanvas = canvas');
    assert.ok(trackIndex >= 0, 'renderSinglePage must retain the pre-DOM canvas');
    assert.ok(trackIndex < renderSource.indexOf('await page.render'), 'tracking must begin before PDF.js renders');
    assert.ok(trackIndex < renderSource.indexOf('placeholder.appendChild(canvas)'), 'tracking must begin before DOM insertion');

    function createPendingRenderHarness() {
        const gate = deferred();
        const canvases = [];
        const placeholder = {
            children: [],
            classList: { add() {}, remove() {} },
            appendChild(child) { this.children.push(child); },
            set innerHTML(value) {
                assert.equal(value, '');
                this.children = [];
            }
        };
        const pageData = {
            viewport: { width: 600, height: 800 },
            placeholder,
            rendered: false,
            renderCanvas: null
        };
        let cleanupCount = 0;
        const page = {
            render: () => ({ promise: gate.promise }),
            cleanup: () => { cleanupCount++; }
        };
        const pdfDoc = { getPage: async () => page };
        const { fn: renderSinglePage, context } = loadFunction('renderSinglePage', {
            pageElements: { 1: pageData },
            readerRenderGeneration: 1,
            pdfDoc,
            READER_MAX_CANVAS_PIXELS: 4 * 1024 * 1024,
            window: { devicePixelRatio: 1 },
            document: {
                createElement: tag => {
                    assert.equal(tag, 'canvas');
                    const canvas = new FakeEventTarget();
                    canvas.width = 0;
                    canvas.height = 0;
                    canvas.style = {};
                    canvas.dataset = {};
                    canvas.getContext = () => ({ scale() {} });
                    canvases.push(canvas);
                    return canvas;
                }
            },
            penMode: false,
            currentDoc: { id: 'doc-1' },
            createReaderDrawingState: () => ({ operations: [] }),
            getDocAnnotation: () => null,
            attachPenInteraction: () => {},
            renderPageNoteMarkers: () => {},
            renderedPages: new Set(),
            buildReaderTextLayer: () => {},
            Image: class {}
        });
        return {
            gate,
            canvases,
            placeholder,
            pageData,
            context,
            get cleanupCount() { return cleanupCount; },
            start: () => renderSinglePage(1)
        };
    }

    const stale = createPendingRenderHarness();
    const stalePromise = stale.start();
    await waitFor(() => stale.pageData.renderCanvas !== null, 'pending render canvas was not tracked');
    const staleCanvas = stale.pageData.renderCanvas;
    assert.equal(stale.placeholder.children.length, 0, 'pending canvas must not yet be in the DOM');
    assert.ok(staleCanvas.width > 0 && staleCanvas.height > 0);
    stale.context.readerRenderGeneration++;
    stale.gate.resolve();
    await stalePromise;
    assert.equal(staleCanvas.width, 0);
    assert.equal(staleCanvas.height, 0);
    assert.equal(stale.pageData.renderCanvas, null);
    assert.equal(stale.placeholder.children.length, 0);
    assert.equal(stale.cleanupCount, 1);

    const failed = createPendingRenderHarness();
    const failedPromise = failed.start();
    await waitFor(() => failed.pageData.renderCanvas !== null, 'failed render canvas was not tracked');
    const failedCanvas = failed.pageData.renderCanvas;
    failed.gate.reject(new Error('PDF render failed'));
    await assert.rejects(failedPromise, /PDF render failed/);
    assert.equal(failedCanvas.width, 0);
    assert.equal(failedCanvas.height, 0);
    assert.equal(failed.pageData.renderCanvas, null);
    assert.equal(failed.pageData.rendered, false);
    assert.equal(failed.cleanupCount, 1);

    const pendingCanvas = { width: 1200, height: 1600 };
    const domCanvas = { width: 600, height: 800 };
    const pendingPageData = {
        renderCanvas: pendingCanvas,
        placeholder: {
            querySelectorAll: selector => {
                assert.equal(selector, 'canvas');
                return [domCanvas];
            }
        }
    };
    const { fn: releaseAll } = loadFunction('releaseAllReaderCanvases', {
        pageElements: { 1: pendingPageData }
    });
    releaseAll();
    assert.equal(pendingCanvas.width, 0);
    assert.equal(pendingCanvas.height, 0);
    assert.equal(pendingPageData.renderCanvas, null);
    assert.equal(domCanvas.width, 0);
    assert.equal(domCanvas.height, 0);
});

test('reader lasso overlay and crop guard failed 2D context allocation', () => {
    const start = functionSource('einkSelectStart');
    const move = functionSource('einkSelectMove');
    const clear = functionSource('einkSelectClearOverlay');
    const crop = functionSource('einkCropPageRegion');

    assert.match(start, /const ctx\s*=\s*ov\.getContext\(['"]2d['"]\);\s*if\s*\(ctx\)\s*ctx\.clearRect/);
    assert.match(move, /const ctx\s*=\s*ov\.getContext\(['"]2d['"]\);\s*if\s*\(!ctx\)\s*return/);
    assert.match(clear, /const ctx\s*=\s*ov\.getContext\(['"]2d['"]\);\s*if\s*\(ctx\)\s*ctx\.clearRect/);
    assert.match(
        crop,
        /const ctx\s*=\s*crop\.getContext\(['"]2d['"]\);\s*if\s*\(!ctx\)\s*{[\s\S]*?crop\.width\s*=\s*0;[\s\S]*?crop\.height\s*=\s*0;[\s\S]*?return null;/
    );
});

test('releasing an offscreen reader page zeros every canvas backing store', () => {
    assert.match(functionSource('renderVisiblePagesPass'), /releaseReaderPage\(i\)/);
    assert.doesNotMatch(
        functionSource('releaseReaderPage'),
        /!drawingState\.baseReady/,
        'an offscreen page may release while its cancelable base image is still loading'
    );
    const pdfCanvas = { width: 1600, height: 2200, dataset: {} };
    const annotationCanvas = { width: 1600, height: 2200, dataset: { pageNum: '1' } };
    let replaced = 0;
    const classes = new Set(['pdf-page-wrapper']);
    const placeholder = {
        querySelectorAll: selector => {
            assert.equal(selector, 'canvas');
            return [pdfCanvas, annotationCanvas];
        },
        replaceChildren: () => { replaced++; },
        classList: {
            add: name => classes.add(name),
            remove: name => classes.delete(name)
        }
    };
    const pageData = {
        placeholder,
        rendered: true,
        renderingPromise: null,
        annoCanvas: annotationCanvas,
        annoCtx: {},
        textLayer: {}
    };
    let buttonUpdates = 0;
    let drawingResourceReleases = 0;
    let loaderSrc = 'persisted-drawing';
    const baseLoader = {
        onload: () => {},
        onerror: () => {},
        get src() { return loaderSrc; },
        set src(value) { loaderSrc = value; }
    };
    const insertedImage = {};
    const imageOperation = { type: 'image', image: insertedImage };
    const drawingState = {
        baseReady: false,
        pendingSave: false,
        baseLoader,
        baseImage: null,
        operations: [imageOperation],
        activeOperation: null
    };
    const { fn: releaseDrawingResources } = loadFunction('releaseReaderDrawingStateResources');
    const { fn: release, context } = loadFunction('releaseReaderPage', {
        pageElements: { 1: pageData },
        currentPage: 2,
        activePenStroke: null,
        renderedPages: new Set([1]),
        readerDrawingStates: new Map([[1, drawingState]]),
        strokeHistory: [{ pageNum: 1 }, { pageNum: 2 }],
        redoHistory: [{ pageNum: 1 }, { pageNum: 3 }],
        currentAnnoCanvas: annotationCanvas,
        currentAnnoCtx: {},
        releaseReaderDrawingStateResources: state => {
            assert.equal(state.baseReady, false);
            drawingResourceReleases++;
            releaseDrawingResources(state);
        },
        updateUndoRedoButtons: () => { buttonUpdates++; }
    });

    release(1);
    assert.equal(pdfCanvas.width, 0);
    assert.equal(pdfCanvas.height, 0);
    assert.equal(annotationCanvas.width, 0);
    assert.equal(annotationCanvas.height, 0);
    assert.equal(replaced, 1);
    assert.equal(pageData.rendered, false);
    assert.equal(pageData.annoCanvas, null);
    assert.equal(pageData.annoCtx, null);
    assert.equal(pageData.textLayer, null);
    assert.equal(context.renderedPages.has(1), false);
    assert.equal(context.readerDrawingStates.has(1), false);
    assert.deepEqual(context.strokeHistory.map(entry => entry.pageNum), [2]);
    assert.deepEqual(context.redoHistory.map(entry => entry.pageNum), [3]);
    assert.equal(context.currentAnnoCanvas, null);
    assert.equal(context.currentAnnoCtx, null);
    assert.equal(drawingResourceReleases, 1);
    assert.equal(drawingState.baseLoader, null);
    assert.equal(baseLoader.onload, null);
    assert.equal(baseLoader.onerror, null);
    assert.equal(loaderSrc, '', 'releasing the page must cancel the pending base image load');
    assert.equal(imageOperation.image, null);
    assert.equal(drawingState.operations.length, 0);
    assert.equal(buttonUpdates, 1);
    assert.equal(classes.has('pdf-page-placeholder'), true);
});

test('deep-page restore positions placeholders before rendering the visible window', async () => {
    const container = { scrollTop: 0 };
    const wrapper = {
        children: [],
        innerHTML: 'old reader canvases',
        appendChild(placeholder) {
            placeholder.offsetTop = this.children.length * 1000;
            placeholder.offsetHeight = 900;
            this.children.push(placeholder);
        }
    };
    const pdfDoc = {
        getPage: async () => ({
            getViewport: () => ({ width: 700, height: 900 })
        })
    };
    const scrollSamples = [];
    const order = [];
    const { fn: renderAllPDFPages, context } = loadFunction('renderAllPDFPages', {
        pdfDoc,
        isRenderingAllPages: false,
        readerRenderGeneration: 3,
        totalPages: 8,
        currentPage: 7,
        einkMode: false,
        renderedPages: new Set([1, 2]),
        pageElements: { stale: true },
        releaseAllReaderCanvases: () => { order.push('release-old'); },
        resetReaderInkHistory: () => { order.push('reset-history'); },
        getReaderRenderScale: () => 1,
        document: {
            getElementById: id => id === 'pdfCanvasWrapper' ? wrapper
                : id === 'readerContainer' ? container : null,
            createElement: tag => {
                assert.equal(tag, 'div');
                return { dataset: {}, style: {} };
            }
        },
        renderVisiblePages: async () => {
            order.push('render-visible');
            scrollSamples.push(container.scrollTop);
        },
        setupScrollListener: () => { order.push('setup-scroll'); },
        setupEinkReaderTapZones: () => {},
        einkShowPage: () => {}
    });

    await renderAllPDFPages();
    assert.deepEqual(order, [
        'release-old',
        'reset-history',
        'render-visible',
        'setup-scroll'
    ]);
    assert.deepEqual(scrollSamples, [5988]);
    assert.equal(
        context.pageElements[7].placeholder.offsetTop,
        6000,
        'the deep target placeholder must exist before visible canvases are allocated'
    );
    assert.equal(context.isRenderingAllPages, false);
});

test('a large scroll jump releases the old canvas window before allocating the new one', async () => {
    const order = [];
    const container = {
        scrollTop: 8000,
        getBoundingClientRect: () => ({ height: 1000 })
    };
    const pageElements = {
        1: {
            rendered: true,
            renderingPromise: null,
            placeholder: { offsetTop: 0, offsetHeight: 900 }
        },
        2: {
            rendered: false,
            renderingPromise: null,
            placeholder: { offsetTop: 8000, offsetHeight: 900 }
        }
    };
    const { fn: renderVisiblePagesPass } = loadFunction('renderVisiblePagesPass', {
        document: { getElementById: id => {
            assert.equal(id, 'readerContainer');
            return container;
        } },
        totalPages: 2,
        pageElements,
        releaseReaderPage: pageNum => {
            order.push(`release:${pageNum}`);
            pageElements[pageNum].rendered = false;
        },
        renderSinglePage: async pageNum => {
            order.push(`render:${pageNum}`);
            assert.equal(order[0], 'release:1');
            pageElements[pageNum].rendered = true;
        }
    });

    await renderVisiblePagesPass();
    assert.deepEqual(order.slice(0, 2), ['release:1', 'render:2']);
});

test('reader compaction releases an old IMG base and compacted image operations', () => {
    let oldImageSrc = 'data:image/png;base64,old-checkpoint';
    const oldImage = {
        tagName: 'IMG',
        onload: () => {},
        onerror: () => {},
        get src() { return oldImageSrc; },
        set src(value) { oldImageSrc = value; }
    };
    const compactedImages = [{}, {}, {}];
    const operations = [
        { type: 'image', image: compactedImages[0] },
        { type: 'image', image: compactedImages[1] },
        { type: 'image', image: compactedImages[2] },
        { type: 'stroke', points: [] },
        { type: 'stroke', points: [] }
    ];
    const compactedOperations = operations.slice(0, 3);
    const retainedOperations = operations.slice(3);
    const checkpointCtx = {
        scale() {},
        drawImage() {}
    };
    const checkpoint = {
        tagName: 'CANVAS',
        width: 0,
        height: 0,
        getContext: type => {
            assert.equal(type, '2d');
            return checkpointCtx;
        }
    };
    const state = {
        canvas: { width: 1200, height: 1600 },
        ctx: {},
        viewport: { width: 600, height: 800 },
        baseImage: oldImage,
        baseReady: true,
        baseLoadFailed: false,
        activeOperation: null,
        operations
    };
    let redraws = 0;
    let buttonUpdates = 0;
    const { fn: compact, context } = loadFunction('compactReaderDrawingState', {
        READER_INK_HISTORY_MAX: 2,
        document: {
            createElement: tag => {
                assert.equal(tag, 'canvas');
                return checkpoint;
            }
        },
        drawReaderOperation: () => {},
        strokeHistory: operations.map(operation => ({ operation })),
        redoHistory: operations.map(operation => ({ operation })),
        redrawReaderDrawingState: (target, includeActive) => {
            assert.equal(target, state);
            assert.equal(includeActive, false);
            redraws++;
        },
        updateUndoRedoButtons: () => { buttonUpdates++; }
    });

    compact(state);
    assert.equal(state.baseImage, checkpoint);
    assert.equal(checkpoint.width, 1200);
    assert.equal(checkpoint.height, 1600);
    assert.deepEqual(state.operations, retainedOperations);
    assert.ok(compactedImages.every((image, index) => compactedOperations[index].image === null));
    assert.equal(oldImage.onload, null);
    assert.equal(oldImage.onerror, null);
    assert.equal(oldImageSrc, '');
    assert.equal(context.strokeHistory.length, 2);
    assert.equal(context.redoHistory.length, 2);
    assert.equal(redraws, 1);
    assert.equal(buttonUpdates, 1);
});

test('saveData is metadata-only by default while blob mutations defer publication', () => {
    const saveSource = functionSource('saveData');
    assert.match(saveSource, /function saveData\s*\(blobDocId\s*=\s*false\)/);
    assert.match(saveSource, /if\s*\(blobDocId\s*!==\s*false\)/);

    const targetedCallers = [
        ['saveDrawingForPage', /saveData\(currentDoc\.id\)/],
        ['deleteDocAnnotation', /saveData\(docId\)/],
        ['saveDraft', /saveData\(canvasChanged\s*\?\s*currentDoc\.id\s*:\s*false\)/]
    ];
    for (const [name, pattern] of targetedCallers) {
        assert.match(functionSource(name), pattern, `${name} must queue only its mutated document`);
    }
    assert.match(
        functionSource('addDocAiComment'),
        /saveData\(false\)/,
        'a text-only AI note must not start an annotation PNG transaction'
    );

    for (const name of ['updateCurrentPageFromScroll', 'scrollToPage', 'einkShowPage']) {
        const source = functionSource(name);
        assert.match(source, /saveData\(false\)/, `${name} must persist progress as metadata only`);
        assert.doesNotMatch(source, /saveData\(\s*\)/);
    }

    const queued = [];
    const savedMetadata = [];
    const appData = {
        books: [{ id: 'doc-a', annotations: [] }],
        papers: [],
        archived: [],
        drafts: {},
        classroom: { courses: [], seminars: [] },
        settings: {}
    };
    const loaded = loadFunctions([
        'markBlobMetadataPending',
        'blobMetadataCommitIsPending',
        'saveData'
    ], {
        appData,
        ensureDocumentAnnotationBlobIds: () => {},
        _annotationBlobRestoreFinished: true,
        _annotationBlobBlockedDocIds: new Set(),
        _draftBlobBlockedDocIds: new Set(),
        _annotationBlobDeletedDocIds: new Set(),
        _blobDeletionCleanupReadyDocIds: new Set(),
        _blobMetadataGenerationSequence: 0,
        _blobMetadataPendingVersions: new Map(),
        _blobMetadataSaveDeferred: false,
        _blobFailureFallbackActive: false,
        _forceInlineBlobMetadataSave: false,
        _blobSaveInFlight: false,
        _blobSaveQueued: false,
        _blobSaveRetryTimer: null,
        blobMetadataCommitIsPending: () => false,
        stripBlobsFromSaveData: () => {},
        localStorage: {
            setItem: (key, value) => { savedMetadata.push({ key, value }); }
        },
        queueBlobsSaveToIDB: docId => { queued.push(docId); },
        backupAppDataToIDB: () => {},
        showToast: () => {},
        i18n: key => key,
        console: { error: () => {} }
    });
    const saveData = loaded.functions.saveData;

    assert.equal(saveData(false), true);
    assert.deepEqual(queued, [], 'ordinary and progress saves must not queue annotation blobs');
    assert.equal(savedMetadata.length, 1);
    assert.equal(saveData('doc-a'), true);
    assert.deepEqual(queued, ['doc-a']);
    assert.equal(savedMetadata.length, 1, 'blob-changing saves publish nothing before IDB commits');
    assert.equal(loaded.context._blobMetadataPendingVersions.has('doc-a'), true);
    assert.equal(loaded.context._blobMetadataSaveDeferred, true);
});

test('annotation blob persistence is single-flight and coalesces rapid saves', async () => {
    assert.match(functionSource('saveData'), /queueBlobsSaveToIDB\(\)/);
    assert.doesNotMatch(functionSource('saveData'), /(?<!queue)saveBlobsToIDB\(\)/);

    const gates = [];
    let active = 0;
    let maxActive = 0;
    const saveBlobsToIDB = async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.push(gate);
        try {
            await gate.promise;
        } finally {
            active--;
        }
    };
    const { fn: queue, context } = loadFunction('queueBlobsSaveToIDB', {
        _blobSaveInFlight: false,
        _blobSaveQueued: false,
        _blobSaveAllQueued: false,
        _blobSaveQueuedDocIds: new Set(),
        _blobSaveRetryTimer: null,
        _blobSaveRetryDelay: 3000,
        _blobSaveFailureNotified: false,
        _blobMetadataPendingVersions: new Map(),
        saveBlobsToIDB,
        flushDeferredBlobMetadataSave: () => {},
        console: { warn: () => {} },
        clearTimeout: () => {},
        setTimeout: () => 1,
        showToast: () => {},
        i18n: key => key
    });

    queue();
    queue();
    queue();
    assert.equal(gates.length, 1, 'only one IndexedDB serialization may start immediately');
    assert.equal(active, 1);

    gates[0].resolve();
    await waitFor(() => gates.length === 2, 'queued latest save did not start');
    assert.equal(active, 1);
    assert.equal(maxActive, 1, 'annotation blob saves must never overlap');

    gates[1].resolve();
    await waitFor(() => context._blobSaveInFlight === false, 'single-flight save did not settle');
    assert.equal(gates.length, 2, 'rapid duplicate requests must coalesce into one trailing save');
    assert.equal(context._blobSaveQueued, false);
    assert.equal(active, 0);
});

test('targeted blob retry preserves dirty document ids without escalating to the full library', async () => {
    const attempts = [];
    let retryCallback = null;
    let retryDelay = null;
    const saveBlobsToIDB = async targetDocIds => {
        attempts.push(targetDocIds === null ? null : [...targetDocIds].sort());
        if (attempts.length === 1) throw new Error('transient IDB failure');
    };
    const { fn: queue, context } = loadFunction('queueBlobsSaveToIDB', {
        _blobSaveInFlight: false,
        _blobSaveQueued: false,
        _blobSaveAllQueued: false,
        _blobSaveQueuedDocIds: new Set(),
        _blobSaveRetryTimer: null,
        _blobSaveRetryDelay: 3000,
        _blobSaveFailureNotified: false,
        _blobMetadataPendingVersions: new Map(),
        saveBlobsToIDB,
        flushDeferredBlobMetadataSave: () => {},
        console: { warn: () => {} },
        setTimeout: (callback, delay) => {
            retryCallback = callback;
            retryDelay = delay;
            return 77;
        },
        showToast: () => {},
        i18n: key => key
    });

    queue('doc-a');
    await waitFor(() => retryCallback !== null, 'targeted failure did not schedule a retry');
    assert.deepEqual(attempts, [['doc-a']]);
    assert.equal(retryDelay, 3000);
    assert.equal(context._blobSaveAllQueued, false);
    assert.deepEqual([...context._blobSaveQueuedDocIds], ['doc-a']);

    queue('doc-b');
    assert.equal(attempts.length, 1, 'the retry timer must own the next write attempt');
    assert.equal(context._blobSaveAllQueued, false);
    assert.deepEqual([...context._blobSaveQueuedDocIds].sort(), ['doc-a', 'doc-b']);

    retryCallback();
    await waitFor(
        () => attempts.length === 2 && context._blobSaveInFlight === false,
        'targeted retry did not settle'
    );
    assert.deepEqual(attempts, [['doc-a'], ['doc-a', 'doc-b']]);
    assert.equal(attempts.includes(null), false, 'a targeted failure must never become a full-library save');
    assert.equal(context._blobSaveAllQueued, false);
    assert.equal(context._blobSaveQueuedDocIds.size, 0);
    assert.equal(context._blobSaveRetryDelay, 3000);
});

test('first drawing and draft blob commits block every metadata-only save until IDB resolves', async () => {
    const cases = [
        {
            name: 'drawing',
            docId: 'drawing-doc',
            appData: {
                books: [{
                    id: 'drawing-doc',
                    title: 'Drawing',
                    annotations: [{ page: 1, type: 'drawing', data: 'first-drawing-png' }]
                }],
                papers: [], archived: [], drafts: {},
                classroom: { courses: [], seminars: [] }, settings: {}
            }
        },
        {
            name: 'draft',
            docId: 'draft-doc',
            appData: {
                books: [], papers: [], archived: [],
                drafts: {
                    'draft-doc': { html: 'draft', canvas: 'first-draft-png', _hasCanvasData: true }
                },
                classroom: { courses: [], seminars: [] }, settings: {}
            }
        }
    ];

    for (const item of cases) {
        const gate = deferred();
        let puts = 0;
        const harness = createBlobFirstHarness({
            appData: item.appData,
            saveBlobsToIDB: async targetDocIds => {
                puts++;
                assert.deepEqual([...targetDocIds], [item.docId]);
                await gate.promise;
            }
        });

        assert.equal(harness.functions.saveData(item.docId), true, item.name);
        assert.equal(puts, 1, `${item.name}: first IDB put must start immediately`);
        item.appData.settings.changedWhilePending = item.name;
        assert.equal(harness.functions.saveData(false), true, item.name);
        assert.equal(harness.functions.saveData(false), true, item.name);
        assert.equal(
            harness.metadata.length,
            0,
            `${item.name}: localStorage must remain untouched while the first payload is pending`
        );

        gate.resolve();
        await waitFor(
            () => harness.context._blobSaveInFlight === false && harness.metadata.length === 1,
            `${item.name}: deferred metadata did not flush after IDB committed`
        );
        assert.equal(harness.metadata[0].settings.changedWhilePending, item.name);
    }
});

test('a newer blob generation prevents the older commit from publishing metadata', async () => {
    const appData = {
        books: [{
            id: 'doc-generation',
            title: 'generation-one',
            annotations: [{ page: 1, type: 'drawing', data: 'png-generation-one' }]
        }],
        papers: [], archived: [], drafts: {
            'failed-doc': { html: '', canvas: 'uncommitted-draft-png', _hasCanvasData: true }
        },
        classroom: { courses: [], seminars: [] }, settings: {}
    };
    const gates = [];
    const committedSnapshots = [];
    const harness = createBlobFirstHarness({
        appData,
        saveBlobsToIDB: async () => {
            committedSnapshots.push(appData.books[0].annotations[0].data);
            const gate = deferred();
            gates.push(gate);
            await gate.promise;
        }
    });

    harness.functions.saveData('doc-generation');
    assert.equal(gates.length, 1);
    appData.books[0].title = 'generation-two';
    appData.books[0].annotations[0].data = 'png-generation-two';
    harness.functions.saveData('doc-generation');
    harness.functions.saveData(false);
    assert.equal(harness.metadata.length, 0);

    gates[0].resolve();
    await waitFor(() => gates.length === 2, 'the newer generation was not committed');
    assert.equal(harness.metadata.length, 0, 'generation one must not publish generation-two metadata');
    assert.equal(harness.context._blobMetadataPendingVersions.has('doc-generation'), true);

    gates[1].resolve();
    await waitFor(
        () => harness.context._blobSaveInFlight === false && harness.metadata.length === 1,
        'metadata did not flush after the newest generation committed'
    );
    assert.deepEqual(committedSnapshots, [
        'png-generation-one',
        'png-generation-two'
    ]);
    assert.equal(harness.metadata[0].books[0].title, 'generation-two');
    assert.equal(harness.context._blobMetadataPendingVersions.size, 0);
});

test('a failed blob put publishes only inline fallback metadata with the pending payload', async () => {
    const appData = {
        books: [{
            id: 'failed-doc',
            annotations: [{ page: 1, type: 'drawing', data: 'uncommitted-png' }]
        }],
        papers: [], archived: [],
        drafts: { 'failed-doc': { html: '', canvas: 'uncommitted-draft-png', _hasCanvasData: true } },
        classroom: { courses: [], seminars: [] }, settings: {}
    };
    let retryCallback = null;
    const harness = createBlobFirstHarness({
        appData,
        saveBlobsToIDB: async () => { throw new Error('IDB put failed'); },
        setTimeoutImpl: callback => {
            retryCallback = callback;
            return 45;
        }
    });

    harness.functions.saveData('failed-doc');
    await waitFor(() => retryCallback !== null, 'failed put did not enter retry state');
    assert.equal(harness.context._blobSaveInFlight, false);
    assert.equal(harness.context._blobMetadataPendingVersions.has('failed-doc'), true);
    assert.equal(harness.metadata.length, 0);
    assert.equal(harness.functions.saveBlobFailureFallbackMetadata(), true);
    assert.equal(harness.metadata.length, 1);
    assert.equal(
        harness.metadata[0].books[0].annotations[0].data,
        'uncommitted-png',
        'fallback metadata must retain the drawing payload while its IDB generation is pending'
    );
    assert.equal(harness.metadata[0].drafts['failed-doc'].canvas, 'uncommitted-draft-png');
    harness.functions.saveData(false);
    assert.equal(harness.metadata.length, 2);
    assert.equal(harness.metadata[1].books[0].annotations[0].data, 'uncommitted-png');
    assert.equal(harness.metadata[1].drafts['failed-doc'].canvas, 'uncommitted-draft-png');
    assert.equal(harness.context._blobMetadataSaveDeferred, true);
});

test('v2 annotation blobs use stable ids and never restore across deletion or reorder', async () => {
    const writes = [];
    const stableId = annotation => {
        if (!annotation._blobId) annotation._blobId = `generated-${annotation.page}-${annotation.type}`;
        return annotation._blobId;
    };
    const { fn: saveAnnotationBlobsToIDB } = loadFunction('saveAnnotationBlobsToIDB', {
        ensureAnnotationBlobId: stableId,
        annoKey: docId => `annotations_${docId}`,
        saveFileData: async (key, value) => { writes.push({ key, value }); }
    });
    const drawing = {
        _blobId: 'drawing-id', page: 2, type: 'drawing', data: 'durable-drawing'
    };
    const oldNote = {
        _blobId: 'old-note-id', page: 1, type: 'note', canvasData: 'old-note-canvas'
    };

    await saveAnnotationBlobsToIDB('doc-1', [oldNote, drawing]);
    assert.equal(writes.length, 1);
    const saved = writes[0].value;
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.entries.map(entry => entry.id), ['old-note-id', 'drawing-id']);
    assert.equal(saved.entries[0].canvasData, 'old-note-canvas');
    assert.equal(saved.entries[1].data, 'durable-drawing');

    const replacementNote = {
        _blobId: 'new-note-id', page: 1, type: 'note', _hasCanvasData: true
    };
    const reorderedDrawing = {
        _blobId: 'drawing-id', page: 2, type: 'drawing'
    };
    const { fn: restoreAnnotationBlobsFromIDB } = loadFunction('restoreAnnotationBlobsFromIDB', {
        annoKey: docId => `annotations_${docId}`,
        getFileData: async () => writes[0].value,
        console: { warn: () => {} }
    });
    await restoreAnnotationBlobsFromIDB('doc-1', [replacementNote, reorderedDrawing]);
    assert.equal(
        replacementNote.canvasData,
        undefined,
        'the deleted note blob must not attach to a new note occupying its old index'
    );
    assert.equal(
        reorderedDrawing.data,
        'durable-drawing',
        'stable id lookup must restore the drawing even after its array index changes'
    );

    await saveAnnotationBlobsToIDB('doc-1', []);
    assert.equal(writes.length, 2, 'an empty annotation set must still overwrite the old IDB record');
    assert.equal(writes[1].value.version, 2);
    assert.equal(writes[1].value.entries.length, 0);
});

test('genuinely missing annotation payloads degrade safely while strict storage outages stay blocked', async () => {
    const reads = [];
    const loaded = loadFunctions([
        'discardMissingAnnotationBlobMetadata',
        'restoreAnnotationBlobsFromIDB'
    ], {
        annoKey: docId => `annotations_${docId}`,
        _orphanBlobMetadataRecovered: false,
        getFileData: async (key, strict) => {
            reads.push([key, strict]);
            if (key === 'annotations_unavailable') throw new Error('IndexedDB unavailable');
            return null;
        },
        console: { warn: () => {} }
    });
    const restore = loaded.functions.restoreAnnotationBlobsFromIDB;

    const orphaned = [
        { page: 1, type: 'drawing', _blobId: 'drawing-id' },
        { page: 2, type: 'note', text: 'keep marker', _blobId: 'note-id', _hasCanvasData: true }
    ];
    assert.equal(await restore('genuinely-missing', orphaned), true);
    assert.equal(orphaned.length, 1, 'an irrecoverable drawing marker must be removed');
    assert.equal(orphaned[0].type, 'note');
    assert.equal(orphaned[0].text, 'keep marker');
    assert.equal(Object.hasOwn(orphaned[0], '_hasCanvasData'), false);
    assert.equal(loaded.context._orphanBlobMetadataRecovered, true);

    const unavailable = [{ page: 4, type: 'drawing', _blobId: 'blocked-drawing' }];
    assert.equal(await restore('unavailable', unavailable), false);
    assert.equal(unavailable.length, 1, 'an unavailable DB must not be mistaken for a missing record');
    assert.equal(
        await restore('legacy-inline', [
            { page: 1, type: 'drawing', data: 'inline-drawing' },
            { page: 2, type: 'note', _hasCanvasData: true, canvasData: 'inline-note-canvas' }
        ]),
        true,
        'complete legacy inline blobs remain authoritative when no IDB record exists'
    );
    assert.equal(reads.length, 3);
    reads.forEach(([, strict]) => assert.equal(strict, true, 'annotation hydration must use a strict IDB read'));
});

test('annotation tombstones use strict deletes and survive a failed delete pass', async () => {
    const tombstones = new Set(['deleted-doc']);
    const calls = [];
    let failDraftDelete = true;
    const { fn: saveBlobsToIDB, context } = loadFunction('saveBlobsToIDB', {
        appData: { books: [], papers: [], archived: [], drafts: {} },
        _annotationBlobRestoreFinished: true,
        _annotationBlobBlockedDocIds: new Set(),
        _annotationBlobDeletedDocIds: tombstones,
        _blobDeletionCleanupReadyDocIds: new Set(['deleted-doc']),
        _draftBlobBlockedDocIds: new Set(),
        saveAnnotationBlobsToIDB: async () => {},
        restoreAnnotationBlobsFromIDB: async () => true,
        saveScreenshotToIDB: async () => {},
        saveDraftCanvasToIDB: async () => {},
        deleteFileData: async (key, strict) => {
            calls.push([key, strict]);
            if (failDraftDelete && key === 'draft_deleted-doc') {
                throw new Error('strict delete failed');
            }
        },
        annoKey: id => `annotations_${id}`,
        draftCanvasKey: id => `draft_${id}`,
        screenshotKey: id => `screenshot_${id}`
    });

    await assert.rejects(saveBlobsToIDB(), /strict delete failed/);
    assert.deepEqual(calls, [
        ['deleted-doc', true],
        ['annotations_deleted-doc', true],
        ['draft_deleted-doc', true]
    ]);
    assert.equal(
        context._annotationBlobDeletedDocIds.has('deleted-doc'),
        true,
        'a partial delete pass must retain the tombstone for retry'
    );

    failDraftDelete = false;
    calls.length = 0;
    await saveBlobsToIDB();
    assert.deepEqual(calls, [
        ['deleted-doc', true],
        ['annotations_deleted-doc', true],
        ['draft_deleted-doc', true],
        ['screenshot_deleted-doc', true]
    ]);
    assert.equal(context._annotationBlobDeletedDocIds.has('deleted-doc'), false);
});

test('document deletion commits metadata before making its IDB cleanup eligible', () => {
    const appData = {
        books: [{ id: 'delete-me', annotations: [] }], papers: [], archived: [], drafts: {},
        classroom: { courses: [], seminars: [] }, settings: {}
    };
    const order = [];
    const loaded = loadFunctions([
        'stripBlobsFromSaveData',
        'blobMetadataCommitIsPending',
        'saveData',
        'deleteItem'
    ], {
        appData,
        _annotationBlobRestoreFinished: true,
        _annotationBlobBlockedDocIds: new Set(),
        _draftBlobBlockedDocIds: new Set(),
        _annotationBlobDeletedDocIds: new Set(),
        _blobDeletionCleanupReadyDocIds: new Set(),
        _blobMetadataPendingVersions: new Map(),
        _blobMetadataSaveDeferred: false,
        _blobFailureFallbackActive: false,
        _forceInlineBlobMetadataSave: false,
        _blobSaveInFlight: false,
        _blobSaveQueued: false,
        _blobSaveRetryTimer: null,
        blobMetadataCommitIsPending: () => false,
        ensureDocumentAnnotationBlobIds: () => {},
        localStorage: { setItem: (key, value) => {
            order.push('metadata');
            assert.equal(JSON.parse(value).books.length, 0);
        } },
        queueBlobsSaveToIDB: () => {
            order.push('cleanup-ready');
            assert.equal(loaded.context._blobDeletionCleanupReadyDocIds.has('delete-me'), true);
        },
        backupAppDataToIDB: () => {},
        closeLongPressMenu: () => {},
        confirm: () => true,
        renderLibrary: () => {},
        showToast: () => {},
        i18n: key => key,
        triggerSyncOnFileChange: () => {},
        console: { error: () => {} }
    });
    loaded.functions.deleteItem('delete-me', 'book');
    assert.deepEqual(order, ['metadata', 'cleanup-ready']);
});

test('startup saves cannot erase annotation blobs before IndexedDB restore finishes', async () => {
    const initSource = functionSource('init');
    assert.ok(
        initSource.indexOf('await restoreBlobsFromIDB()') < initSource.indexOf('await migrateAnnotationsToIDB()'),
        'legacy IDB blobs must be restored before the stable-id migration writes anything'
    );
    const migrationSource = functionSource('migrateAnnotationsToIDB');
    assert.match(migrationSource, /!_annotationBlobBlockedDocIds\.has\(doc\.id\)/);
    assert.match(migrationSource, /_annotationBlobBlockedDocIds\.add\(doc\.id\)/);

    let annotationWrites = 0;
    const appData = {
        books: [{ id: 'doc-1', annotations: [{ page: 2, type: 'drawing', _blobId: 'drawing-id' }] }],
        papers: [],
        archived: [],
        drafts: {}
    };
    const { fn: saveBlobsToIDB, context } = loadFunction('saveBlobsToIDB', {
        appData,
        _annotationBlobRestoreFinished: false,
        _annotationBlobBlockedDocIds: new Set(),
        _annotationBlobDeletedDocIds: new Set(),
        _blobDeletionCleanupReadyDocIds: new Set(),
        _draftBlobBlockedDocIds: new Set(),
        saveAnnotationBlobsToIDB: async () => { annotationWrites++; },
        restoreAnnotationBlobsFromIDB: async () => true,
        saveScreenshotToIDB: async () => {},
        saveDraftCanvasToIDB: async () => {},
        getDraftCanvasFromIDB: async () => null,
        saveData: () => true,
        deleteFileData: async () => {},
        annoKey: id => `annotations_${id}`,
        draftCanvasKey: id => `draft_${id}`,
        screenshotKey: id => `screenshot_${id}`
    });

    await saveBlobsToIDB();
    assert.equal(annotationWrites, 0, 'metadata-only startup state must not overwrite durable blobs');

    context._annotationBlobRestoreFinished = true;
    await saveBlobsToIDB();
    assert.equal(annotationWrites, 1, 'authoritative state may save after restore completes');
});

test('blocked annotation migration keeps inline data through saveData stash and strip phases', () => {
    const blockedDrawing = {
        page: 1, type: 'drawing', data: 'blocked-drawing-png'
    };
    const blockedNote = {
        page: 2, type: 'note', canvasData: 'blocked-note-canvas'
    };
    const unblockedDrawing = {
        page: 1, type: 'drawing', data: 'durable-drawing-png'
    };
    const unblockedNote = {
        page: 2, type: 'note', canvasData: 'durable-note-canvas'
    };
    const appData = {
        books: [
            { id: 'blocked-doc', annotations: [blockedDrawing, blockedNote] },
            { id: 'ready-doc', annotations: [unblockedDrawing, unblockedNote] }
        ],
        papers: [],
        archived: [],
        drafts: {},
        classroom: { courses: [], seminars: [] },
        settings: {}
    };
    let savedProjection = null;
    let queueCount = 0;
    const context = vm.createContext({
        appData,
        _annotationBlobRestoreFinished: true,
        _annotationBlobBlockedDocIds: new Set(['blocked-doc']),
        _draftBlobBlockedDocIds: new Set(),
        _annotationBlobDeletedDocIds: new Set(),
        _blobDeletionCleanupReadyDocIds: new Set(),
        _blobMetadataSaveDeferred: false,
        _blobMetadataPendingVersions: new Map(),
        _blobFailureFallbackActive: false,
        _forceInlineBlobMetadataSave: false,
        _blobSaveInFlight: false,
        _blobSaveQueued: false,
        _blobSaveRetryTimer: null,
        blobMetadataCommitIsPending: () => false,
        ensureDocumentAnnotationBlobIds: () => {},
        localStorage: {
            setItem: (key, value) => {
                assert.equal(key, 'mathReader');
                savedProjection = JSON.parse(value);
            }
        },
        queueBlobsSaveToIDB: () => { queueCount++; },
        backupAppDataToIDB: () => {},
        showToast: () => {},
        i18n: key => key,
        console: { error: () => {} }
    });
    vm.runInContext(
        `${functionSource('stripBlobsFromSaveData')}\n`
            + `${functionSource('saveData')}\n`
            + 'this.__saveData = saveData;',
        context
    );

    assert.equal(context.__saveData(), true);
    assert.equal(queueCount, 0, 'metadata-only save must not queue blobs while migration is blocked');
    const blockedProjection = savedProjection.books.find(doc => doc.id === 'blocked-doc');
    const readyProjection = savedProjection.books.find(doc => doc.id === 'ready-doc');
    assert.equal(blockedProjection.annotations[0].data, 'blocked-drawing-png');
    assert.equal(blockedProjection.annotations[1].canvasData, 'blocked-note-canvas');
    assert.equal(readyProjection.annotations[0].data, undefined);
    assert.equal(readyProjection.annotations[1].canvasData, undefined);
    assert.equal(readyProjection.annotations[1]._hasCanvasData, true);

    assert.equal(blockedDrawing.data, 'blocked-drawing-png');
    assert.equal(blockedNote.canvasData, 'blocked-note-canvas');
    assert.equal(unblockedDrawing.data, 'durable-drawing-png');
    assert.equal(unblockedNote.canvasData, 'durable-note-canvas');
    assert.equal(Object.hasOwn(unblockedNote, '_hasCanvasData'), false);
});

test('draft base and history image loads close the input gate until their pixels are ready', () => {
    const source = [
        functionSource('handleDraftTouchStart'),
        functionSource('startDraftDraw')
    ].join('\n');
    assert.match(source, /canEditDraftCanvas\(currentDoc\.id\)/);

    const baseImages = [];
    class BaseImage {
        constructor() {
            this._src = '';
            this.requestedSrc = '';
            baseImages.push(this);
        }
        get src() { return this._src; }
        set src(value) {
            this._src = value;
            if (value) this.requestedSrc = value;
        }
    }
    const baseCanvas = {
        width: 3000,
        height: 3000,
        toDataURL: () => 'data:image/png;base64,loaded-baseline'
    };
    const baseDraws = [];
    const baseCtx = {
        setTransform() {},
        clearRect() {},
        drawImage(image) { baseDraws.push(image.requestedSrc); }
    };
    const baseLoaded = loadFunctions([
        'cancelDraftCanvasImageLoader',
        'canEditDraftCanvas',
        'captureDraftHistoryBaseline',
        'loadDraftCanvasData'
    ], {
        currentDoc: { id: 'base-doc' },
        appData: {
            drafts: {
                'base-doc': { _hasCanvasData: true, canvas: 'data:image/png;base64,durable-base' }
            }
        },
        draftCanvas: baseCanvas,
        draftCtx: baseCtx,
        draftCanvasDocId: 'base-doc',
        draftCanvasReady: true,
        draftCanvasImageLoader: null,
        draftCanvasDirty: false,
        draftHistory: [],
        draftHistoryIndex: -1,
        draftHistoryLoadGeneration: 0,
        _annotationBlobRestoreFinished: true,
        _draftBlobBlockedDocIds: new Set(),
        queueBlobsSaveToIDB: () => {},
        resizeDraftCanvas: () => {},
        resetDraftCanvasForDocument: () => {},
        showToast: () => {},
        i18n: key => key,
        Image: BaseImage
    });
    baseLoaded.functions.loadDraftCanvasData();
    assert.equal(baseLoaded.context.draftCanvasReady, false);
    assert.equal(
        baseLoaded.functions.canEditDraftCanvas('base-doc', false),
        false,
        'drawing must remain blocked while the durable base PNG is decoding'
    );
    assert.equal(baseImages.length, 1);
    const finishBaseLoad = baseImages[0].onload;
    finishBaseLoad();
    assert.equal(baseLoaded.context.draftCanvasReady, true);
    assert.deepEqual(baseDraws, ['data:image/png;base64,durable-base']);
    assert.deepEqual([...baseLoaded.context.draftHistory], [
        'data:image/png;base64,loaded-baseline'
    ]);

    const historyImages = [];
    class HistoryImage {
        constructor() {
            this._src = '';
            this.requestedSrc = '';
            historyImages.push(this);
        }
        get src() { return this._src; }
        set src(value) {
            this._src = value;
            if (value) this.requestedSrc = value;
        }
    }
    const serializedStates = [
        'data:image/png;base64,blank-base',
        'data:image/png;base64,first-stroke'
    ];
    const historyDraws = [];
    const historyCanvas = {
        width: 3000,
        height: 3000,
        toDataURL: () => serializedStates.shift()
    };
    const historyCtx = {
        setTransform() {},
        clearRect() { historyDraws.push('clear'); },
        drawImage(image) { historyDraws.push(`draw:${image.requestedSrc}`); },
        putImageData() { throw new Error('PNG history must not use raw pixel snapshots'); }
    };
    const historyLoaded = loadFunctions([
        'cancelDraftCanvasImageLoader',
        'canEditDraftCanvas',
        'captureDraftHistoryBaseline',
        'loadDraftCanvasData',
        'saveDraftCanvasState',
        'draftUndo',
        'loadDraftHistoryState',
        'debouncedSaveDraft'
    ], {
        currentDoc: { id: 'history-doc' },
        appData: { drafts: { 'history-doc': { html: '', canvas: null } } },
        draftCanvas: historyCanvas,
        draftCtx: historyCtx,
        draftCanvasDocId: 'history-doc',
        draftCanvasReady: false,
        draftCanvasImageLoader: null,
        draftCanvasDirty: false,
        draftHistory: [],
        draftHistoryIndex: -1,
        draftHistoryLoadGeneration: 0,
        _annotationBlobRestoreFinished: true,
        _draftBlobBlockedDocIds: new Set(),
        _draftSaveTimer: null,
        DRAFT_HISTORY_MAX: 10,
        queueBlobsSaveToIDB: () => {},
        resizeDraftCanvas: () => {},
        resetDraftCanvasForDocument: () => {},
        saveDraft: () => {},
        saveData: () => true,
        document: { getElementById: () => null },
        setTimeout: () => 91,
        clearTimeout: () => {},
        showToast: () => {},
        i18n: key => key,
        Image: HistoryImage
    });
    historyLoaded.functions.loadDraftCanvasData();
    assert.equal(historyLoaded.context.draftHistoryIndex, 0);
    assert.deepEqual([...historyLoaded.context.draftHistory], [
        'data:image/png;base64,blank-base'
    ]);

    historyLoaded.functions.saveDraftCanvasState();
    assert.equal(historyLoaded.context.draftHistoryIndex, 1);
    assert.deepEqual([...historyLoaded.context.draftHistory], [
        'data:image/png;base64,blank-base',
        'data:image/png;base64,first-stroke'
    ]);
    historyDraws.length = 0;
    historyLoaded.functions.draftUndo();
    assert.equal(historyLoaded.context.draftHistoryIndex, 0);
    assert.equal(historyLoaded.context.draftCanvasReady, false);
    assert.equal(
        historyLoaded.functions.canEditDraftCanvas('history-doc', false),
        false,
        'a second stroke must not race an asynchronous undo image load'
    );
    assert.equal(historyImages.length, 1);
    const finishHistoryLoad = historyImages[0].onload;
    finishHistoryLoad();
    assert.equal(historyLoaded.context.draftCanvasReady, true);
    assert.deepEqual(historyDraws, [
        'clear',
        'draw:data:image/png;base64,blank-base'
    ], 'the first undo must restore the captured baseline instead of leaving an empty canvas');
});

test('draft undo history is bounded PNG data and never captures full-page ImageData', () => {
    const historySource = [
        functionSource('captureDraftHistoryBaseline'),
        functionSource('saveDraftCanvasState')
    ].join('\n');
    assert.doesNotMatch(historySource, /\bgetImageData\s*\(/);
    assert.match(functionSource('saveDraftCanvasState'), /toDataURL\(['"]image\/png['"]\)/);

    let sequence = 0;
    const canvas = {
        toDataURL: () => `data:image/png;base64,state-${++sequence}`,
        getImageData() { throw new Error('raw draft snapshot attempted'); }
    };
    const { fn: saveDraftCanvasState, context } = loadFunction('saveDraftCanvasState', {
        currentDoc: { id: 'bounded-doc' },
        draftCanvas: canvas,
        draftCtx: {},
        draftCanvasDirty: false,
        draftHistory: ['data:image/png;base64,baseline'],
        draftHistoryIndex: 0,
        draftHistoryLoadGeneration: 0,
        DRAFT_HISTORY_MAX: 10,
        canEditDraftCanvas: () => true,
        showToast: () => {},
        i18n: key => key
    });
    for (let i = 0; i < 25; i++) saveDraftCanvasState();
    assert.equal(context.draftHistory.length, 10);
    assert.equal(context.draftHistoryIndex, 9);
    assert.equal(context.draftHistory[0], 'data:image/png;base64,state-16');
    assert.equal(context.draftHistory[9], 'data:image/png;base64,state-25');
    assert.ok([...context.draftHistory].every(state => state.startsWith('data:image/png')));
});

test('draft canvas genuine absence unlocks blank state while strict unavailability stays blocked', async () => {
    const appData = {
        books: [],
        papers: [],
        archived: [],
        drafts: {
            'missing-draft': { html: '', _hasCanvasData: true },
            'unavailable-draft': { html: '', _hasCanvasData: true }
        }
    };
    const draftBlocked = new Set();
    const strictReads = [];
    const metadataSaves = [];
    let flushes = 0;
    const restored = loadFunction('restoreBlobsFromIDB', {
        appData,
        _annotationBlobRestoreFinished: true,
        _annotationBlobBlockedDocIds: new Set(),
        _draftBlobBlockedDocIds: draftBlocked,
        _blobDeletionCleanupReadyDocIds: new Set(),
        restoreAnnotationBlobsFromIDB: async () => true,
        hydrateBlobDeletionTombstones: () => {},
        getScreenshotFromIDB: async () => null,
        getDraftCanvasFromIDB: async (docId, strict) => {
            strictReads.push([docId, strict]);
            if (docId === 'unavailable-draft') throw new Error('IndexedDB unavailable');
            return null;
        },
        saveData: mode => { metadataSaves.push(mode); return true; },
        flushDeferredBlobMetadataSave: () => { flushes++; },
        queueBlobsSaveToIDB: () => {}
    });
    await restored.fn();
    assert.deepEqual(strictReads, [
        ['missing-draft', true],
        ['unavailable-draft', true]
    ]);
    assert.equal(restored.context._annotationBlobRestoreFinished, true);
    assert.equal(Object.hasOwn(appData.drafts['missing-draft'], '_hasCanvasData'), false);
    assert.equal(draftBlocked.has('missing-draft'), false);
    assert.equal(appData.drafts['unavailable-draft']._hasCanvasData, true);
    assert.equal(draftBlocked.has('unavailable-draft'), true);
    assert.deepEqual(metadataSaves, [false]);
    assert.equal(flushes, 1);
});

test('drawing annotation updates replace the existing array slot in place', () => {
    const before = [
        { page: 1, type: 'note', text: 'first' },
        {
            page: 4,
            type: 'drawing',
            data: 'old-png',
            createdAt: '2026-07-01T00:00:00.000Z',
            _blobId: 'drawing-stable-id'
        },
        { page: 4, type: 'note', text: 'last' }
    ];
    const first = before[0];
    const last = before[2];
    const doc = { annotations: before, annotationsUpdatedAt: 0 };
    const { fn: setDocAnnotation } = loadFunction('setDocAnnotation', {
        canEditDocumentAnnotations: () => true,
        ensureDocAnnotations: id => id === 'doc-1' ? doc : null,
        ensureAnnotationBlobId: annotation => {
            if (!annotation._blobId) annotation._blobId = 'generated-id';
            return annotation._blobId;
        }
    });

    setDocAnnotation('doc-1', 4, 'drawing', 'new-png');
    assert.equal(doc.annotations.length, 3);
    assert.equal(doc.annotations[0], first);
    assert.equal(doc.annotations[2], last);
    assert.equal(doc.annotations[1].page, 4);
    assert.equal(doc.annotations[1].type, 'drawing');
    assert.equal(doc.annotations[1].data, 'new-png');
    assert.equal(doc.annotations[1].createdAt, '2026-07-01T00:00:00.000Z');
    assert.equal(doc.annotations[1]._blobId, 'drawing-stable-id');
    assert.ok(doc.annotationsUpdatedAt > 0);
});

test('reader PDF loading tasks are retained and disposal destroys every PDF resource', async () => {
    const loadSource = functionSource('loadPDF');
    assert.match(loadSource, /const loadingTask\s*=\s*pdfjsLib\.getDocument\s*\(/);
    assert.match(loadSource, /readerPdfLoadingTask\s*=\s*loadingTask/);
    assert.match(loadSource, /await loadingTask\.promise/);
    assert.match(loadSource, /readerPdfLoadingTask\s*===\s*loadingTask/);

    let loadingDestroyCount = 0;
    let documentDestroyCount = 0;
    const wrapper = { replaceChildren() {} };
    const overlay = { style: {} };
    const context = vm.createContext({
        readerPdfLoadingTask: {
            destroy: async () => { loadingDestroyCount++; }
        },
        pdfDoc: {
            destroy: async () => { documentDestroyCount++; }
        },
        readerPdfCleanupPromise: Promise.resolve(),
        readerRenderGeneration: 4,
        isRenderingAllPages: true,
        readerVisibleRenderQueued: true,
        isPinching: true,
        scrollUpdateTimer: null,
        releaseAllReaderCanvases: () => {},
        resetReaderInkHistory: () => {},
        document: {
            getElementById: id => id === 'pdfCanvasWrapper' ? wrapper
                : id === 'readerRestoreOverlay' ? overlay : null
        },
        renderedPages: new Set([1]),
        pageElements: { 1: {} },
        totalPages: 12,
        clearTimeout: () => {}
    });
    vm.runInContext(
        `${functionSource('destroyReaderPdfResources')}\n`
            + `${functionSource('disposeReaderDocumentResources')}\n`
            + 'this.__disposeReader = disposeReaderDocumentResources;',
        context
    );

    await context.__disposeReader();
    assert.equal(loadingDestroyCount, 1, 'dispose must destroy an in-flight PDF loading task');
    assert.equal(documentDestroyCount, 1, 'dispose must destroy the loaded PDF document');
    assert.equal(context.readerPdfLoadingTask, null);
    assert.equal(context.pdfDoc, null);
    assert.equal(context.readerRenderGeneration, 5);
    assert.equal(context.isRenderingAllPages, false);
    assert.equal(context.readerVisibleRenderQueued, false);
    assert.equal(context.isPinching, false);
    assert.equal(context.totalPages, 0);
    assert.equal(context.renderedPages.size, 0);
    assert.equal(Object.keys(context.pageElements).length, 0);
});

test('document switch and reader close flush the outgoing draft before clearing its owner', () => {
    const oldDoc = { id: 'old-doc', title: 'Old', type: 'epub' };
    const nextDoc = { id: 'next-doc', title: 'Next', type: 'epub' };
    const elements = {
        draftPanel: { classList: { contains: () => false } },
        readerTitle: { textContent: '' },
        welcomeReader: { style: {} },
        pdfCanvasWrapper: { innerHTML: '' },
        readerPageNav: { style: {} }
    };
    const switchOrder = [];
    let switchContext;
    const opened = loadFunction('openDoc', {
        appData: { books: [oldDoc, nextDoc], papers: [], settings: {} },
        currentDoc: oldDoc,
        draftCanvasDocId: oldDoc.id,
        readerDocumentLoadGeneration: 0,
        suppressScrollWriteback: false,
        document: { getElementById: id => elements[id] },
        collapseDraftPanel: () => { throw new Error('hidden panel must not collapse'); },
        flushPendingDraftSave: () => {
            switchOrder.push(`flush:${switchContext.currentDoc && switchContext.currentDoc.id}`);
        },
        resetDraftCanvasForDocument: id => {
            switchOrder.push(`reset:${id}:${switchContext.currentDoc && switchContext.currentDoc.id}`);
            switchContext.draftCanvasDocId = id || null;
        },
        clearSearchCache: () => {},
        closeSearchPanel: () => {},
        saveData: () => {},
        switchPage: () => {},
        loadPDF: () => {},
        disposeReaderDocumentResources: () => {},
        escapeHtml: value => value,
        i18n: key => key
    });
    switchContext = opened.context;
    opened.fn(nextDoc.id, true);
    assert.deepEqual(switchOrder, [
        'flush:old-doc',
        'reset:next-doc:next-doc'
    ]);
    assert.equal(switchContext.currentDoc, nextDoc);

    const closeOrder = [];
    let closeContext;
    const closed = loadFunction('closeReader', {
        currentDoc: nextDoc,
        currentPage: 6,
        draftCanvasDocId: nextDoc.id,
        readerDocumentLoadGeneration: 4,
        suppressScrollWriteback: true,
        einkPendingSelection: { page: 6 },
        flushPendingDraftSave: () => {
            closeOrder.push(`flush:${closeContext.currentDoc && closeContext.currentDoc.id}`);
        },
        resetDraftCanvasForDocument: id => {
            closeOrder.push(`reset:${id}:${closeContext.currentDoc && closeContext.currentDoc.id}`);
            closeContext.draftCanvasDocId = id || null;
        },
        closeAllNoteBubbles: () => {},
        hideReaderSelectionMenu: () => {},
        clearReaderTextSelection: () => {},
        disposeReaderDocumentResources: () => {},
        switchPage: () => {},
        renderLibrary: () => {}
    });
    closeContext = closed.context;
    closed.fn();
    assert.deepEqual(closeOrder, [
        'flush:next-doc',
        'reset:null:next-doc'
    ]);
    assert.equal(closeContext.currentDoc, null);
    assert.equal(closeContext.currentPage, 1);
    assert.equal(closeContext.draftCanvasDocId, null);
});

test('opening a non-PDF document invalidates and disposes the active reader', () => {
    const doc = { id: 'epub-1', title: 'Reference', type: 'epub' };
    const elements = {
        readerTitle: { textContent: '' },
        welcomeReader: { style: {} },
        pdfCanvasWrapper: { innerHTML: '' },
        readerPageNav: { style: {} }
    };
    let disposeCount = 0;
    let loadPdfCount = 0;
    let draftResetCount = 0;
    let generationObservedByDispose = 0;
    let context;
    const loaded = loadFunction('openDoc', {
        appData: { books: [doc], papers: [], settings: {} },
        currentDoc: null,
        draftCanvasDocId: null,
        readerDocumentLoadGeneration: 17,
        suppressScrollWriteback: true,
        document: { getElementById: id => elements[id] },
        flushPendingDraftSave: () => {},
        resetDraftCanvasForDocument: id => {
            assert.equal(id, doc.id);
            draftResetCount++;
        },
        clearSearchCache: () => {},
        closeSearchPanel: () => {},
        saveData: () => {},
        switchPage: () => {},
        loadPDF: () => { loadPdfCount++; },
        disposeReaderDocumentResources: () => {
            disposeCount++;
            generationObservedByDispose = context.readerDocumentLoadGeneration;
        },
        escapeHtml: value => value,
        i18n: key => key
    });
    context = loaded.context;
    loaded.fn('epub-1', true);

    assert.equal(loadPdfCount, 0);
    assert.equal(disposeCount, 1);
    assert.equal(draftResetCount, 1);
    assert.equal(context.readerDocumentLoadGeneration, 18);
    assert.equal(generationObservedByDispose, 18, 'the stale PDF load must be invalidated before disposal');
    assert.equal(context.suppressScrollWriteback, false);
    assert.equal(context.currentDoc, doc);
    assert.equal(elements.readerPageNav.style.display, 'none');
    assert.match(elements.pdfCanvasWrapper.innerHTML, /unsupported_online_format/);
});

test('PWA and APK reader indexes stay byte-identical', () => {
    const pwaIndex = fs.readFileSync(pwaIndexPath);
    const apkIndex = fs.readFileSync(apkIndexPath);
    assert.ok(pwaIndex.equals(apkIndex), 'sync app/src/main/assets/www/index.html to docs/index.html');
});
