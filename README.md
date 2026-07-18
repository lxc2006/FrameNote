# 帧记 FrameNote

一个面向长视频的 AI 总结与持续问答工作台。当前版本优先验证完整产品体验，同时把视频处理、B站素材获取和 AI 模型隔离为可替换的适配器。

## 当前可用

- 导入 MP4、MOV、WebM、MKV、M4V 视频，读取文件名、大小和时长并本地预览。
- 在浏览器内使用 FFmpeg 提取压缩 MP3 音轨和带原视频时间索引的代表性关键帧，原视频不经过应用服务器。
- 粘贴含 BV 号的 B站视频链接或直接输入 BV 号，下载无需登录即可访问的公开 UGC。
- B站下载采用异步任务与短期签名地址；浏览器直取合并后的媒体，不让大视频穿过 Sites Worker。
- 展示素材校验、媒体读取、音轨与画面理解、总结生成等处理阶段。
- 生成结构化 AI 总结：概览、关键观点、章节时间线和一句话结论。
- 在独立会话区围绕视频继续追问。
- 响应式桌面与移动端布局，并支持键盘操作和减少动画偏好。

> 当前使用 **Qwen + DeepSeek 双模型适配器**：Qwen 负责视频理解和结构化总结，DeepSeek V4 Pro 负责基于总结、证据与历史消息继续对话。本地与 B站视频会先在浏览器中压缩为音轨与关键帧证据；本地文件上限为 300 MB，B站浏览器下载上限为 150 MB，时长均不超过 60 分钟。带正确媒体响应头的 HTTPS 视频直链仍可由 Qwen 直接读取。

> B站输入目前只支持直接 BV 号，或正文中明确包含 BV 号的链接；不解析不含 BV 号的 `b23.tv` 短链。本机需同时启动 Python 媒体服务。公开站点还需单独部署 HTTPS 媒体容器并配置运行时变量；代码与离线联调已通过，真实下载需使用你有权处理的公开 BV 号验证。

## 模型接口

服务端已经接入阿里云百炼的 OpenAI 兼容接口，默认使用 `qwen3.5-omni-plus` 同时理解视频画面、语音和音效。模型层提供：

- `GET /api/model/status`：检查服务端是否已经配置模型。
- `POST /api/model/analyze`：接收视频公网 URL、音频、关键帧列表或转写文本，返回结构化总结。
- `POST /api/model/ask`：使用 `deepseek-v4-pro`，基于结构化总结、事实索引和历史消息继续问答。

复制 `.env.example` 为 `.env.local`，填写 `DASHSCOPE_API_KEY` 和 `DEEPSEEK_API_KEY`。如果百炼控制台提供了带 Workspace ID 的专属兼容地址，同时修改 `DASHSCOPE_BASE_URL`。两种 API Key 都只在服务端读取，不会打包到浏览器。

模型调用层与媒体获取层保持分离。B站页面解析、DASH 音视频下载与 FFmpeg 合并由 `media_service/app.py` 独立完成；网站只创建/查询/取消任务，媒体文件通过短期签名 URL 由浏览器直接读取。浏览器预处理适合个人使用和中等体积视频；超出本地限制、需要页面恢复或多人并发时，仍应把原视频写入对象存储，再由后台处理器生成音轨和关键帧。

## 本地运行

网站要求 Node.js `>=22.13.0` 与 pnpm。

```bash
pnpm install
pnpm dev
```

首次处理本地视频时，浏览器会从固定版本的 jsDelivr 地址加载 FFmpeg WebAssembly 核心；随后由浏览器缓存。处理期间需要保持页面打开。

默认预览地址为 `http://localhost:3000`。

使用 B站下载功能时，还需 Python 3.11+、原生 FFmpeg/ffprobe，并在另一个终端启动媒体服务：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r media_service\requirements.txt
.\.venv\Scripts\python.exe media_service\app.py
```

媒体服务默认监听 `http://127.0.0.1:8788`。在网站的 `.env.local` 增加：

```dotenv
BILIBILI_MEDIA_SERVICE_URL=http://127.0.0.1:8788
BILIBILI_MEDIA_SERVICE_TOKEN=
```

本机回环调用可以暂时不设令牌；部署到网络后，网站与媒体服务必须配置同一个高强度令牌，并为媒体服务启用 HTTPS。媒体服务的全部限制与容器运行方式见 [`media_service/README.md`](media_service/README.md)。

```bash
pnpm build
pnpm test
pnpm lint
```

## 代码结构

- `app/VideoWorkbench.tsx`：上传、B站输入、处理进度、总结与追问的完整交互。
- `lib/client/video-preprocessor.ts`：浏览器端 FFmpeg 加载、音轨压缩、关键帧抽取和输入体积控制。
- `lib/client/bilibili-client.ts`：创建/轮询下载任务、直取媒体和下载进度。
- `lib/bilibili-api.ts`：网站与媒体任务共用的状态和产物类型。
- `app/api/bilibili/jobs`：B站任务控制面，不代理媒体字节。
- `lib/server/bilibili-route.ts`：B站控制面输入校验、鉴权代理和上游响应校验。
- `media_service/app.py`：FastAPI 媒体服务入口；通过受控 yt-dlp 子进程与原生 FFmpeg 下载、合并和校验媒体。
- `media_service/service/job_manager.py`：任务状态机、队列、超时、取消与临时文件清理。
- `lib/video-engine.ts`：共享视频来源、总结类型及未被当前 UI 使用的 Demo 引擎。
- `lib/server/qwen-video-engine.ts`、`lib/server/deepseek-conversation-engine.ts`：真实总结与追问模型入口。
- `worker/index.ts`：Cloudflare Worker 入口。
- `.openai/hosting.json`：已绑定 Sites 项目；D1 与 R2 当前均为 `null`。
- `docs/architecture.md`：生产化架构、API 契约、模型与部署选择建议。

## 下一阶段

1. 增加 D1/R2，保存上传会话、任务状态、总结和对话。
2. 实现浏览器直传 R2 multipart，避免大视频穿过普通 Worker 请求体。
3. 将本机媒体服务部署为 HTTPS 容器，并把临时产物迁移到 R2/S3。
4. 将单实例本地任务状态迁移到 D1/Redis，并把轮询升级为 SSE。
5. 给总结与回答增加更细粒度的时间戳引用和证据检索。

## B站能力边界

公开部署前，不应默认开放“下载任意 B站视频”。当前适配器只接受 BV 号并拼接标准 B站地址，不接受任意 URL、账号 Cookie 或用户自定义 yt-dlp 参数；只处理用户有权分析且无需登录即可访问的公开 UGC。固定上限为 720p、150 MB、60 分钟，服务执行超时 20 分钟、网页总等待 22 分钟。不支持会员、付费、番剧、私密、直播或受地区限制的内容，也不绕过验证码和风控。

详细约束与生产化拓扑见 [docs/architecture.md](docs/architecture.md)。
