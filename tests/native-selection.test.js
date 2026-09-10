// Run: node tests/native-selection.test.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
const guardStart = html.indexOf('        function readerPenModeOwnsEventTarget(target)');
const guardEnd = html.indexOf('        // 按当前画笔/套索模式调整页面分层', guardStart);
const askStart = html.indexOf('        function handleLectureSelection(e)');
const askEnd = html.indexOf('        // 用绝对定位的div覆盖高亮', askStart);
const modeStart = html.indexOf('        function applyLectureInputMode()');
const modeEnd = html.indexOf('        function setLecturePenColor(', modeStart);
assert.ok(guardStart >= 0 && guardEnd > guardStart && askStart >= 0 && askEnd > askStart);
assert.ok(modeStart >= 0 && modeEnd > modeStart);

const elements = new Map();
function element(id, parent = null, tag = 'DIV', editable = false) {
    const classes = new Set();
    const el = {
        id, nodeType: 1, tagName: tag, parentElement: parent, parentNode: parent,
        contentEditable: editable ? 'true' : 'inherit', isContentEditable: editable,
        classList: {
            contains: name => classes.has(name),
            add: name => classes.add(name),
            remove: name => classes.delete(name),
            toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }
        },
        contains(node) {
            for (; node; node = node.parentNode) if (node === this) return true;
            return false;
        },
        matches(selector) {
            return selector.split(',').some(part => {
                part = part.trim();
                const descendant = part.lastIndexOf(' ');
                if (descendant >= 0) return this.matches(part.slice(descendant + 1))
                    && !!this.parentElement?.closest(part.slice(0, descendant));
                if (part === '[contenteditable="true"]' || part === '[contenteditable]') return editable;
                const excluded = part.match(/:not\(([^)]+)\)/);
                if (excluded && this.matches(excluded[1])) return false;
                part = part.replace(/:not\([^)]+\)/, '');
                const id = part.match(/#([\w-]+)/);
                const className = part.match(/\.([\w-]+)/);
                const tagName = part.match(/^[\w-]+/);
                return (!id || this.id === id[1]) && (!className || classes.has(className[1]))
                    && (!tagName || this.tagName.toLowerCase() === tagName[0]);
            });
        },
        closest(selector) {
            for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
            return null;
        }
    };
    elements.set(id, el);
    return el;
}
const body = element('body', null, 'BODY');
const reader = element('readerContainer', body);
const readerInk = element('readerInk', reader);
const lectureViewer = element('lectureViewer', body);
const lecture = element('lectureViewerContent', lectureViewer);
const lectureInk = element('lectureDrawCanvas', lecture, 'CANVAS');
const lectureButton = element('lecturePenBtn', body, 'BUTTON');
const lectureToolbar = element('lecturePenToolbar', body);
const draft = element('lectureDraftCanvasWrapper', body);
const draftInk = element('lectureDraftCanvas', draft, 'CANVAS');
const notebookEditor = element('nbEditor', body);
const notebook = element('nbCanvasWrap', notebookEditor);
const notebookInk = element('nbCanvas', notebook, 'CANVAS');
const outside = element('outside', body);
const textNode = parent => ({ nodeType: 3, parentElement: parent, parentNode: parent });
const registrations = new Map();
const timeouts = [];
let selection = null;
let highlighted = null;
let menuShown = 0;
let regionsSynced = 0;
const sandbox = {
    penMode: false, lecturePenMode: false, lectureSelectedText: '', lectureSelectionRange: null,
    lecturePenSize: 4,
    nbState: { tool: 'pen' }, lectureDraftPenEnabled: false, lectureDraftEraserEnabled: false,
    document: { body, activeElement: null,
        getElementById: id => elements.get(id) || null,
        addEventListener(type, handler, capture) { registrations.set(type, { handler, capture }); }
    },
    window: { getSelection: () => selection, __booxPen: { syncRegions: () => regionsSynced++ } },
    setTimeout: callback => timeouts.push(callback), console,
    highlightLectureSelection: range => { highlighted = range; },
    showLectureSelectionMenu: () => menuShown++, hideLectureSelectionMenu() {}
};
vm.createContext(sandbox);
vm.runInContext(html.slice(guardStart, guardEnd) + html.slice(askStart, askEnd)
    + html.slice(modeStart, modeEnd), sandbox);

