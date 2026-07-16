# math-reader-boox

[math-reader](https://github.com/none0enon/math-reader) PWA 的 Boox 墨水屏专用 APK 封装：
功能与 math-reader 完全一致，仅手写部分接入 Boox 官方手写 SDK（onyxsdk-pen），
在 Boox Tab / Note / Go 系列（如 Tab 10.3 / Go 10.3 Gen2）上获得原生级低延迟书写体验。

## 工作原理

```
┌──────────────────────────────────────────────┐
│ MainActivity (全屏 WebView)                   │
│   ├── assets/www/  ← math-reader PWA 原样打包 │
│   ├── boox-pen.js  ← 页面加载后注入的适配器    │
│   └── TouchHelper  ← Onyx 手写 SDK 直渲染层   │
└──────────────────────────────────────────────┘
```

1. WebView 通过 `https://appassets.androidplatform.net` 同源加载打包在 assets 里的
   PWA（localStorage / IndexedDB 正常持久化）。`index.html` 基本与上游一致，仅带
   少量**阅读器画笔 / 套索模式补丁**（见下文同名章节），升级时需手动合并。
2. 注入的 `boox-pen.js` 自动探测当前可手写的画布（习题作答、复习 Quiz、PDF 批注、草稿纸、
   讲义画笔），把画布区域交给原生 `TouchHelper` 做 EPD 低延迟直渲染。
3. 抬笔后 SDK 回调整笔触点，适配器以合成 PointerEvent 回放给页面——PWA 自己的
   绘制、撤销、保存逻辑全部照常工作，数据仍存在 PWA 一侧。
4. PWA 工具栏切到橡皮擦时自动挂起直渲染，走 PWA 默认事件路径；笔杆侧橡皮
   （raw erasing）则映射回 PWA 的橡皮逻辑。
5. 另外桥接了 WebView 不支持的能力：`<input type="file">` 文件选择、
   blob/data 下载落盘（导出 PDF / JSON 备份）。
6. `BooxPenBridge` 在 WebView 的 `dispatchTouchEvent` 里记录每次按下的工具类型
   （手指 / 触控笔），通过 `BooxPenNative.getLastToolType()` 暴露给页面；
   `boox-pen.js` 据此提供 `window.__booxInput.isPen(e)` 给阅读界面做触控笔检测。

非 Boox 设备上 SDK 初始化失败时自动降级为普通 WebView 应用，功能不受影响；
`window.__booxInput` 仍可用（退化为标准 `PointerEvent.pointerType`）。

## 阅读器画笔 / 套索模式（index.html 本地补丁）

阅读工具栏在两个明确模式间切换：

- **画笔模式** → 在 PDF 批注画布书写；Boox 上使用原生 `TouchHelper` 低延迟直渲染。
- **套索模式** → 在 PDF 页上自由圈选，合成 PDF 与手写批注后按套索多边形截图，
  弹出已有“问 AI”输入框并把截图发给视觉 AI。普通阅读可直接使用鼠标、触摸或触控笔；
  套索按钮 SVG、蓝色虚线参数均复用笔记页面现有实现，交互层复用 `.reader-text-layer`，
  反馈层复用 `.eink-select-overlay`，没有新增 CSS。回答继续以计数圆点 marker + 悬浮框保存。
  旧的“长按页面 → 手写识别”入口已移除，但历史笔记仍可查看和删除。

开启「设置 → 墨水屏模式」后，额外区分手指与 Boox 触控笔：

- **手指点触** → 翻页（画笔模式、套索模式都翻页）。
- **触控笔 · 画笔模式** → 原生 `TouchHelper` 低延迟书写（翻页热区为透明覆盖层，
  触控笔由原生 SDK 按屏幕矩形拦截，手指仍可穿透热区翻页）。
- **触控笔 · 套索模式** → 文字 PDF 与扫描件统一套索截图并发给视觉 AI。
  AI 回答以**计数圆点 marker + comment 悬浮框**呈现（存为 `doc.annotations` 中
  `type:'note', ai:true` 的标注，点圆点看回答、可删除）。
- 套索模式下把可见页 `placeholder` 抬到翻页热区之上（`z-index:37`）使交互层接管触控笔；
  翻页热区与交互层均设 `touch-action:none`，避免笔移动被识别为滚动而 `pointercancel`
  打断选取（这正是早期"画一点就断"的根因）。
- 模式切换会调用 `__booxPen.syncRegions()` 立即重算原生书写区域，避免等待 350ms 轮询时
  第一笔套索仍被旧批注区域截获。

## 构建

GitHub Actions 在每个同仓库 PR 以及 `main` 更新后自动构建；默认分支上的独立
`Sign APK` workflow 会下载构建产物、核对包名和版本，再使用长期 CI 密钥签名。到仓库
**Actions → Sign APK → Artifacts** 下载 `math-reader-boox-1.0.2-ci.*`。
`versionCode` 随 `Build APK` workflow run 自动递增，因此不同 PR 的 APK 可以直接覆盖更新。
fork PR 不接触签名密钥，只保留一天的 unsigned 编译产物。

版本号基数保存在仓库变量 `APK_VERSION_CODE_BASE`。不要降低它；如果删除或重建
`Build APK` workflow 导致 run number 重新计数，应先提高该基数，避免新 APK 被判定为降级。

本地构建（需要 Android SDK，且能访问 `repo.boox.com`）：

```bash
./gradlew assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk
```

## 安装

Boox 设备开启「未知来源安装」，把 APK 拷到设备上点击安装即可。

从 2026-07-16 之前的临时 debug 签名 APK 迁移时，因为旧签名私钥无法恢复，需要先在应用内
导出或云端备份数据，卸载旧版并安装一次新的稳定签名版。此后下载新的 signed APK 直接安装
即可覆盖更新，不再需要卸载，应用数据也会保留。

CI 签名密钥不得删除或替换；丢失后将无法继续覆盖更新已安装的 APK。密钥只存放在
限制为 `main` 的 GitHub `apk-signing` Environment Secrets 与仓库外的受密码保护备份中，
不提交到 Git。

## 同步上游 math-reader

`manifest.json` / `sw.js` / 图标可直接覆盖；`index.html` 因带有「阅读器画笔 / 套索模式」
本地补丁，**不能整文件覆盖**，需手动合并上游改动后保留下列补丁点：

```bash
cp ../math-reader/{manifest.json,sw.js,icon-infinity-white.svg} \
   app/src/main/assets/www/
# index.html 手动 diff 合并，勿覆盖
```

`index.html` 的阅读器补丁集中在这些标识符上（搜索即可定位）：
`booxReaderIsPen`、`bindEinkReaderTapZone`、`einkPageTurnByClientX`、`einkHandleReaderTap`、
`buildReaderTextLayer`、`attachReaderTextLayerInput`、`applyReaderInputMode`、
`clearReaderTextSelection`、`einkSelect*`、`einkCropPageRegion`、
`askAIAboutReaderSelection`、
`addDocAiComment`、`renderPageNoteMarkers`（`n.ai` 分支）、
`renderSinglePage`/`einkShowPage`/`applyPenModeUI`/`toggleEinkMode`（末尾调 `applyReaderInputMode`）、
以及 CSS 的 `.reader-text-layer` / `.ai-marker` / `.ai-bubble` / `.eink-select-overlay`、
HTML 的 `#readerSelectionMenu`。

`boox-pen.js` 依赖 PWA 中以下约定（变更时需同步调整适配器）：

| 画布 | 选择器 | 橡皮按钮 / 切换函数 |
|---|---|---|
| 习题作答 | `#exerciseDoingCanvas` | `#exEraserBtn` / `toggleExEraser()` |
| 笔记复习 Quiz | `#nbQuizFsCanvas` | `#qzEraserBtn` / `toggleQzEraser()` |
| PDF 批注 | `.annotation-canvas` | `#readerEraserBtn` / `toggleReaderEraser()` |
| 草稿纸 | `#draftCanvas`、`#lectureDraftCanvas` | — |
| 讲义画笔 | `#lectureDrawCanvas` | — |

## 关键文件

- `app/src/main/java/com/mathreader/boox/MainActivity.java` — WebView 壳、文件选择、下载、触控笔工具类型上报
- `app/src/main/java/com/mathreader/boox/BooxPenBridge.java` — TouchHelper 封装 + JS 桥 + 工具类型检测（`getLastToolType` / `isStylusActive`）
- `app/src/main/assets/boox-pen.js` — 画布探测 / 笔迹回放适配器 + 触控笔检测 `window.__booxInput`
- `app/src/main/assets/www/` — math-reader PWA（`index.html` 含墨水屏阅读增强补丁）
