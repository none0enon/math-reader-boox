# math-reader-boox

[math-reader](https://github.com/none0enon/math-reader) PWA 的 Boox 墨水屏专用 APK 封装：
功能与 math-reader 完全一致，仅手写部分接入 Boox 官方手写 SDK（onyxsdk-pen），
在 Boox Tab / Note / Go 系列（如 Tab 10.3 / Go 10.3 Gen2）上获得原生级低延迟书写体验。

An Android APK wrapper for the [math-reader](https://github.com/none0enon/math-reader) PWA,
optimized for BOOX E Ink devices with the official Onyx pen SDK and native low-latency handwriting.

[中文使用说明](#中文使用说明) · [English User Guide](#english-user-guide) · [下载 / Download](https://github.com/none0enon/math-reader-boox/releases/latest)

<a id="中文使用说明"></a>

## 中文使用说明

### 1. 设备与系统要求

- Android 8.0（API 26）或更高版本。
- 支持 `armeabi-v7a` 或 `arm64-v8a` 的设备。
- 推荐使用带原厂触控笔的 BOOX Tab、Note、Go 系列设备。非 BOOX Android 设备也可以运行，但会自动退化为普通 WebView 书写，无法获得 Onyx SDK 的原生低延迟效果。
- AI、OCR、云同步以及部分通过网络加载的组件需要联网。阅读本地文档不要求配置 AI 服务。

### 2. 下载与安装

1. 打开 [Releases](https://github.com/none0enon/math-reader-boox/releases/latest)，下载最新版本中已签名的 `.apk`。请勿把 `unsigned` 构建当作正式版本安装。
2. 在 BOOX 的系统设置中允许文件管理器或浏览器“安装未知应用”。不同固件的入口名称可能略有不同。
3. 在文件管理器中点击 APK，确认安装。首次启动后，界面默认使用 English；需要中文时，进入 **Settings → Language → Interface Language → 中文**。
4. 建议进入 **设置 → 用户设置**，开启 **墨水屏模式**，并点击 **存储持久化 → 请求授权**。
5. 如果要录制课堂音频，请在系统提示时授予麦克风权限；不使用录音功能时可以拒绝。

后续更新时，下载新的正式签名 APK 并直接覆盖安装即可，应用数据会保留。不要在升级前卸载应用，因为卸载会清除本地数据。

> **旧测试版迁移：** 如果安装的是 2026-07-16 之前使用临时 debug 签名的 APK，新版无法直接覆盖。请先在 **设置 → 数据管理 → 导出数据** 创建 ZIP 备份，卸载旧版，安装正式签名版，再导入备份。之后的正式版本可以直接覆盖更新。

### 3. 首次启动推荐设置

| 设置项 | 建议 | 说明 |
|---|---|---|
| 界面语言 | 中文或 English | 位于 **设置 → 语言设置**；新安装默认 English。 |
| 墨水屏模式 | BOOX 上开启 | 阅读器改为点按翻页，并区分手指与触控笔。 |
| 优化书写延迟 | 开启 | 优化习题等手写区域的墨水屏直渲染。 |
| 存储持久化 | 请求授权 | 降低系统自动清理本地文档和笔记数据的风险。 |
| 习题时间 | 按需设置 | 每题 1–120 分钟，默认 20 分钟。 |
| API Setting | 可选 | 仅使用 AI、OCR、转写或内容生成功能时需要。 |
| R2 云同步 | 可选 | 用于自建跨设备备份与恢复，不能替代定期 ZIP 备份。 |

### 4. 界面导航

底部导航包含七个模块：

| 模块 | 用途 |
|---|---|
| 课堂 | 按课程或讲座整理资料、录音和 AI 转写纪要。 |
| 书架 | 导入和管理书籍、论文，进入阅读器。 |
| 阅读 | 阅读文档、搜索、手写批注、套索问 AI 和使用草稿纸。 |
| 讲义 | 查看由书籍生成的分节讲义和论文摘要。 |
| 笔记 | 创建自由笔记本并安排间隔复习 Quiz。 |
| 习题 | 导入题目、手写作答、AI 评分、管理错题。 |
| 设置 | 配置语言、墨水屏、AI、主题、同步和备份。 |

### 5. 导入与管理文档

1. 进入 **书架**，点击“书籍”或“论文”栏的空白处。
2. 选择本地文件。当前导入入口支持 PDF、EPUB、TeX 和 LaTeX 文件（`.pdf`、`.epub`、`.tex`、`.latex`）。
3. 可修改标题并填写可选摘要，然后点击 **添加**。
4. 点击卡片开始阅读；长按卡片可以 **存档** 或 **删除**。存档内容可从书架右上角的 **存档** 恢复。

PDF 是功能最完整的格式：页面搜索、OCR 搜索、按页批注、套索截图问 AI、生成大纲和按页生成讲义均以 PDF 为主要工作流。AI 大纲目前仅支持 PDF 书籍。

### 6. 阅读、翻页与搜索

- 从书架打开文档后，应用会记录当前页和阅读进度。
- 使用底部上一页/下一页按钮翻页；点击页码可输入目标页码跳转。
- 点击顶部放大镜进行文本搜索，可选择区分大小写。扫描版 PDF 没有文本层时，可使用 **OCR 识别搜索**；该功能需要正确配置可识图的 AI/API 服务。
- 阅读页底部的细条可展开草稿面板。草稿支持文字、加粗、斜体、删除线、待办，以及画笔、橡皮、撤销、重做和清空画布。
- 点击阅读器顶部的 **AI** 可就当前文档和当前页提问。聊天记录按文档保存，并可导出。

开启 **墨水屏模式** 后：

- 手指点按页面左右区域翻页。
- 触控笔输入由当前的“画笔/套索”模式决定。
- 页面采用更适合 E Ink 的单页显示与点击翻页方式。

### 7. 触控笔：画笔模式与套索模式

阅读器右上角的模式按钮在两种状态间切换：

**画笔模式**

- 使用 BOOX 触控笔直接在 PDF 上书写；可选择颜色和粗细。
- 支持撤销、重做、橡皮擦和插入图片。
- BOOX 上由 Onyx `TouchHelper` 进行低延迟直渲染；抬笔后笔迹回放到网页画布并按文档保存。
- 支持笔杆侧橡皮。切到应用内橡皮擦时，输入会交回应用自己的擦除逻辑。

**套索模式**

- 用触控笔围住 PDF 上的区域；文字 PDF 和扫描 PDF 都会把所选区域连同手写批注合成为截图。
- 在弹出的输入框中填写问题，或直接发送，让视觉 AI 分析选区。
- 回答保存为页面上的蓝色计数圆点；点击圆点查看回答，可在悬浮框中删除。

如果第一笔没有落在正确模式，请再次点击模式按钮确认图标：钢笔图标表示画笔模式，虚线套索图标表示套索模式。

### 8. AI 功能与 API 配置

应用不内置 API Key。进入 **设置 → 用户设置 → API Setting** 配置：

1. 选择主要渠道：DeepSeek、OpenAI、Google、Claude 或自定义服务。
2. 填写服务 URL、API Key 和模型名称；服务支持时可点击 **拉取模型** 后选择模型。
3. 可选配置备用 API，主要 API 失败时应用会尝试备用服务。
4. 点击 **保存设置**。Mathpix 和 Supabase 为可选服务，不使用对应功能时可留空。

配置完成后可以使用：全局数学问答、当前页问答、PDF 套索视觉问答、OCR、生成书籍大纲与讲义、生成论文摘要、课堂资料整理与录音转写、习题识别和评分、笔记复习 Quiz 等功能。具体能力取决于所选模型是否支持文本、图像、PDF 或音频输入；服务费用和数据处理规则由相应 API 提供商决定。

API Key 保存在本机，不会随 R2 云同步上传；但“完整 ZIP 备份”会包含本地设置和凭据。请勿分享备份文件。

### 9. 讲义、课堂、笔记与习题

**讲义与摘要**

- 在书架点击左上角 **AI**，选择 **生成大纲**、**生成讲义** 或 **生成摘要**，再选择对应书籍/论文。
- PDF 书籍先生成大纲，再按章节生成讲义。讲义支持上一节/下一节、返回原书对应页、下载和重新生成。
- 在讲义中选择文本，可以附加问题并让 AI 生成行内笔记。

**课堂**

- 在“课程”或“讲座”空白处新建文件夹，再创建每次课程/讲座的子文件夹。
- 可上传图片、PDF 等源素材，也可开始录音。录音期间保持应用处于前台。
- AI 可把素材或录音整理为讲义/转写纪要。长按素材或笔记可重新生成、下载或删除。

**笔记**

- 点击笔记本栏空白处创建笔记本并选择模板。
- 编辑器支持画笔、荧光笔、橡皮、套索、文本、图形、页面管理和背景图。
- 在笔记本内使用“加入复习”，AI 会生成间隔复习 Quiz；到期内容显示在复习列表中。

**习题**

- 在“新题”空白处创建文件夹，进入后通过右下角按钮上传图片/PDF，或使用“习题集上传”按页裁切批量生成题目。
- 作答页支持计时、手写、橡皮、撤销/重做和清空。完成后可由 AI 评分，错题进入错题列表。
- 可重做、归档或删除错题，也可以选择错题交给 AI 分析；任务支持整组评分和导出 PDF。

### 10. 数据备份、恢复与云同步

应用数据主要保存在 WebView 的本地存储和 IndexedDB 中。卸载应用、清除应用数据或某些系统清理操作都可能删除这些内容。

**完整 ZIP 备份（推荐定期执行）**

1. 进入 **设置 → 数据管理 → 导出数据**。
2. 停止正在进行的课堂录音后再导出。
3. 将生成的 `math-reader-full-export-YYYY-MM-DD.zip` 保存到安全位置。
4. 恢复时选择 **导入数据** 并选择该 ZIP。导入会覆盖当前本地的书籍、笔记、课堂、习题、讲义和笔记本数据，操作前请先备份现有数据。

完整 ZIP 可能包含导入的原始文件、录音、笔记、聊天记录以及本地 API/R2 凭据，应当像密码文件一样保管。若导出提示有录音未包含，请查看 ZIP 内的 `recordings/missing.json`，不要把该备份当作完整录音副本。

**Cloudflare R2 同步（可选）**

1. 在 Cloudflare 创建 R2 Bucket 和具备读写权限的 S3 API Token。
2. 进入 **设置 → 数据管理 → R2 云同步配置**，填写 Access Key ID、Secret Access Key、Endpoint URL 和存储桶名称；自定义域名可选。
3. 点击 **测试连接**，成功后保存配置。
4. 可手动选择 **同步到云端** 或 **从云端恢复**，也可以启用定时自动同步和文件变化时自动同步。

从云端恢复或在多台设备间同步前，建议先导出本地 ZIP。不要让两台设备同时进行大量编辑和同步。R2 配置及 API Key 只保存在当前设备，不会被 R2 数据覆盖。

### 11. 常见问题

**APK 无法安装或提示签名冲突**

确认下载的是正式签名 APK。若来自旧 debug 版，请先导出 ZIP，卸载旧版后重新安装。

**触控笔延迟高或笔迹没有出现**

确认设备是 BOOX，开启“墨水屏模式”和“优化书写延迟”，并确认阅读器处于画笔模式。非 BOOX 设备只能使用普通 WebView 书写。

**手指书写而不是翻页**

在 BOOX 上开启“墨水屏模式”；阅读时用手指点按翻页、用触控笔书写或套索。

**AI、OCR、讲义或评分失败**

检查网络、API URL、Key 和模型名称，并确认模型支持所需的图像、PDF 或音频输入。必要时配置备用 API。

**文档或笔记在系统清理后丢失**

在设置中请求持久化存储，并定期导出 ZIP 或配置 R2。存储持久化只能降低风险，不能替代备份。

**升级前需要做什么**

正式签名版本通常可以覆盖安装，但重要升级前仍建议导出一次完整 ZIP。不要为了升级而先卸载应用。

如问题仍未解决，请在 [Issues](https://github.com/none0enon/math-reader-boox/issues) 中提供设备型号、BOOX 固件/Android 版本、应用版本、复现步骤和必要截图；请先隐藏 API Key、R2 密钥及私人文档内容。

---

<a id="english-user-guide"></a>

## English User Guide

### 1. Requirements

- Android 8.0 (API 26) or later.
- An `armeabi-v7a` or `arm64-v8a` device.
- A BOOX Tab, Note, or Go device with the original stylus is recommended. The app also runs on other Android devices, but falls back to regular WebView input without Onyx SDK low-latency rendering.
- AI, OCR, cloud sync, and some network-loaded components require an internet connection. No AI service is required for basic local reading.

### 2. Download and install

1. Open [Releases](https://github.com/none0enon/math-reader-boox/releases/latest) and download the signed `.apk` from the latest release. Do not use an `unsigned` build as a production installation.
2. Allow your browser or file manager to “Install unknown apps” in BOOX system settings.
3. Open the APK in the file manager and confirm installation. Fresh installations default to English. To use Chinese, go to **Settings → Language → Interface Language → 中文**.
4. On BOOX, enable **Settings → User Settings → E-Ink Mode**, then select **Persistent Storage → Request Permission**.
5. Grant microphone permission only if you plan to record classes or seminars.

For later updates, install the newer officially signed APK over the existing app. Your data should remain in place. Do not uninstall first, because uninstalling removes local app data.

> **Migrating from an old test build:** APKs signed with the temporary debug key before 2026-07-16 cannot be updated in place. Export a ZIP from **Settings → Data Management → Export Data**, uninstall the old app, install the stable signed build, and import the ZIP. Future stable builds can then be installed as in-place updates.

### 3. Recommended first-run settings

| Setting | Recommendation | Purpose |
|---|---|---|
| Interface Language | English or 中文 | Available under **Settings → Language**; fresh installs default to English. |
| E-Ink Mode | Enable on BOOX | Uses tap-to-turn pages and distinguishes finger input from stylus input. |
| Optimize Writing Latency | Enable | Improves direct rendering in handwriting areas such as exercises. |
| Persistent Storage | Request permission | Reduces the risk of Android/WebView clearing local documents and notes. |
| Exercise Time | Set as needed | 1–120 minutes per question; the default is 20 minutes. |
| API Setting | Optional | Required only for AI, OCR, transcription, and generation features. |
| R2 Cloud Sync | Optional | Provides self-hosted cross-device backup/restore; keep separate ZIP backups too. |

### 4. Main navigation

| Section | What it does |
|---|---|
| Class | Organizes course/seminar materials, recordings, and AI transcripts. |
| Library | Imports and manages books and papers. |
| Reader | Reads, searches, annotates, asks AI about selections, and provides a scratchpad. |
| Lectures | Shows generated book lectures and paper abstracts. |
| Notes | Provides free-form notebooks and spaced-review quizzes. |
| Exercise | Imports questions, supports handwritten answers and AI grading, and tracks mistakes. |
| Settings | Configures language, E Ink behavior, AI, themes, sync, and backups. |

### 5. Import and manage documents

1. Open **Library** and tap an empty area in the Books or Papers column.
2. Choose a local file. The import dialog accepts PDF, EPUB, TeX, and LaTeX files (`.pdf`, `.epub`, `.tex`, `.latex`).
3. Optionally edit the title and abstract, then tap **Add**.
4. Tap a card to read it. Long-press a card to archive or delete it. Archived items can be restored from **Archive** in the upper-right corner.

PDF has the most complete workflow: page search, OCR search, page annotations, visual lasso questions, outline generation, and page-based lecture generation. AI outline generation currently supports PDF books only.

### 6. Read, navigate, and search

- The app remembers the current page and reading progress for each document.
- Use the previous/next controls at the bottom. Tap the page counter to jump to a page number.
- Use the magnifier for text search and optional case sensitivity. For scanned PDFs without a text layer, use **OCR Search** with a correctly configured vision-capable API/model.
- Expand the thin bar above the reader navigation to open the scratchpad. It supports rich text, to-do items, pen, eraser, undo/redo, and canvas clearing.
- Tap **AI** at the top of the reader to chat about the current document/page. Chat history is stored per document and can be exported.

With **E-Ink Mode** enabled, finger taps on the left/right page regions turn pages, while stylus behavior follows the current Pen/Lasso mode. The reader also uses a single-page presentation better suited to E Ink.

### 7. Stylus: Pen mode and Lasso mode

The mode button in the upper-right of the reader switches between two states.

**Pen mode**

- Write directly on a PDF with the BOOX stylus and select pen color and width.
- Use undo, redo, eraser, and image insertion.
- On BOOX, Onyx `TouchHelper` renders the live stroke with low latency; after pen-up, the stroke is replayed to the web canvas and saved with the document.
- The barrel eraser is supported. Selecting the on-screen eraser temporarily returns input to the app's eraser path.

**Lasso mode**

- Circle any area on a text or scanned PDF. The app combines the PDF and visible handwriting into a screenshot.
- Enter an optional question and send the selection to a vision-capable AI model.
- Answers are stored as numbered blue markers on the page. Tap a marker to read or delete its answer.

If input goes to the wrong mode, check the icon: the pen icon means Pen mode; the dashed lasso icon means Lasso mode.

### 8. AI and API configuration

No API key is bundled with the app. Open **Settings → User Settings → API Setting**:

1. Select a primary provider: DeepSeek, OpenAI, Google, Claude, or Custom.
2. Enter the service URL, API key, and model name. If supported by the service, use **Fetch Models** and select one.
3. Optionally configure a backup API, used when the primary request fails.
4. Tap **Save Settings**. Mathpix and Supabase are optional and may be left empty when their related features are not used.

After configuration, available workflows include global math chat, current-page chat, visual PDF lasso questions, OCR, book outlines and lectures, paper abstracts, class-material processing, audio transcription, exercise recognition/grading, and notebook review quizzes. Actual support depends on whether the selected model accepts text, images, PDFs, or audio. API fees and provider-side data handling are governed by the provider you choose.

API credentials remain local and are excluded from R2 sync. However, a complete ZIP export contains local settings and credentials, so never share an unprotected backup.

### 9. Lectures, Class, Notes, and Exercise

**Lectures and abstracts**

- Tap **AI** in the upper-left of Library, choose Generate Outline, Generate Lecture, or Generate Abstract, then select a book or paper.
- For PDF books, generate the outline first, then generate chapter lectures. Lectures support previous/next navigation, jumping back to the source book, download, and regeneration.
- Select text inside a lecture to ask a focused AI question and insert the response as an inline note.

**Class**

- Tap empty space under Course or Seminar to create a folder, then create a subfolder for each session.
- Upload source images/PDFs or start an audio recording. Keep the app in the foreground while recording.
- AI can turn materials or recordings into notes/transcripts. Long-press a material or note to regenerate, download, or delete it.

**Notes**

- Tap empty space in the notebook column to create a notebook and choose a template.
- The editor supports pen, highlighter, eraser, lasso, text, shapes, page management, and background images.
- Use Add to Review inside a notebook to create AI-generated spaced-review quizzes. Due items appear in the review list.

**Exercise**

- Create a folder under New Questions. Use the lower-right buttons to upload images/PDFs, or use Exercise Set Upload to split a PDF into page ranges and generate questions in batches.
- The answering view includes a timer, handwriting, eraser, undo/redo, and clear. AI grading can move mistakes into the Wrong Questions list.
- Mistakes can be retried, archived, deleted, or sent to AI for analysis. A task can also be batch-graded or exported as PDF.

### 10. Backup, restore, and cloud sync

App content is primarily stored in WebView local storage and IndexedDB. Uninstalling the app, clearing app data, or some system cleanup operations can remove it.

**Complete ZIP backup (recommended regularly)**

1. Open **Settings → Data Management → Export Data**.
2. Stop any active classroom recording before exporting.
3. Store the generated `math-reader-full-export-YYYY-MM-DD.zip` in a safe location.
4. To restore, select **Import Data** and choose the ZIP. Import replaces the current local books, notes, classes, exercises, lectures, and notebooks, so back up current data first.

The ZIP may include original files, recordings, notes, chat history, and local API/R2 credentials. Treat it like a password file. If the export reports omitted recordings, check `recordings/missing.json` inside the ZIP and do not treat that archive as a complete audio backup.

**Cloudflare R2 sync (optional)**

1. Create an R2 bucket and an S3 API token with read/write access in Cloudflare.
2. Open **Settings → Data Management → R2 Cloud Sync Configuration** and enter the Access Key ID, Secret Access Key, Endpoint URL, and bucket name. A custom domain is optional.
3. Test the connection, then save the configuration.
4. Use **Sync to Cloud** or **Restore from Cloud**, or enable scheduled sync and sync-on-file-change.

Export a local ZIP before a cloud restore or multi-device migration. Avoid heavy simultaneous editing and syncing from two devices. R2 credentials and API keys remain device-local and are not overwritten by R2 restore.

### 11. Troubleshooting

**The APK will not install or reports a signature conflict**

Verify that you downloaded the officially signed APK. For an old debug build, export a ZIP, uninstall it, and install the stable build.

**Stylus latency is high or strokes do not appear**

Confirm that the device is a BOOX, enable E-Ink Mode and Optimize Writing Latency, and make sure the reader is in Pen mode. Other Android devices use regular WebView input.

**Finger input writes instead of turning pages**

Enable E-Ink Mode on BOOX. In the reader, use finger taps for page turning and the stylus for writing or lasso selection.

**AI, OCR, lecture generation, or grading fails**

Check the network, API URL, key, and model name. Confirm that the model supports the required image, PDF, or audio input, and configure a backup API if needed.

**Documents or notes disappeared after system cleanup**

Request persistent storage and keep regular ZIP or R2 backups. Persistent-storage permission reduces risk but is not a substitute for backups.

**What should I do before updating?**

Stable signed versions normally update in place, but export a complete ZIP before an important upgrade. Do not uninstall merely to update.

If the problem remains, open an [Issue](https://github.com/none0enon/math-reader-boox/issues) with the device model, BOOX firmware/Android version, app version, reproduction steps, and relevant screenshots. Remove API keys, R2 secrets, and private document content first.

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

## 发布构建与签名说明（维护者）

面向用户的安装步骤见上方[中文使用说明](#中文使用说明)。Boox 设备开启「未知来源安装」，把正式签名 APK 拷到设备上点击安装即可。

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
