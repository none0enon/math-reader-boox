'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const appHtml = fs.readFileSync(
    path.join(root, 'app/src/main/assets/www/index.html'),
    'utf8'
);

// Read one top-level function from the inline application script without
// executing the browser bundle. Application functions use eight-space indent.
function functionSource(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`(?:^|\\n) {8}(?:async )?function ${escaped}\\s*\\(`);
    const match = declaration.exec(appHtml);
    assert.ok(match, `${name} function not found`);

    const start = match.index;
    const afterDeclaration = appHtml.slice(start + match[0].length);
    const nextFunction = afterDeclaration.search(/\n {8}(?:async )?function [A-Za-z_$][\w$]*\s*\(/);
    return nextFunction < 0
        ? appHtml.slice(start)
        : appHtml.slice(start, start + match[0].length + nextFunction);
}

function loadFunction(name, globals = {}) {
    const context = vm.createContext({ ...globals });
    vm.runInContext(`${functionSource(name)}\nthis.__functionUnderTest = ${name};`, context);
    return { fn: context.__functionUnderTest, context };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
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
    for (let attempt = 0; attempt < 20; attempt++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail(message);
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionContaining(pattern, description) {
    const match = pattern.exec(appHtml);
    assert.ok(match, `${description} not found`);

    const prefix = appHtml.slice(0, match.index);
    const declarations = [...prefix.matchAll(/(?:^|\n) {8}(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/g)];
    assert.ok(declarations.length, `function containing ${description} not found`);
    const name = declarations[declarations.length - 1][1];
    return { name, source: functionSource(name) };
}

test('opening-page resolver accepts stable page ids and clamps explicit integers', () => {
    const { fn: resolve } = loadFunction('nbResolveOpeningPageIndex');
    const notebook = {
        lastOpenedPageId: 'p2',
        pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
    };

    assert.equal(resolve(notebook, 0), 0, 'explicit page zero must not be treated as missing');
    assert.equal(resolve(notebook, -7), 0, 'negative explicit pages clamp to the first page');
    assert.equal(resolve(notebook, 99), 2, 'large explicit pages clamp to the last page');
    assert.equal(resolve(notebook, 'p3'), 2, 'a stable page id must override the remembered cursor');
    assert.equal(resolve(notebook, 'missing-page'), 0, 'an unknown explicit page id safely falls back');
});

test('opening-page resolver follows page identity across reorder and deletion', () => {
    const { fn: resolve } = loadFunction('nbResolveOpeningPageIndex');
    const notebook = {
        lastOpenedPageId: 'p2',
        pages: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]
    };

    assert.equal(resolve(notebook), 1);
    notebook.pages = [{ id: 'p3' }, { id: 'p1' }, { id: 'p2' }];
    assert.equal(resolve(notebook), 2, 'reordering must retain the remembered page, not its old index');
    assert.equal(resolve(notebook, 'p1'), 1, 'explicit page ids must also survive reorder');

    notebook.pages = notebook.pages.filter(page => page.id !== 'p2');
    assert.equal(resolve(notebook), 0, 'a deleted remembered page must safely fall back to page zero');
});

test('remembering a page can skip persistence and advances its timestamp monotonically', () => {
    let persistCount = 0;
    let now = 100;
    const { fn: remember } = loadFunction('nbRememberOpenedPage', {
        Date: { now: () => now },
        nbPersistOpenedPage: () => { persistCount++; }
    });
    const notebook = {
        lastOpenedPageId: 'p1',
        lastOpenedPageUpdatedAt: 500
    };

    assert.equal(remember(notebook, { id: 'p1' }, false), false);
    assert.equal(notebook.lastOpenedPageUpdatedAt, 500);
    assert.equal(persistCount, 0);

    assert.equal(remember(notebook, { id: 'p2' }, false), true);
    assert.equal(notebook.lastOpenedPageId, 'p2');
    assert.equal(notebook.lastOpenedPageUpdatedAt, 501, 'a clock rollback must still advance the cursor timestamp');
    assert.equal(persistCount, 0);

    now = 1000;
    assert.equal(remember(notebook, { id: 'p3' }), true);
    assert.equal(notebook.lastOpenedPageUpdatedAt, 1000);
    assert.equal(persistCount, 1, 'persistence defaults to the lightweight cursor store');

    now = 900;
    assert.equal(remember(notebook, { id: 'p1' }, false), true);
    assert.equal(notebook.lastOpenedPageUpdatedAt, 1001);
    assert.equal(persistCount, 1);
    assert.doesNotMatch(functionSource('nbRememberOpenedPage'), /saveData\s*\(/);
});

test('notebook merge keeps newer cloud structure and newer valid local cursor', () => {
    const { fn: merge } = loadFunction('mergeNotebooksData');
    const cloud = {
        items: [{
            id: 'nb1',
            name: 'new cloud structure',
            updatedAt: '2026-07-11T12:00:00.000Z',
            pages: [{ id: 'cloud-page' }, { id: 'local-new-position' }],
            lastOpenedPageId: 'cloud-page',
            lastOpenedPageUpdatedAt: 100
        }],
        reviews: []
    };
    const local = {
        items: [{
            id: 'nb1',
            name: 'old local structure',
            updatedAt: '2026-07-10T12:00:00.000Z',
            pages: [{ id: 'local-page' }],
            lastOpenedPageId: 'local-new-position',
            lastOpenedPageUpdatedAt: 200
        }],
        reviews: []
    };

    const notebook = plain(merge(cloud, local, 0)).items[0];
    assert.equal(notebook.name, 'new cloud structure');
    assert.deepEqual(notebook.pages, [{ id: 'cloud-page' }, { id: 'local-new-position' }]);
    assert.equal(notebook.lastOpenedPageId, 'local-new-position');
    assert.equal(notebook.lastOpenedPageUpdatedAt, 200);
});

test('notebook merge keeps newer local structure and newer valid cloud cursor', () => {
    const { fn: merge } = loadFunction('mergeNotebooksData');
    const cloud = {
        items: [{
            id: 'nb1',
            name: 'old cloud structure',
            updatedAt: '2026-07-10T12:00:00.000Z',
            pages: [{ id: 'cloud-page' }],
            lastOpenedPageId: 'cloud-new-position',
            lastOpenedPageUpdatedAt: 300
        }],
        reviews: []
    };
    const local = {
        items: [{
            id: 'nb1',
            name: 'new local structure',
            updatedAt: '2026-07-11T12:00:00.000Z',
            pages: [{ id: 'local-page' }, { id: 'cloud-new-position' }],
            lastOpenedPageId: 'local-page',
            lastOpenedPageUpdatedAt: 200
        }],
        reviews: []
    };

    const notebook = plain(merge(cloud, local, 0)).items[0];
    assert.equal(notebook.name, 'new local structure');
    assert.deepEqual(notebook.pages, [{ id: 'local-page' }, { id: 'cloud-new-position' }]);
    assert.equal(notebook.lastOpenedPageId, 'cloud-new-position');
    assert.equal(notebook.lastOpenedPageUpdatedAt, 300);
});

test('notebook merge never emits a cursor missing from the winning page structure', () => {
    const { fn: merge } = loadFunction('mergeNotebooksData');
    const merged = plain(merge({
        items: [{
            id: 'nb1', updatedAt: '2026-07-11T00:00:00.000Z',
            pages: [{ id: 'valid-cloud-page' }],
            lastOpenedPageId: 'valid-cloud-page', lastOpenedPageUpdatedAt: 100
        }],
        reviews: []
    }, {
        items: [{
            id: 'nb1', updatedAt: '2026-07-10T00:00:00.000Z',
            pages: [{ id: 'invalid-local-page' }],
            lastOpenedPageId: 'invalid-local-page', lastOpenedPageUpdatedAt: 200
        }],
        reviews: []
    }, 0)).items[0];

    assert.notEqual(merged.lastOpenedPageId, 'invalid-local-page');
    if (merged.lastOpenedPageId !== undefined) {
        assert.ok(merged.pages.some(page => page.id === merged.lastOpenedPageId));
    } else {
        assert.equal(merged.lastOpenedPageUpdatedAt, undefined);
    }
});

test('only the latest notebook page load may commit after either await', async () => {
    const source = functionSource('nbLoadPage');
    const tokenMatch = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\+\+\s*([A-Za-z_$][\w$]*)/.exec(source);
    assert.ok(tokenMatch, 'nbLoadPage must snapshot an incrementing request token');
    const [, localToken, tokenCounter] = tokenMatch;
    const saveAwaitIndex = source.indexOf('await nbSavePageNow');
    const contentAwaitIndex = source.indexOf('await nbLoadPageContent');
    assert.ok(tokenMatch.index < saveAwaitIndex && contentAwaitIndex > saveAwaitIndex);

    const afterSave = source.slice(saveAwaitIndex, contentAwaitIndex);
    const afterContent = source.slice(contentAwaitIndex);
    for (const [phase, body] of [['save', afterSave], ['content', afterContent]]) {
        assert.match(body, new RegExp(escapeRegex(localToken)), `${phase} await must validate the local token`);
        assert.match(body, new RegExp(escapeRegex(tokenCounter)), `${phase} await must validate the token counter`);
        assert.match(body, /nbState\.notebookId/, `${phase} await must validate notebook identity`);
    }

    const notebook = { id: 'nb1', pages: [{ id: 'p1' }, { id: 'p2' }] };
    const nbState = {
        notebookId: 'nb1', pageIndex: 0, content: null, dirty: false,
        undoStack: [], redoStack: []
    };
    const pageLoads = { p1: deferred(), p2: deferred() };
    const requestedPages = [];
    const remembered = [];
    const scheduled = [];
    let renderCount = 0;
    const { fn: loadPage } = loadFunction('nbLoadPage', {
        [tokenCounter]: 0,
        nbState,
        nbSavePageNow: async () => {},
        nbCurrentNotebook: () => notebook,
        nbGetNotebook: id => id === notebook.id ? notebook : null,
        nbClearSelection: () => {},
        nbHideTextToolbar: () => {},
        nbLoadPageContent: pageId => {
            requestedPages.push(pageId);
            return pageLoads[pageId].promise;
        },
        nbRememberOpenedPage: (_nb, page) => {
            remembered.push(page.id);
            return true;
        },
        nbSchedulePositionSync: notebookId => scheduled.push(notebookId),
        nbUpdatePageNo: () => {},
        nbUpdateReviewBtn: () => {},
        nbLayout: () => {},
        nbRenderTexts: () => { renderCount++; },
        nbNativeRefresh: () => {}
    });

    const first = loadPage(0);
    await waitFor(() => requestedPages.includes('p1'), 'first page load did not reach its content await');
    const second = loadPage(1);
    await waitFor(() => requestedPages.includes('p2'), 'second page load did not reach its content await');

    pageLoads.p2.resolve({ marker: 'newest' });
    await second;
    pageLoads.p1.resolve({ marker: 'stale' });
    await first;

    assert.equal(nbState.pageIndex, 1);
    assert.equal(nbState.content.marker, 'newest');
    assert.deepEqual(remembered, ['p2']);
    assert.deepEqual(scheduled, ['nb1']);
    assert.equal(renderCount, 1, 'the stale request must not render or otherwise commit');
});

test('position debounce syncs only the latest notebook cursor object', async () => {
    const schedulerSource = functionSource('nbSchedulePositionSync');
    const syncSource = functionSource('r2SyncNotebookPosition');
    assert.match(schedulerSource, /clearTimeout\s*\(/);
    assert.match(schedulerSource, /setTimeout\s*\(/);
    assert.match(schedulerSource, /r2SyncNotebookPosition\s*\(/);
    assert.doesNotMatch(schedulerSource, /nbSyncNotebookEvent|triggerSyncOnFileChange|r2SyncMetadataOnly/);
    assert.doesNotMatch(syncSource, /triggerSyncOnFileChange|r2SyncMetadataOnly|metadata\.json/);

    const timerMatch = /clearTimeout\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(schedulerSource);
    assert.ok(timerMatch, 'position sync timer variable not found');
    let nextTimer = 0;
    const pending = new Map();
    const syncedNotebookIds = [];
    const { fn: schedule } = loadFunction('nbSchedulePositionSync', {
        [timerMatch[1]]: null,
        clearTimeout: id => pending.delete(id),
        setTimeout: callback => {
            const id = ++nextTimer;
            pending.set(id, callback);
            return id;
        },
        r2SyncNotebookPosition: async notebookId => { syncedNotebookIds.push(notebookId); }
    });

    schedule('nb1');
    schedule('nb2');
    assert.equal(pending.size, 1, 'rescheduling must leave only one live timer');
    await Promise.all([...pending.values()].map(callback => callback()));
    assert.deepEqual(syncedNotebookIds, ['nb2']);
});

test('cursor sync honors timestamp LWW and never writes after a failed cloud read', async () => {
    async function run(cloudTimestamp, failRead = false) {
        const notebook = {
            id: 'nb1',
            pages: [{ id: 'local-page' }, { id: 'cloud-page' }],
            lastOpenedPageId: 'local-page',
            lastOpenedPageUpdatedAt: 100
        };
        const writes = [];
        let saveCount = 0;
        const { fn: sync } = loadFunction('r2SyncNotebookPosition', {
            _r2NotebookPositionSyncs: {},
            appDataLoaded: true,
            appData: {
                settings: { r2Config: { accessKeyId: 'key', autoSyncOnChange: true } },
                notebooks: { items: [notebook] }
            },
            r2FetchNotebookPosition: async () => {
                if (failRead) throw new Error('network failed');
                return {
                    notebookId: 'nb1',
                    lastOpenedPageId: 'cloud-page',
                    lastOpenedPageUpdatedAt: cloudTimestamp
                };
            },
            r2NotebookPositionTimestamp: position => Number(position?.lastOpenedPageUpdatedAt) || 0,
            r2NotebookPositionKey: id => `notebooks/positions/${id}.json`,
            r2PutObject: async (...args) => { writes.push(args); },
            nbPersistOpenedPage: () => { saveCount++; },
            console: { warn: () => {} }
        });
        await sync('nb1');
        return { notebook, writes, saveCount };
    }

    const pulled = await run(200);
    assert.equal(pulled.notebook.lastOpenedPageId, 'cloud-page');
    assert.equal(pulled.notebook.lastOpenedPageUpdatedAt, 200);
    assert.equal(pulled.saveCount, 1);
    assert.equal(pulled.writes.length, 0, 'a newer valid cloud cursor must not be overwritten');

    const pushed = await run(50);
    assert.equal(pushed.notebook.lastOpenedPageId, 'local-page');
    assert.equal(pushed.notebook.lastOpenedPageUpdatedAt, 100);
    assert.equal(pushed.writes.length, 1);
    assert.equal(pushed.writes[0][0], 'notebooks/positions/nb1.json');
    assert.deepEqual(JSON.parse(pushed.writes[0][1]), {
        notebookId: 'nb1',
        lastOpenedPageId: 'local-page',
        lastOpenedPageUpdatedAt: 100
    });

    const failed = await run(0, true);
    assert.equal(failed.writes.length, 0, 'a failed cloud read must abort instead of overwriting the remote cursor');
    assert.equal(failed.notebook.lastOpenedPageId, 'local-page');
});

test('R2 reads forward abort signals and notebook cursor reads enforce a timeout', () => {
    const getSource = functionSource('r2GetObject');
    const timeoutSource = functionSource('r2GetObjectWithTimeout');
    const fetchPositionSource = functionSource('r2FetchNotebookPosition');

    assert.match(
        getSource,
        /signal\s*:\s*options\??\.signal/,
        'r2GetObject must forward options.signal into fetch'
    );
    const controllerMatch = /const\s+([A-Za-z_$][\w$]*)\s*=\s*new AbortController\s*\(\s*\)/.exec(timeoutSource);
    assert.ok(controllerMatch, 'timeout helper must create an AbortController');
    const controller = escapeRegex(controllerMatch[1]);
    assert.match(timeoutSource, new RegExp(`setTimeout[\\s\\S]*${controller}\\.abort\\s*\\(`));
    assert.match(timeoutSource, new RegExp(`r2GetObject[\\s\\S]*signal\\s*:\\s*${controller}\\.signal`));
    assert.match(timeoutSource, /finally\s*\{[\s\S]*clearTimeout\s*\(/);
    assert.match(fetchPositionSource, /r2GetObjectWithTimeout\s*\(/);
});

test('notebook open races startup metadata with cursor fetch and rejects stale opens', () => {
    const source = functionSource('nbOpenNotebook');
    const tokenMatch = /const\s+([A-Za-z_$][\w$]*)\s*=\s*\+\+\s*([A-Za-z_$][\w$]*)/.exec(source);
    assert.ok(tokenMatch, 'nbOpenNotebook must snapshot an incrementing open token');
    const [, localToken, tokenCounter] = tokenMatch;
    assert.match(source, /r2StartupMetadataReady/);
    assert.match(source, /r2FetchNotebookPositionForOpen\s*\(/);
    assert.match(source, /await\s+Promise\.all(?:Settled)?\s*\(/, 'startup metadata and cursor fetch must be awaited together');
    assert.doesNotMatch(source, /await\s+r2StartupMetadataReady|await\s+r2FetchNotebookPosition/);

    const promiseAllIndex = source.search(/await\s+Promise\.all(?:Settled)?\s*\(/);
    const getNotebookIndex = source.indexOf('nbGetNotebook', promiseAllIndex);
    const staleGuard = source.slice(promiseAllIndex, getNotebookIndex);
    assert.ok(getNotebookIndex > promiseAllIndex, 'notebook data must be read only after both startup reads settle');
    assert.match(staleGuard, new RegExp(escapeRegex(localToken)));
    assert.match(staleGuard, new RegExp(escapeRegex(tokenCounter)));
    assert.match(staleGuard, /return\s*;/, 'a stale open must exit before touching notebook UI state');
    assert.doesNotMatch(source, /notebook_open|nbSyncNotebookEvent/, 'opening must not publish the full metadata document');
});

test('startup metadata completion releases its gate on success and every early exit', () => {
    const initSource = functionSource('init');
    const startupSource = functionSource('autoSyncFromR2OnStartup');

    const beginGateIndex = initSource.indexOf('beginR2StartupMetadataSync()');
    const startSyncIndex = initSource.indexOf('autoSyncFromR2OnStartup()');
    assert.ok(
        beginGateIndex >= 0 && startSyncIndex > beginGateIndex,
        'init must create the pending metadata gate before starting the async pull'
    );

    const configGuardIndex = startupSource.indexOf('if (!config || !config.accessKeyId ||');
    const busyGuardIndex = startupSource.indexOf('if (r2SyncInProgress)', configGuardIndex);
    const configGuard = startupSource.slice(configGuardIndex, busyGuardIndex);
    assert.ok(configGuardIndex >= 0 && busyGuardIndex > configGuardIndex, 'startup config guard not found');
    assert.match(
        configGuard,
        /finishR2StartupMetadataSync\s*\(\s*\)[\s\S]*?return\s*;/,
        'missing sync configuration must release the gate before returning'
    );

    const metadataReadMatch = /await\s+r2GetObject(?:WithTimeout)?\s*\(\s*['"]metadata\.json['"]/.exec(startupSource);
    assert.ok(metadataReadMatch, 'startup metadata read not found');
    const metadataParseIndex = startupSource.indexOf('JSON.parse(metadataStr)', metadataReadMatch.index);
    const missingMetadataGuard = startupSource.slice(metadataReadMatch.index, metadataParseIndex);
    assert.ok(metadataParseIndex > metadataReadMatch.index, 'startup metadata parse not found');
    assert.match(
        missingMetadataGuard,
        /if\s*\(\s*!metadataStr\s*\)[\s\S]*?finishR2StartupMetadataSync\s*\(\s*\)[\s\S]*?return\s*;/,
        'an empty metadata object must release the gate before returning'
    );

    const notebookMergeIndex = startupSource.indexOf('appData.notebooks = mergeNotebooksData');
    const refreshIndex = startupSource.indexOf('refreshAllUIFromAppData()', notebookMergeIndex);
    const successReleaseIndex = startupSource.indexOf('finishR2StartupMetadataSync()', refreshIndex);
    const backgroundPullIndex = startupSource.indexOf('// 后台拉取本地缺失的资源文件', successReleaseIndex);
    assert.ok(notebookMergeIndex >= 0, 'startup notebook metadata merge not found');
    assert.ok(
        refreshIndex > notebookMergeIndex &&
        successReleaseIndex > refreshIndex &&
        backgroundPullIndex > successReleaseIndex,
        'successful startup must release the gate after metadata is saved/rendered and before asset downloads'
    );

    const finallyIndex = startupSource.lastIndexOf('} finally {');
    const finalReleaseIndex = startupSource.indexOf('finishR2StartupMetadataSync()', finallyIndex);
    const unlockIndex = startupSource.indexOf('r2SyncInProgress = false', finallyIndex);
    assert.ok(finallyIndex >= 0, 'startup sync finally block not found');
    assert.ok(
        finalReleaseIndex > finallyIndex && unlockIndex > finalReleaseIndex,
        'the exception/finally path must release the metadata gate before unlocking sync'
    );
});

test('review navigation passes stable page ids into notebook open', () => {
    for (const name of ['nbGoToReviewPageFs', 'nbGoToReviewPage']) {
        assert.match(
            functionSource(name),
            /nbOpenNotebook\s*\(\s*nb\.id\s*,\s*r\.pageId\s*\)/,
            `${name} must pass the review page id instead of a mutable index`
        );
    }
});

test('notebook metadata mutations keep their explicit cloud sync events', () => {
    for (const name of [
        'nbConfirmCreate',
        'nbRenameNotebook',
        'nbDeleteNotebook',
        'nbApplyTemplate',
        'nbTogglePageInToc'
    ]) {
        assert.match(
            functionSource(name),
            /nbSyncNotebookEvent\s*\(\s*['"]notebook_metadata_update['"]\s*,/,
            `${name} must publish its metadata mutation explicitly`
        );
    }
});

test('deleting the current page remembers its successor before publishing deletion', () => {
    const source = functionSource('nbDeletePageAt');
    const spliceIndex = source.indexOf('nb.pages.splice');
    const rememberMatch = /nbRememberOpenedPage\s*\(\s*nb\s*,[\s\S]{0,160}?,\s*false\s*\)/.exec(source);
    const deleteSyncIndex = source.search(/nbSyncNotebookEvent\s*\(\s*['"]notebook_page_delete['"]/);
    assert.ok(rememberMatch, 'deletion must remember the surviving current page without a full save');
    assert.ok(
        spliceIndex >= 0 && rememberMatch.index > spliceIndex && deleteSyncIndex > rememberMatch.index,
        'the replacement cursor must be recorded before notebook_page_delete is synchronized'
    );
});
