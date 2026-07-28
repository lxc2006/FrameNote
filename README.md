# 帧记 FrameNote

帧记把本地视频、B 站公开视频或 HTTPS 视频直链整理成带时间点的 AI 总结，并允许围绕总结、视频信息和字幕继续对话。

## 现在可以做什么

- 导入 MP4、MOV、WebM、MKV、M4V 本地视频，或输入 BV 号、B 站链接、HTTPS 视频直链。
- 使用网页内置播放器预览视频；B 站预览默认准备最高兼容画质。
- 所有来源使用同一套分析流程：
  1. 准备一份最长边不超过 854px 的 H.264/AAC 分析视频，横屏通常约为 854x480，竖屏通常约为 480x854。
  2. 根据“Qwen 直接总结时长”设置判断分析方式。阈值内以 1 FPS 提交整段视频；超过阈值则提取音轨，并使用 AdaptiveDetector、定时锚点、画质评分和 pHash 去重生成最多 64 张关键帧。
  3. Qwen 生成带真实视频时间点的结构化总结。
  4. 如果开启“字幕提取”，再运行 FunASR Nano 和 CT-Punc，生成按完整句子合并的字幕。
- DeepSeek 对话始终以视频信息、总结和字幕为基础上下文；输入框上方可切换快速/深度模型，并按问题意图选择性使用 SerpAPI 联网检索。
- 对话和总结会保存；原始本地视频不会保存。重新进入本地视频对话后，可重新选择任意本地文件进行预览和时间点跳转。
- 支持浅色和暗色主题，以及总结/对话字体与字号设置。
- 桌面端可拖动分隔区域或板块角落的透明斜向拖拽区，调整侧边栏宽度以及导入/历史板块高度；板块可以单独折叠，也可以从右上角整体隐藏侧边栏。布局会保存在当前浏览器。

## 分析设置

“生成 AI 总结”按钮旁边的齿轮用于设置本次及后续分析：

- **字幕提取**：默认开启。开启后，所有视频来源都会在 Qwen 总结完成后运行 FunASR Nano＋CT-Punc；关闭后跳过字幕步骤。
- **语言选择**：默认全选中、日、英并自动识别；全不选同样表示自动识别。只选择一种语言时会直接约束 Nano，选择两种时自动识别后只保留所选语言的字幕段落。
- **Qwen 直接总结时长**：在页面右上角设置中调整，默认 360 秒，范围为 0～900 秒。设置为 0 表示始终使用关键帧＋音轨。

## 对话设置

- **深度思考**：关闭时使用 `DEEPSEEK_FLASH_MODEL`，开启时使用 `DEEPSEEK_PRO_MODEL`。
- **联网搜索**：开启后先调用一次 Flash 模型，结合视频标题、简介、总结、相关字幕、近期对话、语言、地区和日期判断是否需要搜索，并把含糊代词补全为可用关键词。
- SerpAPI 返回候选网址后，系统会顺序补足最多 4 个可读来源：普通网页由 Trafilatura 提取正文，PDF 由 pypdf 解析；必须运行 JavaScript 的页面可选用 Cloudflare Browser Rendering。登录页、反爬验证页和不可访问页面会被跳过。
- 回答中的搜索事实使用可点击编号引用，末尾列出来源并显示本轮实际访问的网页数量。

## 本地运行

### 1. 准备环境

需要：

- Node.js 22.13 或更高版本
- pnpm
- Python 3.11 或更高版本
- 可从命令行找到的原生 `ffmpeg` 和 `ffprobe`

先确认：

```powershell
node --version
pnpm --version
python --version
ffmpeg -version
ffprobe -version
```

### 2. 安装依赖

```powershell
pnpm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r media_service\requirements.txt
```

FunASR、PyTorch、PySceneDetect、OpenCV 和 ImageHash 都由 Python requirements 安装。第一次提取字幕时，FunASR 还会从 ModelScope 下载模型；之后复用本机缓存。

### 3. 配置密钥

复制 `.env.example` 为 `.env.local`，至少填写：

```dotenv
DASHSCOPE_API_KEY=
DEEPSEEK_API_KEY=
DEEPSEEK_FLASH_MODEL=deepseek-v4-flash
DEEPSEEK_PRO_MODEL=deepseek-v4-pro
SERPAPI_API_KEY=
BILIBILI_MEDIA_SERVICE_URL=http://127.0.0.1:8788
BILIBILI_MEDIA_SERVICE_TOKEN=
```

本机回环开发可以暂时不设置媒体服务 Token。公开部署时，网站和媒体服务必须配置相同的高强度 Token，并让媒体服务使用 HTTPS。

如需为必须执行 JavaScript 的网页启用浏览器渲染回退，再填写：

