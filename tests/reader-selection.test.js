'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const readerHtml = fs.readFileSync(
    path.join(root, 'app/src/main/assets/www/index.html'),
    'utf8'
);
const booxPen = fs.readFileSync(
    path.join(root, 'app/src/main/assets/boox-pen.js'),
    'utf8'
);

test('reader inline application script parses', () => {
    const inlineScripts = [...readerHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
        .map((match) => match[1])
        .filter((source) => source.trim());

    assert.equal(inlineScripts.length, 1, 'expected one inline application script');
    assert.doesNotThrow(() => new vm.Script(inlineScripts[0], { filename: 'reader-inline.js' }));
});

// Read one top-level function from the inline application script without executing
// the browser bundle. All application functions use an eight-space indentation.
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

test('reader long-press handwriting recognition chain is removed', () => {
    const removedIdentifiers = [
        'setupPageLongPress',
        'notePopup',
        'noteCanvas',
        'openNotePopup',
        'recognizeHandwriting',
        'prompt_handwriting'
    ];

    for (const identifier of removedIdentifiers) {
        assert.doesNotMatch(
            readerHtml,
            new RegExp(`\\b${identifier}\\b`),
            `${identifier} must not remain in the reader bundle`
        );
    }
    assert.doesNotMatch(booxPen, /\bid:\s*['"]noteCanvas['"]/, 'Boox must not register the removed note canvas');
});

test('reader lasso mode reuses the notebook lasso icon and canvas treatment', () => {
    const lassoDraw = functionSource('einkSelectMove');

    assert.match(
        readerHtml,
        /id="selectionModeIcon"[^>]*stroke-dasharray="3 3"[^>]*><ellipse cx="12" cy="10" rx="8" ry="6"\/><path d="M7 15\.5c-1 1\.5-1 3 \.5 4\.5" stroke-dasharray="none"\/><\/svg>/
    );
    assert.match(lassoDraw, /strokeStyle\s*=\s*['"]#3b82f6['"]/);
    assert.match(lassoDraw, /lineWidth\s*=\s*1\.5\s*\*\s*rx/);
    assert.match(lassoDraw, /setLineDash\(\[6,\s*5\]\)/);
    assert.match(readerHtml, /className\s*=\s*['"]eink-select-overlay['"]/);
    assert.doesNotMatch(readerHtml, /\.reader-lasso(?:\s|[-.#:{])/);
});

test('lasso mode enables the existing transparent interaction layer on every reader', () => {
    const inputMode = functionSource('applyReaderInputMode');
    const textLayer = functionSource('buildReaderTextLayer');
    const interactions = functionSource('attachReaderTextLayerInput');

    assert.match(inputMode, /const lassoMode\s*=\s*!penMode\s*;/);
    assert.match(inputMode, /pointerEvents\s*=\s*lassoMode\s*\?\s*['"]auto['"]\s*:\s*['"]none['"]/);
    assert.match(inputMode, /touchAction\s*=\s*lassoMode\s*\?\s*['"]none['"]\s*:\s*['"]auto['"]/);
    assert.match(inputMode, /if\s*\(lassoMode\s*&&\s*pd\.rendered\)\s*buildReaderTextLayer\(i\)/);
    assert.match(textLayer, /className\s*=\s*['"]reader-text-layer['"]/);
    assert.doesNotMatch(textLayer, /getTextContent|createElement\(['"]span['"]\)/);
    assert.match(interactions, /if\s*\(!einkMode\s*\|\|\s*booxReaderIsPen\(e\)\)/);
    assert.match(interactions, /einkSelectStart\(layer,\s*pageNum,\s*e\)/);
    assert.doesNotMatch(interactions, /caretRangeFromPoint|setBaseAndExtent|finalizeNativeReaderSelection/);
});

test('e-ink lasso mode stays separate from pen mode and finger paging', () => {
    const inputMode = functionSource('applyReaderInputMode');
    const interactions = functionSource('attachReaderTextLayerInput');

    assert.match(inputMode, /const einkLassoMode\s*=\s*einkMode\s*&&\s*lassoMode\s*;/);
    assert.match(inputMode, /zIndex\s*=\s*\(einkLassoMode\s*&&\s*visible\)\s*\?\s*['"]37['"]\s*:\s*['"]/);
    assert.match(interactions, /if\s*\(penMode\s*\|\|\s*isPinching\s*\|\|\s*e\.button\s*===\s*2\)\s*return\s*;/);
    assert.match(interactions, /booxReaderIsPen\(e\)/);
    assert.match(interactions, /einkPageTurnByClientX\(ft\.x\)/);
});

test('reader lasso is bound to its page and always produces a clipped screenshot', () => {
    const start = functionSource('einkSelectStart');
    const end = functionSource('einkSelectEnd');
    const crop = functionSource('einkCropPageRegion');

    assert.match(start, /page:\s*pageNum/);
    assert.match(end, /const pageNum\s*=\s*sel\.page/);
    assert.match(end, /sel\.pts\.length\s*<\s*3/);
    assert.match(end, /\(maxX\s*-\s*minX\)\s*<\s*12\s*\|\|\s*\(maxY\s*-\s*minY\)\s*<\s*12/);
    assert.match(end, /const selImage\s*=\s*einkCropPageRegion\s*\(/);
    assert.match(end, /image:\s*selImage/);
    assert.doesNotMatch(end, /einkExtractTextInBox|selectedText|text:/);
    assert.doesNotMatch(readerHtml, /function einkExtractTextInBox\s*\(/);
    assert.match(crop, /canvas:not\(\.eink-select-overlay\)/);
    assert.match(crop, /Math\.min\(1,\s*1600\s*\/\s*Math\.max\(sw,\s*sh\)\)/);
    assert.match(crop, /ctx\.setTransform\(outputScale,\s*0,\s*0,\s*outputScale,\s*0,\s*0\)/);
    assert.match(crop, /ctx\.closePath\(\)/);
    assert.match(crop, /ctx\.clip\(\)/);
});

test('reader sends an image while lecture selection keeps the text request helper', () => {
    const helper = functionSource('requestTextSelectionAI');
    const readerAsk = functionSource('askAIAboutReaderSelection');
    const addComment = functionSource('addDocAiComment');
    const lectureAsk = functionSource('askAIAboutSelection');

    assert.equal(
        (readerHtml.match(/async function requestTextSelectionAI\s*\(/g) || []).length,
        1,
        'the shared AI request helper must have one implementation'
    );
    assert.match(helper, /buildSelectionAskPrompt\(selectedText,\s*userDesc\)/);
    assert.match(helper, /callAI\(i18n\(['"]prompt_math_explain['"]\)/);
    assert.match(readerAsk, /type:\s*['"]image_url['"]/);
    assert.match(readerAsk, /url:\s*sel\.image/);
    assert.match(readerAsk, /const docId\s*=\s*currentDoc\.id/);
    assert.match(readerAsk, /einkPendingSelection\s*=\s*null;[\s\S]*await callAI/);
    assert.match(readerAsk, /addDocAiComment\(docId,\s*sel\.page/);
    assert.doesNotMatch(readerAsk, /finally\s*{/);
    assert.doesNotMatch(readerAsk, /requestTextSelectionAI|sel\.text/);
    assert.match(addComment, /ensureDocAnnotations\(docId\)/);
    assert.match(addComment, /currentDoc\.id\s*===\s*docId/);
    assert.match(addComment, /pageData\s*&&\s*pageData\.rendered/);
    assert.match(addComment, /refreshPageMarkers\(page\)/);
    assert.match(lectureAsk, /requestTextSelectionAI\(savedText,\s*userDesc\)/);
});

test('reader AI menu survives the lasso click and dismisses on a later outside click', () => {
    const dismiss = functionSource('handleReaderSelectionOutsideClick');
    const interactions = functionSource('attachReaderTextLayerInput');
    const showMenu = functionSource('showReaderSelectionMenu');

    assert.match(readerHtml, /document\.addEventListener\(['"]click['"],\s*handleReaderSelectionOutsideClick\)/);
    assert.match(dismiss, /!e\.target\.closest\(['"]#readerSelectionMenu['"]\)/);
    assert.match(dismiss, /hideReaderSelectionMenu\(\)/);
    assert.match(dismiss, /einkPendingSelection\s*=\s*null/);
    assert.match(interactions, /suppressNextLassoClick\s*=\s*!!einkSelectEnd\(e\)/);
    assert.match(interactions, /if\s*\(!suppressNextLassoClick\)\s*return/);
    assert.match(interactions, /suppressNextLassoClick\s*=\s*false;\s*e\.stopPropagation\(\)/);
    assert.match(showMenu, /window\.innerWidth\s*-\s*menuWidth\s*-\s*10/);
    assert.match(showMenu, /window\.innerHeight\s*-\s*menuHeight\s*-\s*10/);
});

test('reader mode changes immediately synchronize Boox writable regions', () => {
    const applyPenMode = functionSource('applyPenModeUI');
    const tickIndex = booxPen.indexOf('function tick()');
    const exportIndex = booxPen.indexOf('window.__booxPen.syncRegions = tick;');
    const pollIndex = booxPen.indexOf('setInterval(tick, 350)');

    assert.ok(tickIndex >= 0, 'Boox region scan function not found');
    assert.ok(exportIndex > tickIndex, 'syncRegions must expose the region scan after it is defined');
    assert.ok(pollIndex > exportIndex, 'syncRegions must be available before polling starts');
    assert.match(applyPenMode, /typeof window\.__booxPen\.syncRegions\s*===\s*['"]function['"]/);
    assert.match(applyPenMode, /window\.__booxPen\.syncRegions\(\)/);
});