function mode(readerOn, lectureOn, notebookOn, draftOn = false) {
    sandbox.penMode = readerOn;
    sandbox.lecturePenMode = lectureOn;
    sandbox.nbState.tool = notebookOn ? 'pen' : 'text';
    sandbox.lectureDraftPenEnabled = draftOn;
    body.classList.toggle('reader-pen-mode', readerOn);
    body.classList.toggle('lecture-pen-mode', lectureOn);
    body.classList.toggle('nb-text-mode', !notebookOn);
    lectureViewer.classList.add('show');
    notebookEditor.classList.add('show');
    draft.classList.toggle('active', draftOn);
}
function expectBlocked(target, blocked) {
    for (const type of ['selectstart', 'dragstart', 'contextmenu']) {
        const registration = registrations.get(type);
        assert.equal(registration.capture, true, type + ' must use capture');
        let prevented = false, stopped = false;
        registration.handler({ target, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
        assert.equal(prevented, blocked, type + ' target: ' + target.id);
        assert.equal(stopped, blocked, type + ' propagation: ' + target.id);
    }
}
function makeSelection(anchor, focus = anchor) {
    selection = { anchorNode: anchor, focusNode: focus, rangeCount: 1,
        removeAllRanges() { this.rangeCount = 0; }, toString: () => 'selected math',
        getRangeAt: () => ({ cloneRange: () => ({ marker: 'saved range' }) })
    };
    return selection;
}
function expectCleared(anchor, focus, cleared) {
    const selected = makeSelection(anchor, focus);
    const registration = registrations.get('selectionchange');
    assert.equal(registration.capture, true);
    registration.handler();
    assert.equal(selected.rangeCount, cleared ? 0 : 1, 'selection anchor/focus ownership');
}

mode(true, true, true, true);
for (const ink of [readerInk, lectureInk, notebookInk, draftInk]) {
    expectBlocked(ink, true);
    expectCleared(textNode(ink), textNode(outside), true);
    expectCleared(textNode(outside), textNode(ink), true);
}
expectBlocked(outside, false);
expectCleared(textNode(outside), textNode(outside), false);

// Existing reader behavior stays intact; newly protected surfaces allow editing.
const readerInput = element('readerInput', reader, 'INPUT');
expectBlocked(readerInput, true);
for (const container of [lecture, notebook, draft]) {
    for (const tag of ['INPUT', 'TEXTAREA', 'DIV']) {
        const edit = element(container.id + tag, container, tag, tag === 'DIV');
        const target = tag === 'DIV' ? element(edit.id + 'child', edit, 'SPAN') : edit;
        expectBlocked(target, false);
        expectCleared(textNode(target), textNode(target), false);
    }
}

mode(false, false, false);
for (const ink of [readerInk, lectureInk, notebookInk, draftInk]) {
    expectBlocked(ink, false);
    expectCleared(textNode(ink), textNode(ink), false);
}

// Non-writing lecture text keeps the existing custom Ask AI selection workflow.
makeSelection(textNode(lecture));
sandbox.handleLectureSelection({ target: lecture });
timeouts.splice(0).forEach(callback => callback());
assert.equal(sandbox.lectureSelectedText, 'selected math');
assert.equal(highlighted, sandbox.lectureSelectionRange);
assert.equal(menuShown, 1);
assert.equal(selection.rangeCount, 0);

// A queued touchend must not create an Ask AI menu after handwriting is enabled.
makeSelection(textNode(lecture));
sandbox.handleLectureSelection({ target: lectureInk });
mode(false, true, false);
timeouts.splice(0).forEach(callback => callback());
assert.equal(menuShown, 1);

// Mode application restores a replacement canvas and publishes its native region.
makeSelection(textNode(lecture));
sandbox.applyLectureInputMode();
assert.ok(body.classList.contains('lecture-pen-mode'));
assert.ok(lectureInk.classList.contains('active'));
assert.ok(lectureButton.classList.contains('active'));
assert.ok(lectureToolbar.classList.contains('show'));
assert.equal(selection.rangeCount, 0);
assert.equal(sandbox.window.__lectureNativeWidth, 4);
const replacementCanvas = element('lectureDrawCanvas', lecture, 'CANVAS');
sandbox.applyLectureInputMode();
assert.ok(replacementCanvas.classList.contains('active'));
assert.equal(regionsSynced, 2);
sandbox.lecturePenMode = false;
makeSelection(textNode(lecture));
sandbox.applyLectureInputMode();
assert.equal(body.classList.contains('lecture-pen-mode'), false);
assert.equal(replacementCanvas.classList.contains('active'), false);
assert.equal(lectureButton.classList.contains('active'), false);
assert.equal(lectureToolbar.classList.contains('show'), false);
assert.equal(selection.rangeCount, 1);
assert.equal(regionsSynced, 3);
console.log('native selection guards and lecture Ask AI: passed');
