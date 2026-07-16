# Math Reader

Math Reader 是一个面向数学学习的本地优先工作台：把资料阅读、课堂记录、AI 讲义、手写笔记、间隔复习和习题训练放在同一个应用中。

This repository ships the current Math Reader web app as an Android APK. BOOX/E Ink support is an additional platform adaptation: on supported BOOX devices, handwriting is connected to the Onyx pen SDK for lower latency, while the main product remains Math Reader itself.

[中文使用说明](#中文使用说明) · [English User Guide](#english-user-guide) · [Releases](https://github.com/none0enon/math-reader-boox/releases) · [Issues](https://github.com/none0enon/math-reader-boox/issues)

## 当前功能

| 模块 | 用途 |
|---|---|
| 课堂 | 按课程/讲座整理课堂，录音、拍照或上传资料，并生成带来源引用的 AI 笔记 |
| 书架与阅读 | 管理书籍/论文，阅读和批注 PDF，搜索/OCR、套索问 AI、按文档保存对话 |
| 讲义 | 为 PDF 书籍生成大纲和分章节讲义，为论文生成摘要 |
| 笔记 | 模板化手写笔记本、PDF/图片/音频插入、搜索、PDF 导出 |
| 复习 | 从指定笔记页生成 Quiz，按间隔复习计划自动推进并由 AI 评分 |
| 习题 | 从图片/PDF 识别题目，手写作答、计时、AI 批改、重做与归档 |
| 数据 | 本地持久化、完整 ZIP 备份，以及可选的 Cloudflare R2 多设备同步 |

> AI 生成、OCR、转写、识题和批改会把相应文本、页面截图、文档片段或录音发送给你配置的服务商。普通阅读、手写和本地数据管理不要求配置 AI。

<a id="中文使用说明"></a>

## 中文使用说明

### 1. 安装、更新与首次启动

1. 安装项目发布的正式签名 APK。Android 需要允许浏览器或文件管理器“安装未知应用”；最低支持 Android 8.0（API 26）。
2. 第一次安装默认显示 English，可在 **Settings → Language Settings → Interface Language → 中文** 切换。
3. 后续更新直接覆盖安装正式签名 APK，不要先卸载；覆盖安装会保留应用私有目录中的数据，卸载则会清除本地文档、笔记和录音。
4. 如果旧测试版使用了不同签名，先在旧版执行 **设置 → 数据管理 → 导出数据**，确认 ZIP 已保存，再卸载并安装正式版。
5. 首次使用建议先进入 **设置 → 存储持久化** 请求授权，再完成 AI 和备份设置。

底部导航从左到右依次是：**课堂、书架、阅读、讲义、笔记、习题、设置**。应用会保存最近打开的文档、页码、笔记页和部分作答进度。

### 2. 配置 AI

进入 **设置 → API Setting**：

1. 在 **Primary API** 选择 DeepSeek、OpenAI、Google、Claude 或 Custom。
2. 填写服务地址、API Key 和模型名；兼容的服务可以使用 **Fetch Models** 拉取模型列表。
3. 如需故障切换，可再配置 **Backup API**。主服务调用失败时应用会尝试备用服务。
4. **Supabase** 和 **Mathpix** 位于 Other Services，仅在你确实使用对应服务时填写。
5. 保存后先用一个普通 AI 对话验证配置，再测试图片识别、录音或 PDF 任务。

模型能力建议：

- 普通问答、讲义和摘要需要可靠的长文本与 LaTeX 输出能力。
- 套索问 AI、手写识别、习题识别和批改需要支持图片输入的视觉模型。
- 课堂录音转写需要所选接口能够接收应用发送的音频内容；服务商的文件大小、格式和速率限制仍然适用。
- 生成大纲/讲义会发送 PDF 或切分后的 PDF 页面，模型接口需要支持该调用方式。

API Key 保存在本机设置中，不会随 R2 元数据同步到云端；完整 ZIP 备份会包含本机设置，因此仍须把 ZIP 当作敏感文件保管。

### 3. 书架：导入和管理资料

1. 打开 **书架**，点击“书籍”或“论文”栏的空白处。
2. 选择 PDF、ePub、TeX 或 LaTeX 文件，可选填标题和摘要后点击 **添加**。
3. 点击卡片打开资料；长按卡片可 **存档** 或 **删除**，存档内容可在右上角 **存档** 中恢复。
4. 当前阅读器仅对 **PDF** 提供完整在线渲染、页码、搜索、批注和 AI 页面上下文。ePub/TeX/LaTeX 可以导入和保存，但当前界面会提示暂不支持在线渲染。

书架左上角 **AI** 提供四个入口：

- **生成大纲**：选择 PDF 书籍，结合 PDF 自带书签规划章节和页码范围。
- **生成讲义**：读取已经生成的大纲，创建讲义目录；第一节优先生成，其余章节在打开时按需生成。
- **生成摘要**：选择论文生成摘要。
- **不知道，给我建议**：打开通用学习对话；“设置”中的 AI 人设只影响这个入口。

建议先对 PDF 书籍执行“生成大纲”，确认章节划分后再执行“生成讲义”。大纲和讲义生成目前只支持 PDF 书籍。

### 4. 阅读：PDF、批注、搜索与问 AI

从书架打开 PDF 后会自动进入 **阅读**：

- 底部页码条可上一页、下一页；点击页码可输入页码跳转。阅读进度和最近页会自动保存。
- 搜索按钮支持关键词、上一项/下一项、区分大小写；扫描版 PDF 可使用 **OCR 识别搜索**。
- 右上角模式按钮在 **画笔** 和 **套索** 间切换。画笔模式可选择颜色/粗细、撤销、重做、整笔橡皮和插入图片。
- 套索模式可圈选当前 PDF 区域，应用会合成原页与已有批注并截图，再打开“问 AI”输入框。回答以编号标记保存在页面上，点击标记可重新查看或删除。
- 点击左上角 **AI** 打开该文档的独立对话。对话可结合当前页面截图，也支持引用选中文字，并可导出聊天记录；每个文档保存自己的对话历史。
- 页面下方的草稿条可展开独立草稿：同时支持富文本和手写画布，以及画笔、橡皮、撤销/重做和清空。
- 书籍大纲生成后，阅读器中的书签/章节入口可以在原文页和对应讲义之间跳转。

扫描件的关键词搜索、套索截图提问和页面截图对话需要视觉/OCR 能力；文字型 PDF 的普通搜索不需要 AI。

### 5. 课堂：录音、资料和 AI 笔记

1. 打开 **课堂**，点击“课程”或“讲座”栏空白处创建一级文件夹。
2. 进入文件夹，点击空白处创建一讲/一次会议。默认名称按日期生成，也可自行修改。
3. 进入具体场次后，使用右下角按钮：
   - **麦克风**：开始/停止课堂录音；首次使用需要授予麦克风权限。
   - **上传**：可选择图片、音频、PDF、Word、纯文本、Markdown、TeX/LaTeX 等资料。
   - **相机**：拍摄板书、讲义或现场资料。
4. 上传完成后，资料保存在“源素材”，应用会基于素材生成 AI 笔记；停止录音后会保存录音并生成转写纪要。
5. 打开 AI 笔记可阅读 LaTeX 内容、查看进度，并通过来源引用跳回对应素材。
6. 长按源素材可重新生成笔记或删除；长按 AI 笔记可下载 Markdown 或删除。课程/讲座文件夹支持重命名和删除，场次支持重命名。

录音写入应用私有的持久化存储，覆盖升级和 WebView 重建不会主动删除，但卸载应用仍会清除录音。创建完整 ZIP 前应先停止正在进行的录音；若导出提示录音缺失，请检查 ZIP 中的 `recordings/missing.json`。

### 6. 讲义与论文摘要

**生成书籍讲义**：

1. 在 **书架 → AI → 生成大纲** 选择 PDF 书籍。
2. 大纲完成后选择 **生成讲义**。系统建立章节列表并优先生成第一节。
3. 打开 **讲义**，左栏按书籍列出讲义文件夹；进入后点击章节，尚未生成的章节会按需生成。
4. 讲义阅读器支持上一节/下一节、返回原书页、字号调整、进度记录、页面画笔和独立草稿。
5. 选中讲义内容可直接问 AI；右上角可重新生成当前章节。长按章节卡片可下载 Markdown。

**生成论文摘要**：在 **书架 → AI → 生成摘要** 选择论文。结果显示在 **讲义 → 摘要** 栏，并使用同一讲义阅读器显示、渲染公式和保存阅读进度。

### 7. 笔记本与间隔复习

#### 创建和编辑笔记本

1. 打开 **笔记**，点击“笔记本”栏空白处，输入名称并选择模板：空白、宽横线、窄横线、康奈尔或会议记录。
2. 顶部三个笔刷可单击切换、双击设置；另有整笔橡皮、撤销/重做和前后翻页。
3. 左侧工具包括模板、套索、文本、图形、页面管理、缩放、导出、插入、搜索、加入复习和更多。
4. 图形工具支持圆、长方形、三角形、直线、平滑曲线、箭头、二维坐标系和三维坐标系。
5. 页面管理可在当前页前后插页、删除页面或把 PDF 页插入笔记本；单次 PDF 导入最多取前 60 页。
6. 插入工具可添加图片或音频；导出可勾选页面并打印或生成 PDF。
7. 点击页码可打开缩略图/大纲，跳页、调整页序，并把页面加入大纲。
8. 搜索会查找文本框、媒体名和已建立的手写索引。手写内容需先点击 **AI 识别手写建立索引**。

#### 加入复习

1. 在要复习的笔记页点击 **加入复习**。应用将当前页发送给 AI，并生成该页的 Quiz。
2. 复习计划按当天、2 天后、4 天后、7 天后和 21 天后推进；到期项目显示在“复习列表”。
3. 打开 Quiz 后在画布手写答案，点击 **完成**。AI 按 10 分制评分、逐题核对并给出完整解答，然后生成下一阶段 Quiz。
4. Quiz 中可随时打开对应笔记页。逾期项目可能增加巩固练习；长期未完成的计划会标记为失效，可从列表中重试或管理。

### 8. 习题：识题、作答、批改和错题

1. 打开 **习题**，点击“新题”栏空白处创建文件夹。
2. 进入文件夹后，右下角有两个导入入口：
   - **上传习题**：一次选择一张或多张图片/PDF；每个文件建立一个任务，AI 自动拆分题目。
   - **习题集上传**：选择一个 PDF，在页面缩略图中把若干页分为“习题 1/2/…”，或标记为跳过/放弃；也可按“每 N 页一份”快速裁切，再批量生成任务。
3. 打开任务后，题目显示在上方，答题画布支持颜色、整笔橡皮、撤销/重做和清空。每题计时长度在 **设置 → 习题时间** 中设为 1–120 分钟。
4. 点击 **完成** 后，应用把题目和手写答案发送给视觉模型，返回 0–10 分、正确解法、严谨性建议、知识缺口、同类练习和综合评价。
5. 批改记录会进入右侧“错题”区域，可查看原答案和解析、重新作答、选择内容问 AI，并管理或归档记录。
6. 长按习题文件夹可重命名、归档或删除；顶部 **归档** 可查看已归档内容。

AI 识题完成前不要关闭任务页面。照片应尽量正对、无阴影并包含完整题干；复杂 PDF 建议使用“习题集上传”明确分组，减少跨页识别错误。

### 9. 设置、备份与同步

常用设置包括：用户/AI 名称和头像、通知、照片保留天数、习题时间、Apple Pencil 模式、墨水屏模式、书写延迟优化、主题/背景、中文/English/Français。

#### 完整 ZIP 备份

- **设置 → 数据管理 → 导出数据** 会打包元数据、原始资料、批注、讲义、课堂素材/录音、习题书写、笔记本和本机设置。
- **导入数据** 会覆盖当前本地的书籍、笔记、课堂、习题、讲义和笔记本；导入前先备份目标设备。
- ZIP 可能包含 API/R2 凭据、私人文档、聊天和录音，不要上传到公开网盘或 Issue。
- **清除所有数据** 不可撤销，执行前务必确认 ZIP 可以正常保存。

#### Cloudflare R2 同步（可选）

1. 在 **R2 云同步配置** 填写 Access Key ID、Secret Access Key、Endpoint 和 Bucket；自定义域名可选。
2. 点击 **测试连接**，成功后保存配置。
3. 可手动使用 **同步到云端** / **从云端恢复**，也可开启定时同步和“文件变更时自动同步”。
4. API Key 和 R2 配置本身只保留在设备本地，不随 R2 元数据上传；新设备仍需自行配置这些凭据。
5. 首次迁移或准备清空设备时，优先保留一份完整 ZIP。R2 是同步副本，不应作为唯一备份。

### 10. BOOX / 墨水屏兼容性

BOOX 是本仓库 Android 发行版的附加适配，不改变上述 Math Reader 工作流：

- 支持的 BOOX 设备会自动使用 Onyx `TouchHelper` 为 PDF 批注、笔记本、习题、复习 Quiz、草稿和讲义画笔提供原生低延迟直渲染。
- 页面切换到橡皮、套索、文本或图形等工具时，原生直渲染会暂停并把输入交回页面；抬笔后笔迹仍由 Math Reader 自己保存。
- 开启 **设置 → 墨水屏模式** 后，阅读器中手指点按左右区域翻页，触控笔继续书写或套索。
- **优化书写延迟** 是页面侧的习题书写选项；BOOX 原生 SDK 是否可用由 APK 自动检测。
- 非 BOOX Android 设备会回退到普通 WebView 输入，Math Reader 的其他功能仍可使用。

### 11. 常见问题

**导入了 ePub/LaTeX，但阅读页打不开**

当前版本允许导入和保存这些格式，但完整阅读器只渲染 PDF。请先转换为 PDF。

**AI 对话正常，套索/识题/批改失败**

普通文本模型不一定支持图片。更换视觉模型，并检查服务地址、模型名、额度、图片大小和网络。

**讲义按钮提示先生成大纲**

讲义依赖 PDF 书籍的大纲。先执行 **书架 → AI → 生成大纲**，完成后再生成讲义。

**OCR 搜不到扫描 PDF**

先确认已配置视觉/OCR 服务；扫描页模糊、倾斜或公式密集时，识别结果取决于模型质量。

**找不到导出的 ZIP/PDF/Markdown**

先看应用的保存成功提示，再检查 Android 的 **下载 / Downloads**。旧 Android 版本在公共目录不可写时可能保存到应用外部文件目录。

**覆盖安装提示签名冲突**

先从旧版导出完整 ZIP，再卸载旧版并安装正式签名版。没有确认备份前不要卸载。

**BOOX 上有短暂残影或第一笔延迟**

关闭遮挡画布的面板，重新选择画笔或切换一次页面。撤销、橡皮和工具切换后，E Ink 直渲染层与页面画布可能需要一次区域刷新。

仍无法解决时，请提交 [Issue](https://github.com/none0enon/math-reader-boox/issues)，写明 APK 版本、设备/Android 版本、功能模块、复现步骤和截图；务必隐藏 API Key、R2 密钥和私人资料。

---

<a id="english-user-guide"></a>

## English User Guide

### 1. Install, update, and start

1. Install an officially signed APK published by this project. Android 8.0 (API 26) or later is required, and Android may ask you to allow the browser or file manager to install unknown apps.
2. Fresh installs start in English. Change the language under **Settings → Language Settings → Interface Language**.
3. Install later signed builds over the existing app. An in-place update preserves app-private data; uninstalling removes local documents, notes, and recordings.
4. If an older test build has a different signature, export a complete ZIP first, verify that it was saved, then uninstall and migrate to the stable build.
5. On first launch, request **Storage Persistence**, then configure AI and backups as needed.

The bottom navigation is **Class, Library, Reader, Lectures, Notes, Exercise, Settings**. Recent documents, pages, notebook positions, and part of the exercise state are restored automatically.

### 2. Configure AI

Open **Settings → API Setting**:

1. Select DeepSeek, OpenAI, Google, Claude, or Custom as the primary provider.
2. Enter the endpoint, API key, and model. Use **Fetch Models** where the provider supports it.
3. Optionally configure a backup provider, used when the primary call fails.
4. Supabase and Mathpix are optional services; leave them empty unless your workflow needs them.
5. Save the settings, test a text chat, and then test any image, audio, or PDF workflow you plan to use.

Use a strong text/LaTeX model for chat, outlines, lectures, and abstracts. Lasso questions, handwriting indexing, exercise extraction, and grading require vision input. Classroom transcription requires an API that accepts the audio sent by the app. PDF outline and lecture generation require a provider compatible with the app's PDF attachment calls.

API credentials stay local and are excluded from R2 metadata sync. A full ZIP contains local settings, so protect the ZIP as a sensitive file.

### 3. Library

1. Open **Library** and tap an empty area in the Books or Papers column.
2. Select a PDF, ePub, TeX, or LaTeX file. Optionally edit its title and abstract, then tap **Add**.
3. Tap a card to open it. Long-press a card to archive or delete it; restore archived items from **Archive**.
4. The current full reader supports **PDF only**. ePub/TeX/LaTeX files can be stored in the library, but the app currently reports that inline rendering is unavailable.

The Library **AI** menu provides:

- **Generate Outline** for a PDF book, using its PDF bookmarks when available.
- **Generate Lecture** after an outline exists. The first chapter is generated first; later chapters are generated on demand.
- **Generate Abstract** for a paper.
- **I don't know, suggest** for a general study chat. The custom AI persona applies only to this action.

For books, generate and review the PDF outline before generating lectures. Outline and lecture generation are currently PDF-only.

### 4. Reader

- The page bar moves between pages; tap the page count to jump to a page. Reading position is saved.
- Search supports previous/next result and case sensitivity. Use **OCR Search** for scanned PDFs.
- The upper-right tool switches between **Pen** and **Lasso**. Pen mode provides colors, widths, undo/redo, stroke eraser, and image insertion.
- Lasso mode captures a selected PDF region together with visible annotations and opens Ask AI. Answers are stored as numbered page markers that can be reopened or deleted.
- The top-left **AI** button opens a chat stored separately for the current document. It can use a current-page screenshot, quote selected text, and export the chat history.
- Expand the bottom scratchpad for rich text and freehand work, with pen, eraser, undo/redo, and clear controls.
- After an outline is generated, bookmarks connect source pages with their lecture chapters.

Normal text search on a text PDF does not need AI. OCR, lasso questions, and screenshot-aware chat require suitable vision/OCR support.

### 5. Class

1. Tap an empty area under Course or Seminar to create a top-level folder.
2. Open it and create a session. A date-based title is suggested and can be edited.
3. In the session, use the lower-right actions to record audio, upload files, or take a photo. Uploads accept images, audio, PDF, Word, plain text, Markdown, and TeX/LaTeX files.
4. Uploaded material appears under Source Material and is converted into an AI note. Stopping a recording saves it and starts transcript/minutes generation.
5. Open an AI note to read formatted math and follow source references back to the original material.
6. Long-press source material to regenerate its note or delete it. Long-press an AI note to download Markdown or delete it. Folders and sessions can be renamed.

Recordings use durable app-private storage and survive WebView recreation and in-place updates, but not app uninstall. Stop active recording before a full export. If the export reports missing audio, inspect `recordings/missing.json` inside the ZIP.

### 6. Lectures and abstracts

For a book, run **Library → AI → Generate Outline**, then **Generate Lecture**. Open **Lectures**, enter the book folder, and open a chapter; pending chapters are generated on demand. The lecture viewer supports previous/next chapter, source-book jump, font size, progress, drawing, a separate scratchpad, selected-text questions, regeneration, and Markdown download by long-pressing a chapter card.

For a paper, run **Generate Abstract**. The result appears in the Abstracts column and uses the same math-aware viewer.

### 7. Notebooks and spaced review

Create a notebook from the empty Notebooks column and choose Blank, Wide ruled, Narrow ruled, Cornell, or Meeting Notes. The editor provides configurable brush presets, stroke eraser, undo/redo, lasso, text, shapes, templates, page management, 50–200% zoom, media insertion, search, and export.

- Shapes include circle, rectangle, triangle, line, smooth curve, arrow, and 2D/3D axes.
- Insert pages before or after the current page, or import up to the first 60 pages of a PDF as notebook pages.
- Insert images or audio. Select notebook pages for print or PDF export.
- Tap the page number for thumbnails/outlines, page jump, reordering, and outline entries.
- Search covers text boxes, media names, and an optional AI-generated handwriting index.

To review a page, tap **Add to Review** in that notebook page. AI generates a Quiz and schedules stages for the same day, 2, 4, 7, and 21 days later. Handwrite the Quiz answer and tap **Complete** for 0–10 scoring, per-question checks, and full solutions. The app then prepares the next stage. Quiz view can always reopen the source note page; overdue items may receive consolidation work, while long-neglected plans can become invalid.

### 8. Exercises

1. Create a folder from the empty New column.
2. Inside it, use **Upload Exercise** for images/PDFs. Each file becomes a task and AI extracts individual questions.
3. Use **Exercise Set Upload** for a multi-page PDF. Assign pages to Exercise 1/2/…, Skip, or Discard, or split every N pages automatically.
4. Open a task and handwrite on the answer canvas. Pen colors, stroke eraser, undo/redo, and clear are available. Set the 1–120 minute per-question timer in Settings.
5. **Complete** sends the question and handwriting to a vision model and returns a 0–10 score, correct solution, rigor feedback, knowledge gaps, a similar problem, and an overall comment.
6. Graded records appear in the Wrong column for review, redoing, Ask AI, and archive management. Long-press an exercise folder to rename, archive, or delete it.

Keep pages open until AI extraction finishes. Use clear, complete, upright photos. For complex PDFs, explicit grouping in Exercise Set Upload is more reliable than automatic cross-page inference.

### 9. Settings, backup, and sync

Settings include user/AI profiles, notifications, photo retention, exercise time, Apple Pencil mode, E-Ink mode, writing-latency optimization, themes/backgrounds, and Chinese/English/French UI languages.

**Full ZIP backup** includes metadata, source documents, annotations, lectures, classroom material/recordings, exercise writing, notebooks, and local settings. Import replaces the current local books, notes, classes, exercises, lectures, and notebooks. A ZIP may contain credentials, private documents, chats, and recordings; never post it publicly. **Clear All Data** is irreversible.

**Cloudflare R2 sync** is optional. Enter the access key, secret, endpoint, and bucket, test the connection, then use manual upload/restore or enable scheduled/on-change sync. API keys and the R2 configuration itself remain local and must be configured again on a new device. Keep a full ZIP for migrations; R2 should not be the only backup.

### 10. BOOX / E Ink compatibility

BOOX support is an additional Android adaptation, not a separate app workflow:

- Supported BOOX devices automatically use Onyx `TouchHelper` for low-latency direct rendering on PDF annotations, notebooks, exercises, review quizzes, scratchpads, and lecture drawing.
- Native rendering pauses for eraser, lasso, text, shape, and other page-controlled tools. Math Reader still owns the saved stroke data.
- With **E-Ink Mode** enabled, finger taps turn reader pages while the stylus continues to write or lasso.
- **Optimize Writing Latency** is the web app's exercise-canvas setting; BOOX native SDK availability is detected automatically.
- Non-BOOX Android devices fall back to normal WebView input while keeping the rest of Math Reader available.

### 11. Troubleshooting

- **Imported ePub/LaTeX will not render:** the current full reader is PDF-only. Convert the file to PDF.
- **Text chat works but lasso/extraction/grading fails:** use a vision-capable model and check the endpoint, model name, quota, input size, and network.
- **Generate Lecture asks for an outline:** run Generate Outline on the PDF book first.
- **OCR finds nothing in a scan:** configure a compatible vision/OCR service; quality depends on scan clarity and model capability.
- **Cannot find an exported ZIP/PDF/Markdown:** read the save-complete toast, then check Android **Downloads**. Older Android versions may use the app's external files directory.
- **APK update reports a signature conflict:** export and verify a full ZIP before uninstalling the old build and installing the stable signed APK.
- **Brief BOOX ghosting or a delayed first stroke:** close panels covering the canvas, reselect the pen, or change pages once to refresh the native E Ink region.

For unresolved problems, open an [Issue](https://github.com/none0enon/math-reader-boox/issues) with the APK version, device/Android version, affected module, reproduction steps, and screenshots. Remove API keys, R2 secrets, and private content first.

---

## Android / BOOX 适配与开发说明

### 工作原理

```text
┌──────────────────────────────────────────────┐
│ MainActivity (全屏 WebView)                   │
│   ├── assets/www/  ← 当前 Math Reader 页面    │
│   ├── boox-pen.js  ← 页面加载后注入的适配器    │
│   └── TouchHelper  ← Onyx 手写 SDK 直渲染层   │
└──────────────────────────────────────────────┘
```

1. WebView 通过 `https://appassets.androidplatform.net` 同源加载打包在 assets 里的页面，localStorage / IndexedDB 正常持久化。
2. 注入的 `boox-pen.js` 自动探测当前可手写画布，把可见区域交给原生 `TouchHelper` 做 EPD 低延迟直渲染。
3. 抬笔后 SDK 回调整笔触点，适配器以合成 PointerEvent 回放给页面；绘制、撤销和保存逻辑仍由 Math Reader 管理。
4. 页面切到橡皮等非书写工具时自动挂起直渲染，笔杆侧橡皮则映射回页面橡皮逻辑。
5. APK 还桥接 WebView 文件选择、blob/data 下载、原生录音和外部链接。
6. `BooxPenBridge` 记录手指/触控笔工具类型，并通过 `BooxPenNative.getLastToolType()` 暴露给页面。

非 BOOX 设备上 SDK 初始化失败时会自动降级为普通 WebView 输入。

### 阅读器画笔 / 套索补丁

- **画笔模式**：在 PDF 批注画布书写；BOOX 上使用原生 `TouchHelper` 低延迟直渲染。
- **套索模式**：在 PDF 页自由圈选，合成 PDF 与手写批注后按多边形截图，并把截图发送给视觉 AI。回答保存为编号 marker 与悬浮 comment。
- 开启墨水屏模式后，手指点按负责翻页；触控笔在画笔模式书写，在套索模式选择。
- 模式切换会调用 `__booxPen.syncRegions()` 立即重算原生书写区域。

### 构建

GitHub Actions 在同仓库 PR 和 `main` 更新后自动构建。默认分支的 `Sign APK` workflow 下载构建产物、核对包名和版本，并使用长期 CI 密钥签名。可在 **Actions → Sign APK → Artifacts** 获取 `math-reader-boox-1.0.2-ci.*`。

`versionCode` 随 `Build APK` workflow run 自动递增，版本号基数保存在仓库变量 `APK_VERSION_CODE_BASE`。不要降低该变量；重建 workflow 导致 run number 重新计数时，应先提高基数。

本地构建需要 Android SDK，并能访问 `repo.boox.com`：

```bash
./gradlew assembleDebug
# app/build/outputs/apk/debug/app-debug.apk
```

从 2026-07-16 之前的临时 debug 签名 APK 迁移时，需先导出/同步数据，卸载旧版，再安装一次稳定签名版。CI 签名密钥不得删除或替换，否则无法继续覆盖更新已安装 APK。

### 同步上游 Math Reader

`manifest.json`、`sw.js` 和图标可直接覆盖；`index.html` 带有阅读器画笔/套索本地补丁，不能整文件覆盖，需手动合并并保留下列补丁点：

```bash
cp ../math-reader/{manifest.json,sw.js,icon-infinity-white.svg} \
   app/src/main/assets/www/
# index.html 手动 diff 合并，勿覆盖
```

相关标识符包括：`booxReaderIsPen`、`bindEinkReaderTapZone`、`einkPageTurnByClientX`、`einkHandleReaderTap`、`buildReaderTextLayer`、`attachReaderTextLayerInput`、`applyReaderInputMode`、`clearReaderTextSelection`、`einkSelect*`、`einkCropPageRegion`、`askAIAboutReaderSelection`、`addDocAiComment`、`renderPageNoteMarkers`，以及 `.reader-text-layer`、`.ai-marker`、`.ai-bubble`、`.eink-select-overlay` 和 `#readerSelectionMenu`。

`boox-pen.js` 依赖的主要画布约定：

| 画布 | 选择器 | 橡皮按钮 / 切换函数 |
|---|---|---|
| 习题作答 | `#exerciseDoingCanvas` | `#exEraserBtn` / `toggleExEraser()` |
| 笔记复习 Quiz | `#nbQuizFsCanvas` | `#qzEraserBtn` / `toggleQzEraser()` |
| PDF 批注 | `.annotation-canvas` | `#readerEraserBtn` / `toggleReaderEraser()` |
| 草稿纸 | `#draftCanvas`、`#lectureDraftCanvas` | — |
| 讲义画笔 | `#lectureDrawCanvas` | — |

### 关键文件

- `app/src/main/java/com/mathreader/boox/MainActivity.java` — WebView 壳、文件选择、下载、录音与触控笔工具类型上报
- `app/src/main/java/com/mathreader/boox/BooxPenBridge.java` — `TouchHelper` 封装和 JS 桥
- `app/src/main/assets/boox-pen.js` — 画布探测、原生笔迹回放和触控笔检测
- `app/src/main/assets/www/` — 当前 Math Reader 页面资源
