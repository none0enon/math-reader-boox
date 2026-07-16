/*
 * math-reader Boox 适配器（由 MainActivity 在页面加载完成后注入）
 *
 * 职责：
 * 1. 自动探测 PWA 中当前"可手写"的画布（习题作答 / PDF 批注 / 草稿纸 /
 *    讲义画笔），把画布区域交给原生 Onyx TouchHelper 做低延迟直渲染书写。
 *    探测完全基于 PWA 已有的通用信号（可见性 + pointer-events），不依赖其内部状态。
 * 2. 抬笔后原生回传整笔触点，本脚本以合成 PointerEvent 回放给画布元素，
 *    PWA 自己的绘制/撤销/保存逻辑零修改全部复用。
 * 3. 拦截 blob: 下载（PWA 导出 PDF/JSON），转交原生保存到下载目录。
 *
 * index.html 含阅读器套索模式的 Boox 集成补丁，升级上游时需保留对应接口。
 */
(function () {
    'use strict';
    if (window.__booxPen) { return; }

    /* ---------------- 存储持久化状态修正 ----------------
     * WebView 的 IndexedDB/localStorage 存在应用私有目录，随应用生命周期持久，
     * 但 WebView 里 navigator.storage.persist() 恒返回 false，会让 PWA 设置页
     * 误显示"未持久化"。这里如实上报 true（estimate() 不受影响）。 */
    if (navigator.storage) {
        try {
            navigator.storage.persist = function () { return Promise.resolve(true); };
            navigator.storage.persisted = function () { return Promise.resolve(true); };
        } catch (e) { /* 只读时保持原状，仅影响显示 */ }
    }

    /* ---------------- Boox 触控笔 / 手指检测 ----------------
     * 阅读界面（墨水屏模式）需要区分"手指点触翻页"与"触控笔套索/书写"。
     * 标准 PointerEvent.pointerType 在 Boox WebView 上对手写笔上报 'pen'、
     * 手指上报 'touch'；个别机型/事件 pointerType 缺失时回退到原生
     * MotionEvent.getToolType（由 MainActivity 注入 BooxPenNative.isStylusActive）。
     * 始终暴露，非 Boox 设备亦可用（仅依赖 pointerType），保证 PWA 独立运行。 */
    window.__booxInput = {
        isPen: function (e) {
            // PointerEvent.pointerType 是逐事件属性、永不过期，Chromium WebView 对
            // 触控笔上报 'pen'、手指上报 'touch'，最可靠，优先采用。
            if (e && e.pointerType) {
                if (e.pointerType === 'pen') { return true; }
                if (e.pointerType === 'touch') { return false; }
                // 'mouse' / '' → 落到原生工具类型兜底
            }
            // 兜底：原生 MotionEvent 工具类型（1=手指 2=触控笔 3=鼠标 4=笔尾橡皮）
            try {
                var n = window.BooxPenNative;
                if (n && typeof n.getLastToolType === 'function') {
                    var t = n.getLastToolType();
                    if (t === 2 || t === 4) { return true; }
                    if (t === 1 || t === 3) { return false; }
                }
            } catch (err) { /* 非 Boox 设备 */ }
            return false;
        },
        isFinger: function (e) { return !this.isPen(e); }
    };

    /* ---------------- blob 下载桥接（与手写 SDK 无关，始终启用） ---------------- */
    var dl = window.BooxDownloadNative;
    if (dl) {
        var handleBlobAnchor = function (a) {
            var name = a.getAttribute('download') || 'download.bin';
            fetch(a.href)
                .then(function (r) { return r.blob(); })
                .then(function (blob) {
                    var fr = new FileReader();
                    fr.onload = function () {
                        var s = String(fr.result || '');
                        var i = s.indexOf(',');
                        if (i >= 0) {
                            dl.saveBase64(name, blob.type || 'application/octet-stream', s.slice(i + 1));
                        }
                    };
                    fr.readAsDataURL(blob);
                })
                .catch(function (e) { console.warn('boox-pen: blob download failed', e); });
        };
        // PWA 多处用 a.click() 触发下载，且 anchor 可能未挂到 DOM，必须打补丁
        var origClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (this.hasAttribute('download') && String(this.href).indexOf('blob:') === 0) {
                handleBlobAnchor(this);
                return;
            }
            return origClick.apply(this, arguments);
        };
        document.addEventListener('click', function (e) {
            var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
            if (a && String(a.href).indexOf('blob:') === 0) {
                e.preventDefault();
                e.stopImmediatePropagation();
                handleBlobAnchor(a);
            }
        }, true);
    }

    /* ---------------- 原生手写 ---------------- */
    var native = window.BooxPenNative;
    var hasNative = false;
    try { hasNative = !!(native && native.isAvailable()); } catch (e) { /* 非 Boox 设备 */ }

    window.__booxPen = { active: hasNative, onStroke: function () {}, refresh: function () {} };
    if (!hasNative) {
        console.log('boox-pen: native pen SDK not available, PWA runs unmodified');
        return;
    }
    console.log('boox-pen: native pen SDK active');
    // PWA 可主动请求重绘，清掉原生直渲染层的残留墨迹（套索轨迹、点按墨点等）
    window.__booxPen.refresh = function () { scheduleRefresh(150); };

    var DPR = window.devicePixelRatio || 1;

    // 可手写画布注册表，按优先级排列（覆盖层在前）。
    // eraserBtn: 对应橡皮按钮（active 时挂起原生直渲染，走 PWA 默认事件路径）
    // eraserToggle: 全局函数名，回放原生笔侧橡皮笔迹时临时切换
    // suspendFlag: 全局布尔变量名，为真时挂起原生直渲染（套索/文本/图形等非书写工具）
    // widthFlag: 全局变量名，数值为当前笔刷 CSS 像素宽度（原生直渲染层的笔迹粗细）
    var CONFIGS = [
        { name: 'notebookQuiz', id: 'nbQuizFsCanvas',       cssWidth: 2,
          eraserBtn: 'qzEraserBtn',     eraserToggle: 'toggleQzEraser' },
        { name: 'notebook',     id: 'nbCanvas',             cssWidth: 2,
          eraserBtn: 'nbEraserBtn',     eraserToggle: 'toggleNbEraser',
          suspendFlag: '__nbNativeSuspend', widthFlag: '__nbNativeWidth' },
        { name: 'draft',        id: 'draftCanvas',          cssWidth: 2 },
        { name: 'lectureDraft', id: 'lectureDraftCanvas',   cssWidth: 2 },
        { name: 'lectureDraw',  id: 'lectureDrawCanvas',    cssWidth: 2 },
        { name: 'exercise',     id: 'exerciseDoingCanvas',  cssWidth: 2,
          eraserBtn: 'exEraserBtn',     eraserToggle: 'toggleExEraser' },
        { name: 'annotation',   selector: '.annotation-canvas', cssWidth: 3,
          eraserBtn: 'readerEraserBtn', eraserToggle: 'toggleReaderEraser' }
    ];

    var activeCfg = null;
    var activeEls = [];
    var lastKey = 'off';

    function isDrawable(el) {
        if (!el || !el.isConnected) { return false; }
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') {
            return false;
        }
        var r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) { return false; }
        var vw = window.innerWidth, vh = window.innerHeight;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) { return false; }
        // 顶层采样：被弹窗/面板遮住时不能抢笔
        var samples = [
            [r.left + r.width / 2, r.top + r.height / 2],
            [r.left + 8, r.top + 8], [r.right - 8, r.top + 8],
            [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8]
        ];
        var isAnno = el.classList && el.classList.contains('annotation-canvas');
        for (var i = 0; i < samples.length; i++) {
            var x = Math.min(Math.max(samples[i][0], 1), vw - 1);
            var y = Math.min(Math.max(samples[i][1], 1), vh - 1);
            var hit = document.elementFromPoint(x, y);
            if (hit === el) { return true; }
            // 墨水屏阅读器：翻页热区是盖在批注层之上的透明覆盖层，触控笔由原生 SDK
            // 按屏幕矩形拦截（与 DOM 层级无关，且手指仍可穿透到热区翻页），故视为可穿透。
            if (isAnno && hit && hit.classList && hit.classList.contains('eink-tap-zone')) {
                return true;
            }
        }
        return false;
    }

    function eraserActive(cfg) {
        if (!cfg) { return false; }
        // 非书写工具激活时（套索/文本/图形），同样挂起原生直渲染走 PWA 事件路径
        if (cfg.suspendFlag && window[cfg.suspendFlag]) { return true; }
        if (!cfg.eraserBtn) { return false; }
        var b = document.getElementById(cfg.eraserBtn);
        return !!(b && b.classList.contains('active'));
    }

    function setNative(payload) {
        var key = payload ? JSON.stringify(payload) : 'off';
        if (key === lastKey) { return; }
        lastKey = key;
        try {
            if (payload) {
                native.setRects(JSON.stringify(payload));
            } else {
                native.disable();
            }
        } catch (e) { console.warn('boox-pen: native call failed', e); }
    }

    function tick() {
        var found = null;
        for (var i = 0; i < CONFIGS.length && !found; i++) {
            var cfg = CONFIGS[i];
            var els = cfg.selector
                ? Array.prototype.slice.call(document.querySelectorAll(cfg.selector))
                : [document.getElementById(cfg.id)];
            els = els.filter(isDrawable);
            if (els.length) { found = { cfg: cfg, els: els }; }
        }
        if (!found || eraserActive(found.cfg)) {
            activeCfg = found ? found.cfg : null;
            activeEls = found ? found.els : [];
            for (var g = 0; g < activeEls.length; g++) { installFingerGuard(activeEls[g]); }
            setNative(null);
            return;
        }
        activeCfg = found.cfg;
        activeEls = found.els;
        for (var g = 0; g < activeEls.length; g++) { installFingerGuard(activeEls[g]); }
        var vw = window.innerWidth, vh = window.innerHeight;
        var rects = found.els.map(function (el) {
            var r = el.getBoundingClientRect();
            return [
                Math.round(Math.max(r.left, 0) * DPR),
                Math.round(Math.max(r.top, 0) * DPR),
                Math.round(Math.min(r.right, vw) * DPR),
                Math.round(Math.min(r.bottom, vh) * DPR)
            ];
        });
        var cssW = found.cfg.cssWidth || 2;
        if (found.cfg.widthFlag && Number(window[found.cfg.widthFlag]) > 0) {
            cssW = Number(window[found.cfg.widthFlag]);
        }
        setNative({ rects: rects, width: cssW * DPR });
    }

    // 模式按钮切换后立即重算原生区域，避免等待轮询期间首笔仍落到旧画布。
    window.__booxPen.syncRegions = tick;

    var tickTimer = setInterval(tick, 350);
    var nudgeTimer = null;
    function nudge() {
        if (nudgeTimer) { return; }
        nudgeTimer = setTimeout(function () { nudgeTimer = null; tick(); }, 120);
    }
    window.addEventListener('scroll', nudge, true);
    window.addEventListener('resize', nudge);

    /* -------- 手掌误触过滤 --------
     * 原生 SDK 拦截区域内的触控笔输入后以 pointerType='pen' 合成事件回放；
     * 但手指/手掌触摸仍以 pointerType='touch' 到达 WebView。在 SDK 激活期间
     * 拦截画布上的非 pen 指针事件，防止右手书写时手掌在画布上留下杂笔。 */
    function installFingerGuard(el) {
        if (el._booxFingerGuard) { return; }
        var block = function (e) {
            if (lastKey === 'off') { return; }
            if (e.pointerType === 'pen') { return; }
            e.stopPropagation();
            e.preventDefault();
        };
        el.addEventListener('pointerdown', block, true);
        el.addEventListener('pointermove', block, true);
        el.addEventListener('pointerup', block, true);
        el.addEventListener('pointercancel', block, true);
        if ('onpointerrawupdate' in window) {
            el.addEventListener('pointerrawupdate', block, true);
        }
        el._booxFingerGuard = true;
    }

    /* -------- 撤销/重做/清空 后强制重绘，清掉原生层残留笔迹 -------- */
    var refreshTimer = null;
    function scheduleRefresh(delay) {
        if (refreshTimer) { clearTimeout(refreshTimer); }
        refreshTimer = setTimeout(function () {
            refreshTimer = null;
            try { native.refresh(); } catch (e) {}
        }, delay);
    }
    document.addEventListener('click', function (e) {
        if (lastKey === 'off') { return; }
        var btn = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!btn) { return; }
        var sig = (btn.id || '') + ' ' + (btn.getAttribute('onclick') || '') + ' ' + (btn.className || '');
        if (/undo|redo|clear|清空|清除/i.test(sig)) { scheduleRefresh(350); }
    }, true);

    /* -------- 原生笔迹回放 -------- */
    function dispatchPointer(el, type, x, y, pressure, buttons) {
        var ev = new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 99917,
            pointerType: 'pen',
            isPrimary: true,
            clientX: x,
            clientY: y,
            pressure: pressure,
            buttons: buttons
        });
        el.dispatchEvent(ev);
    }

    function replay(el, pts) {
        dispatchPointer(el, 'pointerdown', pts[0][0], pts[0][1], pts[0][2], 1);
        for (var i = 1; i < pts.length; i++) {
            dispatchPointer(el, 'pointermove', pts[i][0], pts[i][1], pts[i][2], 1);
        }
        var last = pts[pts.length - 1];
        dispatchPointer(el, 'pointerup', last[0], last[1], 0, 0);
    }

    // points: [[viewPxX, viewPxY, pressure], ...]，erase: 笔侧橡皮
    window.__booxPen.onStroke = function (points, erase) {
        if (!activeEls.length || !points || !points.length) { return; }
        var pts = points.map(function (p) {
            return [p[0] / DPR, p[1] / DPR, p[2] || 0.5];
        });
        var x0 = pts[0][0], y0 = pts[0][1];
        var target = null;
        for (var i = 0; i < activeEls.length; i++) {
            var r = activeEls[i].getBoundingClientRect();
            if (x0 >= r.left && x0 <= r.right && y0 >= r.top && y0 <= r.bottom) {
                target = activeEls[i];
                break;
            }
        }
        if (!target) { target = activeEls[0]; }

        var cfg = activeCfg || {};
        var toggled = false;
        if (erase && cfg.eraserToggle && typeof window[cfg.eraserToggle] === 'function'
                && !eraserActive(cfg)) {
            try { window[cfg.eraserToggle](); toggled = true; } catch (e) {}
        }
        try {
            replay(target, pts);
        } finally {
            if (toggled) {
                try { window[cfg.eraserToggle](); } catch (e) {}
            }
        }
        // 橡皮：画布内容已变，但原生层在直渲染时不展示底层更新，需要重绘
        if (erase) { scheduleRefresh(200); }
    };
})();
