# Math Reader

本地优先的数学学习工作台——阅读、课堂、AI 讲义、手写笔记、间隔复习、习题训练，一个应用全部搞定。

[中文说明](#功能) · [English](#english) · [Releases](https://github.com/none0enon/math-reader-boox/releases) · [Issues](https://github.com/none0enon/math-reader-boox/issues)

---

## 功能

### 书架与阅读

导入 PDF / ePub / TeX 文件。PDF 拥有完整阅读器：页码导航、关键词搜索、OCR 搜索、自由批注（画笔 + 颜色 + 粗细 + 撤销重做 + 整笔橡皮 + 图片插入）、底部草稿纸，以及每个文档独立的 AI 对话。

**套索问 AI**：圈选 PDF 任意区域，自动合成原页与批注截图发给视觉模型，回答以编号标记保存在页面上，随时查看或删除。

### AI 讲义与论文摘要

为 PDF 书籍一键生成大纲 → 分章节讲义（首章优先，其余按需生成）。讲义阅读器支持上下章切换、返回原书页、字号调整、画笔、草稿和选中文本问 AI。

为论文生成结构化摘要，同一阅读器渲染公式和进度记录。

### 课堂

按课程/讲座/场次三级组织课堂内容。场次内可录音、拍照、上传文件（图片 / 音频 / PDF / Word / Markdown / TeX 等）。素材上传后自动生成带来源引用的 AI 笔记；录音停止后生成转写纪要。

### 手写笔记

模板化笔记本（空白 / 宽横线 / 窄横线 / 康奈尔 / 会议记录），三支可配置画笔、整笔橡皮、撤销重做、套索、文本框、图形工具（圆 / 矩形 / 三角 / 直线 / 曲线 / 箭头 / 二维三维坐标系）、页面管理（插页 / 删页 / PDF 导入）、图片音频插入、缩略图 / 大纲 / 搜索、PDF 导出。

手写内容可用 AI 识别建立索引，支持全本搜索。

### 间隔复习

在任意笔记页点击"加入复习"，AI 生成 Quiz。计划按 当天 → 2天 → 4天 → 7天 → 21天 推进，手写作答后 AI 按 10 分制评分、逐题核对并给出完整解答，然后自动生成下一阶段 Quiz。

### 习题训练

从图片或 PDF 导入题目，AI 自动拆分题号。手写作答、计时（1–120 分钟），完成后视觉模型批改并返回评分、正确解法、严谨性建议、知识缺口和同类练习。错题自动归档，可重做、问 AI、管理。

支持**习题集上传**：对多页 PDF 手动分组或按 N 页自动裁切，批量生成习题任务。

### 数据

- **本地持久化**：所有数据存储在本地，阅读进度、笔记、录音均自动保存。
- **完整 ZIP 备份**：一键打包所有元数据、资料、批注、讲义、课堂素材/录音、习题、笔记本和设置。
- **Cloudflare R2 同步**（可选）：配置 Access Key / Secret / Endpoint / Bucket，支持手动或定时/变更自动同步，实现多设备数据同步。

> API Key 和 R2 配置只保存在本地设备，不会随云端元数据同步。ZIP 备份包含本机设置，请当敏感文件保管。

---

## AI 配置

**设置 → API Setting**，选择 DeepSeek / OpenAI / Google / Claude / Custom，填写服务地址、API Key 和模型名。可选配置 Backup API 做故障切换。

不同功能对模型的要求：

| 功能 | 要求 |
|---|---|
| 问答、讲义、摘要 | 长文本 + LaTeX 输出 |
| 套索问 AI、手写识别、识题、批改 | 视觉模型（图片输入） |
| 课堂录音转写 | 音频输入支持 |
| 大纲/讲义生成 | PDF 附件调用支持 |

普通阅读、手写和本地数据管理不需要配置 AI。

---

## 安装

从 [Releases](https://github.com/none0enon/math-reader-boox/releases) 下载签名 APK。最低 Android 8.0。后续更新直接覆盖安装，不要先卸载（卸载会清除本地数据）。

首次安装默认英文界面，在 **Settings → Language Settings → Interface Language** 切换中文或法语。建议先在 **设置 → 存储持久化** 请求授权。

> 旧测试版签名不同时，先导出 ZIP 备份，确认保存成功，再卸载旧版安装正式版。

---

## 常见问题

| 问题 | 解决 |
|---|---|
| ePub/LaTeX 打不开 | 当前阅读器仅完整支持 PDF，请先转换格式 |
| 文字对话正常但套索/识题/批改失败 | 需要视觉模型，检查模型名、额度和图片大小 |
| 提示先生成大纲 | 讲义依赖大纲，先执行 书架 → AI → 生成大纲 |
| OCR 搜不到扫描件 | 确认已配置视觉/OCR 服务，识别质量取决于扫描清晰度 |
| 找不到导出的文件 | 检查 Android 下载目录 |
| 覆盖安装签名冲突 | 先导出 ZIP，再卸载旧版安装正式版 |

遇到问题请提交 [Issue](https://github.com/none0enon/math-reader-boox/issues)，附上 APK 版本、设备信息、复现步骤和截图。**隐藏 API Key 和私人资料。**

---

<a id="english"></a>

## English

A local-first math study workbench — reading, classroom, AI lectures, handwriting notes, spaced review, and exercise training in one app.

### Features

**Library & Reader** — Import PDF/ePub/TeX. The PDF reader provides page navigation, keyword & OCR search, freehand annotation (pen, colors, widths, undo/redo, stroke eraser, image insert), a scratchpad, and per-document AI chat. **Lasso Ask AI** captures any PDF region with annotations, sends the screenshot to a vision model, and saves answers as numbered page markers.

**AI Lectures & Abstracts** — Generate an outline for a PDF book, then chapter-by-chapter lectures (first chapter prioritized, rest on demand). The lecture viewer supports chapter navigation, jump to source page, font sizing, drawing, scratchpad, and inline AI Q&A. Paper abstracts use the same math-aware viewer.

**Class** — Organize sessions under courses/seminars. Record audio, take photos, or upload files (images, audio, PDF, Word, Markdown, TeX, etc.). Uploads automatically produce AI notes with source references; recordings generate transcripts.

**Handwriting Notes** — Templated notebooks (blank, wide/narrow ruled, Cornell, meeting notes) with configurable brushes, stroke eraser, undo/redo, lasso, text, shapes (circle, rectangle, triangle, line, curve, arrow, 2D/3D axes), page management (insert/delete/PDF import), media insertion, thumbnails/outline/search, and PDF export. AI-powered handwriting indexing enables full-notebook search.

**Spaced Review** — Add any note page to review. AI generates a Quiz with stages at day 0, 2, 4, 7, and 21. Handwrite answers, get 0–10 scoring with per-question checks and full solutions, then auto-advance to the next stage.

**Exercises** — Import problems from images or PDFs; AI splits them by question number. Handwrite answers with a 1–120 min timer, then a vision model grades and returns scores, correct solutions, rigor feedback, knowledge gaps, and similar problems. Wrong answers auto-archive for redo and review. **Exercise Set Upload** supports manual grouping or auto N-page splitting for multi-page PDFs.

**Data** — Local-first storage with automatic progress saving. Full ZIP backup packages everything. Optional Cloudflare R2 sync for multi-device use. API keys stay local and never sync to cloud metadata.

### AI Setup

**Settings → API Setting**: choose DeepSeek / OpenAI / Google / Claude / Custom, enter endpoint, API key, and model. Optional backup provider for failover.

| Feature | Requires |
|---|---|
| Chat, lectures, abstracts | Strong text + LaTeX model |
| Lasso, handwriting, extraction, grading | Vision model (image input) |
| Classroom transcription | Audio input support |
| Outline/lecture generation | PDF attachment support |

Reading, handwriting, and local data management work without AI.

### Install

Download a signed APK from [Releases](https://github.com/none0enon/math-reader-boox/releases). Requires Android 8.0+. Update by installing over the existing app — do not uninstall first (uninstalling deletes local data).

Fresh installs default to English. Switch language at **Settings → Language Settings → Interface Language**. Grant **Storage Persistence** on first launch.

> Migrating from an older test build with a different signature? Export a full ZIP first, verify it saved, then uninstall and install the stable build.

### FAQ

| Problem | Solution |
|---|---|
| ePub/LaTeX won't open | Current reader is PDF-only; convert first |
| Text chat works but lasso/extraction/grading fails | Requires a vision model; check model name, quota, and image size |
| "Generate outline first" prompt | Lectures depend on outlines — run Library → AI → Generate Outline |
| OCR finds nothing in scans | Configure a vision/OCR service; quality depends on scan clarity |
| Can't find exported files | Check Android Downloads folder |
| Signature conflict on update | Export ZIP, uninstall old build, install stable signed APK |

For unresolved issues, open an [Issue](https://github.com/none0enon/math-reader-boox/issues) with APK version, device info, steps to reproduce, and screenshots. **Remove API keys and private content.**

---

## BOOX / E-Ink

BOOX 适配是 Android 发行版的附加层，不影响上述任何功能。支持的 BOOX 设备自动启用 Onyx `TouchHelper` 原生低延迟直渲染，覆盖 PDF 批注、笔记本、习题、复习 Quiz、草稿和讲义画笔。非 BOOX 设备回退到标准 WebView 输入，功能不受影响。开启 **墨水屏模式** 后手指翻页、触控笔书写。

BOOX adaptation is an add-on layer for the Android build and does not change any workflow above. Supported BOOX devices auto-enable Onyx `TouchHelper` for low-latency native pen rendering across PDF annotations, notebooks, exercises, review quizzes, scratchpads, and lecture drawing. Non-BOOX devices fall back to standard WebView input with no feature loss. Enable **E-Ink Mode** for finger-tap page turning and stylus writing.

---

## 开发 / Development

### 架构 / Architecture

```
MainActivity (fullscreen WebView)
├── assets/www/     ← Math Reader web app
├── boox-pen.js     ← injected pen adapter
└── TouchHelper     ← Onyx handwriting SDK (BOOX only)
```

WebView 通过 `https://appassets.androidplatform.net` 同源加载 assets 中的页面。`boox-pen.js` 自动探测画布，将可见区域交给原生 `TouchHelper` 做 EPD 直渲染；抬笔后以合成 PointerEvent 回放给页面，绘制和保存逻辑由 Math Reader 管理。非 BOOX 设备 SDK 初始化失败时自动降级。

### 构建 / Build

CI 自动构建。本地构建需要 Android SDK 和 `repo.boox.com` 访问：

```bash
./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

`versionCode` 随 CI workflow run 自增，基数存储在仓库变量 `APK_VERSION_CODE_BASE`。

### 同步上游 / Sync Upstream

`manifest.json`、`sw.js`、图标可直接覆盖。`index.html` 包含阅读器画笔/套索补丁，必须手动 diff 合并。

```bash
cp ../math-reader/{manifest.json,sw.js,icon-infinity-white.svg} app/src/main/assets/www/
# index.html — manual diff merge, do not overwrite
```

### 关键文件 / Key Files

| 文件 | 职责 |
|---|---|
| `app/.../MainActivity.java` | WebView shell, file picker, download, recording, stylus tool reporting |
| `app/.../BooxPenBridge.java` | `TouchHelper` wrapper and JS bridge |
| `assets/boox-pen.js` | Canvas detection, native stroke replay, stylus detection |
| `assets/www/` | Math Reader web app resources |