```dotenv
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_BROWSER_RUN_API_TOKEN=
```

该 Token 只需要 Cloudflare Browser Rendering 的调用权限。未配置时不影响普通 HTML 和 PDF 正文提取，只会跳过必须运行 JavaScript 的页面。

### 4. 启动两个服务

终端一：

```powershell
.\.venv\Scripts\python.exe media_service\app.py
```

终端二：

```powershell
pnpm dev
```

打开 `http://localhost:3000`。网站和 Python 媒体服务必须同时运行；本地上传、HTTPS 直链、B 站下载、视频压缩、关键帧和字幕都依赖媒体服务。

## 使用说明

### 本地视频

选择文件后即可本地预览，左侧会显示文件大小、时长和原视频分辨率。生成总结时，浏览器把原文件传给本机媒体服务；媒体服务只保留任务期间所需的临时文件，并先转码为低分辨率分析素材。

重新进入已保存的本地视频对话时，原视频不会自动恢复。点击“选择文件”恢复预览；预览卡片中的“更改”可重新选择。系统不会强制校验新文件是否与原总结一致；如果总结时间点超出当前视频时长，点击后不会跳转。

### HTTPS 视频直链

点击“获取视频”可直接用浏览器播放器预览。生成总结时，浏览器需要能跨域读取该地址并下载视频；源站如果没有正确的 CORS 响应头，页面会提示无法读取。原视频上限为 500 MB。

### B 站视频

“获取视频”与“生成 AI 总结”是两个独立任务：

- 获取视频：准备最高兼容画质的浏览器预览，不先把整段视频读入网页内存。
- 生成总结：另行下载最长边不超过 854px、最大 500 MB 的分析素材。

只支持无需登录即可访问、且你有权下载或分析的公开 UGC。当前不使用账号 Cookie，也不处理会员、私有、付费或地区受限内容。

## 数据与限制

- 单个分析源文件最大 500 MB。
- 视频最长 60 分钟。
- 直接视频提交与关键帧路径都使用压缩后的分析视频。
- 本地视频字节不会保存到对话数据库。
- 媒体任务和分析文件默认按 TTL 自动清理；具体限制见 [媒体服务说明](media_service/README.md)。
- 字幕不参与同一次 Qwen 总结，但会保存到对话，并作为后续 DeepSeek 问答的基础上下文。

## 常见问题

### `Unable to fetch the Request.cf object`

这是 Miniflare 本地环境尝试获取 Cloudflare 请求信息失败后的回退提示。只要随后出现 `Local: http://localhost:3000/`，通常不影响本地使用。

### `fetch failed` 或 `ECONNRESET`

先确认 Python 服务仍在 `127.0.0.1:8788` 运行，再检查 `.env.local`、系统代理、防火墙和目标视频站点的连接。HTTPS 直链还必须允许浏览器跨域读取。

### 字幕第一次很慢

第一次运行需要下载并加载 FunASR Nano、VAD 和 CT-Punc 模型。CPU 推理速度也会随视频长度和硬件差异明显变化。

### `Ignored build scripts`

项目通过 `pnpm-workspace.yaml` 只允许 `esbuild`、`sharp`、`unrs-resolver` 和 `workerd` 的安装脚本。重新执行 `pnpm install` 即可按当前策略安装。

## 开发与验证

```powershell
pnpm build
pnpm test
pnpm lint
.\.venv\Scripts\python.exe -m unittest discover -s media_service\tests -v
.\.venv\Scripts\python.exe -m compileall -q media_service
```

主要模块：

- `app/VideoWorkbench.tsx`：视频来源、预览、进度、总结、字幕与对话界面。
- `lib/client/media-analysis-client.ts`：本地文件和 HTTPS 视频的分析任务客户端。
- `lib/client/bilibili-client.ts`：B 站预览、分析和字幕任务客户端。
- `media_service/main.py`：媒体任务 API。
- `media_service/worker.py`：B 站下载、通用视频探测与低分辨率转码。
- `media_service/analysis_pipeline.py`：场景检测、关键帧评分去重、音轨和 FunASR 字幕。
- `lib/server/qwen-video-engine.ts`：Qwen 视频总结。
- `lib/server/deepseek-conversation-engine.ts`：带固定视频上下文的后续对话。
- `lib/server/web-search-planner.ts`：Flash 联网意图判断与上下文关键词提取。
- `lib/server/web-search.ts`：SerpAPI 候选检索、正文相关段落选择与来源分级。
- `lib/server/web-content.ts`：Python 正文提取与 Cloudflare Browser Rendering 回退。
- `media_service/web_extract.py`：Trafilatura HTML 正文提取、pypdf PDF 解析和抓取安全边界。

更完整的接口与部署约束见 [架构文档](docs/architecture.md)。
