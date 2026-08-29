package com.mathreader.boox;

import android.app.Activity;
import android.graphics.Rect;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.MotionEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.onyx.android.sdk.data.note.TouchPoint;
import com.onyx.android.sdk.pen.RawInputCallback;
import com.onyx.android.sdk.pen.TouchHelper;
import com.onyx.android.sdk.pen.data.TouchPointList;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * JS 桥：boox-pen.js 把当前可写画布区域传进来，原生侧用 Onyx TouchHelper
 * 在该区域内做低延迟直渲染书写；抬笔后把整笔触点回传给页面，由页面以合成
 * PointerEvent 回放，复用 PWA 自己的笔迹提交/撤销/保存逻辑。
 *
 * TouchHelper 的用法（setLimitRect → openRawDrawing → setRawDrawingEnabled，
 * 动态改区域时先 setRawDrawingEnabled(false)）与官方 OnyxPenDemo 各示例一致。
 */
public class BooxPenBridge {
    private static final String TAG = "BooxPenBridge";

    private final Activity activity;
    private final WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private TouchHelper touchHelper;
    private boolean sdkAvailable;
    private boolean rawOpened;
    // JS 侧期望的开关状态，onPause/onResume 时据此恢复
    private volatile boolean wantEnabled;
    // TouchHelper 的物理书写区。区域内专属书写，区域外专属 WebView UI。
    private final List<Rect> activeDrawingRects = new ArrayList<>();
    private volatile boolean rawStrokeActive;
    private String pendingRectsJson;
    private boolean refreshDeferred;
    private boolean activityResumed;
    private boolean uiGesturePaused;
    private boolean refreshPaused;
    private int uiPointerId = -1;
    // 用于丢弃快速连点期间过期的 WebView 视觉提交回调。
    private long visualCommitToken;
    private boolean resumeAfterNextDraw;
    // 最近一次按下的输入工具类型（手指 / 触控笔），供阅读界面区分翻页与套索。
    // 默认手指：检测失败时退化为"点触翻页"，不会误吞翻页操作。
    private volatile int lastToolType = MotionEvent.TOOL_TYPE_FINGER;

    private final RawInputCallback rawInputCallback = new RawInputCallback() {
        @Override
        public void onBeginRawDrawing(boolean b, TouchPoint touchPoint) {
            rawStrokeActive = true;
        }

        @Override
        public void onEndRawDrawing(boolean b, TouchPoint touchPoint) {
            finishRawStroke();
        }

        @Override
        public void onRawDrawingTouchPointMoveReceived(TouchPoint touchPoint) {
        }

        @Override
        public void onRawDrawingTouchPointListReceived(TouchPointList touchPointList) {
            sendStroke(touchPointList, false);
        }

        @Override
        public void onBeginRawErasing(boolean b, TouchPoint touchPoint) {
            rawStrokeActive = true;
        }

        @Override
        public void onEndRawErasing(boolean b, TouchPoint touchPoint) {
            finishRawStroke();
        }

        @Override
        public void onRawErasingTouchPointMoveReceived(TouchPoint touchPoint) {
        }

        @Override
        public void onRawErasingTouchPointListReceived(TouchPointList touchPointList) {
            sendStroke(touchPointList, true);
        }
    };

    public BooxPenBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        try {
            touchHelper = TouchHelper.create(webView, rawInputCallback);
            sdkAvailable = touchHelper != null;
        } catch (Throwable t) {
            Log.w(TAG, "Onyx Pen SDK unavailable, fallback to plain WebView: " + t);
            sdkAvailable = false;
        }
    }

    @JavascriptInterface
    public boolean isAvailable() {
        return sdkAvailable;
    }

    /**
     * 由 MainActivity 的 WebView 在 dispatchTouchEvent 中调用，记录每次按下的工具类型。
     * 在 UI 线程同步执行，先于 WebView 把事件派发给页面 JS，因此 JS 在 pointerdown
     * 里调用 {@link #isStylusActive()} 读到的就是本次手势的工具类型。
     */
    public void onWebViewTouchEvent(MotionEvent event) {
        if (event == null) {
            return;
        }
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN || action == MotionEvent.ACTION_POINTER_DOWN
                || action == MotionEvent.ACTION_HOVER_ENTER || action == MotionEvent.ACTION_HOVER_MOVE) {
            try {
                lastToolType = event.getToolType(event.getActionIndex());
            } catch (Throwable t) {
                lastToolType = MotionEvent.TOOL_TYPE_FINGER;
            }
        }
        if ((action == MotionEvent.ACTION_HOVER_ENTER || action == MotionEvent.ACTION_HOVER_MOVE)
                && uiPointerId == -1 && wantEnabled && !activeDrawingRects.isEmpty()) {
            int index = event.getActionIndex();
            int toolType = event.getToolType(index);
            if (isStylusTool(toolType)
                    && isInsideActiveDrawingRect(event.getX(index), event.getY(index))) {
                resumeForDrawingGesture();
            }
            return;
        }
        if (action == MotionEvent.ACTION_DOWN && wantEnabled && !activeDrawingRects.isEmpty()) {
            boolean inside = isInsideActiveDrawingRect(event.getX(), event.getY());
            int toolType = event.getToolType(0);
            if (inside) {
                // 画布内的手指/手掌不切换 TouchHelper；笔则可抢先恢复直写。
                if (isStylusTool(toolType)) {
                    resumeForDrawingGesture();
                }
            } else if (!rawStrokeActive) {
                pauseForUiGesture(event.getPointerId(0));
            }
        } else if (action == MotionEvent.ACTION_POINTER_DOWN && uiPointerId == -1
                && wantEnabled && !activeDrawingRects.isEmpty()) {
            int index = event.getActionIndex();
            if (isStylusTool(event.getToolType(index))
                    && isInsideActiveDrawingRect(event.getX(index), event.getY(index))) {
                resumeForDrawingGesture();
            }
        }
    }

    /** 在 WebView 已完成本次输入分发后调用，确保 click/onclick 先于视觉提交。 */
    public void onWebViewTouchEventDispatched(MotionEvent event) {
        if (event == null || uiPointerId == -1) {
            return;
        }
        int action = event.getActionMasked();
        boolean finished = action == MotionEvent.ACTION_CANCEL || action == MotionEvent.ACTION_UP;
        if (action == MotionEvent.ACTION_POINTER_UP) {
            finished = event.getPointerId(event.getActionIndex()) == uiPointerId;
        }
        if (!finished) {
            return;
        }
        uiPointerId = -1;
        if (uiGesturePaused) {
            requestVisualCommit();
        }
    }

    /** WebView 已经真正执行完一次 draw；下一个主线程任务再恢复 Onyx 直写。 */
    public void onWebViewDrawn() {
        if (!resumeAfterNextDraw) {
            return;
        }
        final long token = visualCommitToken;
        resumeAfterNextDraw = false;
        mainHandler.post(() -> {
            if (token != visualCommitToken) {
                return;
            }
            uiGesturePaused = false;
            refreshPaused = false;
            enableRawDrawingIfAllowed("resume after WebView draw failed");
        });
    }

    private static boolean isStylusTool(int toolType) {
        return toolType == MotionEvent.TOOL_TYPE_STYLUS
                || toolType == MotionEvent.TOOL_TYPE_ERASER;
    }

    private boolean isInsideActiveDrawingRect(float x, float y) {
        int px = Math.round(x);
        int py = Math.round(y);
        for (Rect rect : activeDrawingRects) {
            if (rect.contains(px, py)) {
                return true;
            }
        }
        return false;
    }

    private void pauseForUiGesture(int pointerId) {
        invalidateVisualCommit();
        uiPointerId = pointerId;
        uiGesturePaused = true;
        try {
            // Onyx raw mode 会冻结 WebView 刷新；UI 手势必须完整退出 raw mode。
            touchHelper.setRawDrawingEnabled(false);
        } catch (Throwable t) {
            Log.w(TAG, "pause for UI gesture failed", t);
        }
        webView.invalidate();
    }

    private void resumeForDrawingGesture() {
        if (uiPointerId != -1 || !wantEnabled || !activityResumed) {
            return;
        }
        if (!uiGesturePaused && !refreshPaused && !resumeAfterNextDraw) {
            return;
        }
        invalidateVisualCommit();
        uiGesturePaused = false;
        refreshPaused = false;
        enableRawDrawingIfAllowed("resume for drawing gesture failed");
    }

    private void enableRawDrawingIfAllowed(String failureMessage) {
        if (!sdkAvailable || !wantEnabled || !activityResumed
                || uiGesturePaused || refreshPaused || uiPointerId != -1) {
            return;
        }
        try {
            // 明确同时恢复 render 和 RawInputReader，不依赖 SDK 内部旧标志。
            touchHelper.setRawDrawingRenderEnabled(true);
            touchHelper.setRawDrawingEnabled(true);
        } catch (Throwable t) {
            Log.w(TAG, failureMessage, t);
        }
    }

    private void invalidateVisualCommit() {
        visualCommitToken++;
        resumeAfterNextDraw = false;
    }

    private void requestVisualCommit() {
        final long token = ++visualCommitToken;
        resumeAfterNextDraw = false;
        try {
            webView.postVisualStateCallback(token, new WebView.VisualStateCallback() {
                @Override
                public void onComplete(long requestId) {
                    if (requestId != visualCommitToken) {
                        return;
                    }
                    resumeAfterNextDraw = true;
                    webView.invalidate();
                }
            });
        } catch (Throwable t) {
            Log.w(TAG, "visual state callback failed", t);
            // 不用固定延时兜底；至少等待一次真实 onDraw。
            resumeAfterNextDraw = true;
            webView.invalidate();
        }
    }

    private void finishRawStroke() {
        rawStrokeActive = false;
        mainHandler.post(() -> {
            if (pendingRectsJson != null) {
                String json = pendingRectsJson;
                pendingRectsJson = null;
                applyRects(json);
            }
            if (refreshDeferred) {
                refreshDeferred = false;
                beginVisualRefresh();
            }
        });
    }

    /** 最近一次按下是否为触控笔（手写笔）。pointerType 缺失时 JS 侧据此判定。 */
    @JavascriptInterface
    public boolean isStylusActive() {
        return lastToolType == MotionEvent.TOOL_TYPE_STYLUS;
    }

    /** 原始工具类型（MotionEvent.TOOL_TYPE_*），调试用。 */
    @JavascriptInterface
    public int getLastToolType() {
        return lastToolType;
    }

    /**
     * json: {"rects":[[l,t,r,b],...], "width":4.5}，坐标为 WebView 视图内的物理像素。
     */
    @JavascriptInterface
    public void setRects(final String json) {
        if (!sdkAvailable) {
            return;
        }
        mainHandler.post(() -> applyRects(json));
    }

    @JavascriptInterface
    public void disable() {
        if (!sdkAvailable) {
            return;
        }
        mainHandler.post(this::disableInternal);
    }

    /** JS 在同步完工具状态/DOM 后调用，补充异步 UI 的精确提交点。 */
    @JavascriptInterface
    public void commitUi() {
        if (!sdkAvailable) {
            return;
        }
        mainHandler.post(() -> {
            if (uiGesturePaused || refreshPaused) {
                requestVisualCommit();
            }
        });
    }

    /**
     * 短暂退出直渲染并强制重绘，让 WebView 中已提交的笔迹内容刷新上屏
     * （撤销/清空/橡皮擦除后调用）。
     */
    @JavascriptInterface
    public void refresh() {
        if (!sdkAvailable) {
            return;
        }
        mainHandler.post(() -> {
            if (!wantEnabled) {
                return;
            }
            if (rawStrokeActive) {
                refreshDeferred = true;
                return;
            }
            beginVisualRefresh();
        });
    }

    private void beginVisualRefresh() {
        if (!wantEnabled) {
            return;
        }
        try {
            touchHelper.setRawDrawingEnabled(false);
        } catch (Throwable t) {
            Log.w(TAG, "refresh disable failed", t);
        }
        refreshPaused = true;
        requestVisualCommit();
        webView.invalidate();
    }

    private void applyRects(String json) {
        if (rawStrokeActive) {
            pendingRectsJson = json;
            return;
        }
        try {
            JSONObject obj = new JSONObject(json);
            JSONArray arr = obj.getJSONArray("rects");
            float width = (float) obj.optDouble("width", 4.0);
            List<Rect> rects = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                JSONArray r = arr.getJSONArray(i);
                Rect rect = new Rect(r.getInt(0), r.getInt(1), r.getInt(2), r.getInt(3));
                if (!rect.isEmpty()) {
                    rects.add(rect);
                }
            }
            if (rects.isEmpty()) {
                disableInternal();
                return;
            }
            activeDrawingRects.clear();
            activeDrawingRects.addAll(rects);
            touchHelper.setRawDrawingEnabled(false);
            touchHelper.setStrokeWidth(width).setLimitRect(rects, new ArrayList<>());
            if (!rawOpened) {
                touchHelper.openRawDrawing();
                rawOpened = true;
                touchHelper.setStrokeStyle(TouchHelper.STROKE_STYLE_PENCIL);
            }
            if (rects.size() > 1) {
                touchHelper.setMultiRegionMode();
            } else {
                touchHelper.setSingleRegionMode();
            }
            wantEnabled = true;
            refreshPaused = true;
            requestVisualCommit();
            webView.invalidate();
        } catch (Throwable t) {
            Log.w(TAG, "setRects failed: " + json, t);
        }
    }

    private void disableInternal() {
        wantEnabled = false;
        refreshPaused = false;
        refreshDeferred = false;
        pendingRectsJson = null;
        activeDrawingRects.clear();
        try {
            touchHelper.setRawDrawingEnabled(false);
        } catch (Throwable t) {
            Log.w(TAG, "disable failed", t);
        }
        webView.invalidate();
    }

    private void sendStroke(TouchPointList touchPointList, boolean erase) {
        if (touchPointList == null || touchPointList.getPoints() == null
                || touchPointList.getPoints().isEmpty()) {
            return;
        }
        List<TouchPoint> points = touchPointList.getPoints();
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < points.size(); i++) {
            TouchPoint p = points.get(i);
            if (i > 0) {
                sb.append(',');
            }
            sb.append('[')
                    .append(String.format(Locale.US, "%.1f", p.getX())).append(',')
                    .append(String.format(Locale.US, "%.1f", p.getY())).append(',')
                    .append(String.format(Locale.US, "%.2f", normalizePressure(p.getPressure())))
                    .append(']');
        }
        sb.append(']');
        final String js = "window.__booxPen&&window.__booxPen.onStroke(" + sb + "," + erase + ");";
        mainHandler.post(() -> webView.evaluateJavascript(js, null));
    }

    private static float normalizePressure(float pressure) {
        if (pressure <= 0f) {
            return 0.5f;
        }
        if (pressure <= 1f) {
            return pressure;
        }
        // 部分设备回报 0~4096 的原始压感值
        return Math.min(1f, pressure / 4096f);
    }

    public void onResume() {
        activityResumed = true;
        if (resumeAfterNextDraw || uiGesturePaused || refreshPaused) {
            webView.invalidate();
        } else {
            enableRawDrawingIfAllowed("onResume enable failed");
        }
    }

    public void onPause() {
        activityResumed = false;
        uiPointerId = -1;
        uiGesturePaused = false;
        refreshPaused = false;
        refreshDeferred = false;
        rawStrokeActive = false;
        pendingRectsJson = null;
        invalidateVisualCommit();
        if (sdkAvailable) {
            try {
                touchHelper.setRawDrawingEnabled(false);
            } catch (Throwable t) {
                Log.w(TAG, "onPause disable failed", t);
            }
        }
    }

    public void onDestroy() {
        invalidateVisualCommit();
        if (sdkAvailable && rawOpened) {
            try {
                touchHelper.closeRawDrawing();
            } catch (Throwable t) {
                Log.w(TAG, "closeRawDrawing failed", t);
            }
        }
    }
}
