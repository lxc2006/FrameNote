# FrameNote 项目上下文

> 最后更新：2026-07-19
> 用途：新任务开始时恢复上下文。仅记录当前事实与决策，不记录任何 API Key、令牌或完整对话。

## 项目定位

FrameNote（帧记）是视频 AI 总结与连续问答工作台。网站使用 vinext/Next.js、React、TypeScript 和 Cloudflare Worker；Qwen 负责多模态视频总结，DeepSeek V4 Pro 负责基于总结与证据的后续对话。独立 Python/FastAPI 媒体服务负责 B站公开视频下载与音视频合并。

## 已完成

### 产品与浏览器处理

- 已完成本地视频、B站链接/BV号两种输入方式，以及预览、阶段进度、结构化总结、章节时间线和连续追问界面。
- 本地视频支持 MP4、MOV、WebM、MKV、M4V；浏览器使用固定版本 FFmpeg WebAssembly 提取压缩 MP3 音轨和最多 24 张带时间索引的 JPEG 关键帧，再提交给 Qwen。
- 本地文件限制为 300 MB、60 分钟；B站下载结果因浏览器 Blob 与 WASM 内存开销限制为 150 MB、60 分钟。
- 支持模型可直接访问且返回正确媒体类型的 HTTPS 视频直链；B站页面链接不再误走直链模式。
- B站合并文件下载为浏览器 `File` 后会立即创建任务级 Blob URL，在音轨/关键帧与总结继续处理期间提供播放器和可靠的手动下载；重置任务或离开页面时释放 URL。HTTPS 直链直接用于流式预览和打开/下载，跨域保存行为取决于源站。
- 已处理分析/问答取消、重置竞态、页面离开清理、错误展示与模型配置状态。

### 模型调用

- `GET /api/model/status`：返回 Qwen 与 DeepSeek 的配置状态，不泄露密钥。
- `POST /api/model/analyze`：调用 `qwen3.5-omni-plus`，接受视频 URL、音轨、关键帧或转写文本，返回标题、概览、要点、章节、结论、独立声音分析与证据索引。
- 新总结强制返回 `audioAnalysis`，分别记录讲话、音乐、环境声、声音时间变化和不确定性；没有音频证据时明确标记 `unavailable`，旧总结在追问接口中仍保持兼容。
- Qwen 使用服务端流式接收和 JSON 模式；解析器兼容完整代码块以及响应末尾多出的 Markdown 围栏。
- `POST /api/model/ask`：调用 `deepseek-v4-pro`，输入结构化总结、证据和最近 20 条历史消息，不重复发送原视频。
- Qwen 与 DeepSeek 密钥仅通过服务端环境变量读取，不进入浏览器包。

### B站下载

- 网站控制面已实现 `POST /api/bilibili/jobs`、`GET /api/bilibili/jobs/:jobId`、`DELETE /api/bilibili/jobs/:jobId`，只转发小型 JSON，不代理视频字节。
- `media_service/` 已实现 FastAPI 异步任务服务：只接受严格 BVID，固定拼接 B站标准地址，不接受任意 URL、Cookie、登录信息或自定义 yt-dlp 参数。
- 媒体服务通过 `-I -u -X utf8=1` 强制 UTF-8、非缓冲的受控子进程调用固定版本 `yt-dlp`，只处理无需登录的公开 UGC，最高 720p；每个格式 fallback 都从源头硬性筛选 H.264 视频与 AAC 音频，再用原生 FFmpeg 合并为 MP4，不依赖重封装改变编码。
- 下载前校验来源、公开可用性、直播状态、时长和预计体积；下载中持续限制字节数；完成后用 ffprobe 校验时长、大小、MP4 容器以及全部音视频轨的 H.264/AAC 白名单，并计算 SHA-256。
- 成品通过短期 HMAC 签名 URL 由浏览器直取；浏览器校验协议、有效期、媒体类型、元数据和实际字节数，随后复用现有 FFmpeg WASM 提取音轨与关键帧。
- B站音轨在浏览器与模型 API 两层均为必需证据：音频转码失败或结果为空会终止任务，只有关键帧而无音轨的 B站分析请求会被拒绝，不再静默生成纯画面总结。
- 已实现任务并发/队列上限、20 分钟执行超时、22 分钟网页总等待、取消整个子进程树、失败即时清理、成品 TTL 清理、精确 CORS 与本机无令牌保护；失败清理会删除媒体残片但保留原始错误。
- 本机已安装 Python 依赖并检测到 yt-dlp、FFmpeg、ffprobe；健康检查、CORS 预检和非法 BVID 接口冒烟测试通过。
- 已修复客户端把合法的 `running/failed + error` 任务快照误判为无效响应的问题；worker 错误会原子落为 `failed + error`，轮询、主动清理、服务停止/重启与 TTL 过期均不会再用泛化状态覆盖原始错误。

### 工程状态

- Python 编译及 31 项媒体服务单元测试通过。
- 前端生产构建、ESLint、`git diff --check` 与 17 项页面/API/客户端回归测试通过。
- `.env.local`、`.venv` 和媒体服务临时数据均已排除版本控制；`.env.example` 只保留空占位符。
- 私有 Sites 项目已绑定在 `.openai/hosting.json`；D1/R2 尚未绑定。
- 本轮 B站网站控制面已发布到 owner-only 私有 Sites；该站点未配置媒体服务运行时变量，因此线上 B站下载仍保持不可用状态。

## 正在进行

- 媒体 worker 的真实 B站下载、DASH 合并、ffprobe 白名单校验与单帧解码已成功：产物为 1280×720 的 MP4/H.264/AAC。完整浏览器证据抽取、Qwen 总结与 DeepSeek 追问仍待端到端复测。本轮同时修复了 UTF-8 子进程输出、失败快照协议、失败清理保错，以及默认排序误选 AV1 导致浏览器 FFmpeg WASM 无法抽帧的问题；旧任务已被旧逻辑清除的错误仍无法恢复。
- Sites 只能运行网站控制面，不能运行 Python、yt-dlp 或原生 FFmpeg。线上 B站功能仍需部署独立 HTTPS 媒体容器并配置双方共享令牌后才能使用。
- 本地 Qwen/DeepSeek 环境已存在配置，但不得在文档或日志中输出值；DeepSeek 真实连续问答仍待用户自行或后续授权执行端到端测试。
- 既往曾暴露的 DeepSeek Key 必须在供应商控制台轮换，旧 Key 不应继续使用。

## 后续计划

### P0：完成真实联调与上线配置

1. 基于已通过的真实 H.264/AAC 下载，完成浏览器音轨/关键帧抽取、Qwen 总结和 DeepSeek 追问链路。
2. 将 `media_service` 部署为单实例 HTTPS 容器，固定签名密钥、数据卷、精确网站 Origin，并与 Sites 配置同一高强度服务令牌。
3. 在 Sites 配置 Qwen、DeepSeek 与媒体服务运行时变量，重新验证线上状态、下载、总结和追问。
4. 轮换曾暴露的 DeepSeek Key，并只把新 Key 写入本地 `.env.local` 与 Sites Secret。

### P1：支持更大文件与可恢复任务

1. 接入 R2/OSS/S3 预签名 multipart 上传，避免大视频经过普通 Worker 请求体或完整进入浏览器内存。
2. 将媒体预处理迁移到服务端，直接生成音轨、关键帧、字幕和分段证据；原视频不再先下载成浏览器 `File`。
3. 使用 D1/PostgreSQL 保存来源、任务、总结、证据和对话；使用 Redis/队列保存可恢复的异步状态，并将轮询升级为 SSE。
4. 增加断点续传、幂等重试、失败恢复、保留策略和用户可控的数据删除。

### P2：提升长视频质量与生产可靠性

1. 实现按场景/时长分段的“分段分析 → 全局合并”，统一原视频时间戳。
2. 为问答增加证据检索，只召回相关字幕、关键帧和章节。
3. 增加身份鉴权、速率限制、配额、幂等、审计、日志脱敏、成本监控和内容安全策略。
4. 补充真实媒体、超时、限流、格式异常、服务重启和大上下文集成测试。
5. 如有需要，增加受控的 `b23.tv` 短链解析；每次跳转都必须重新校验 HTTPS 与域名白名单。

## 本地运行与配置

网站 `.env.local`：

```dotenv
DASHSCOPE_API_KEY=
DEEPSEEK_API_KEY=
BILIBILI_MEDIA_SERVICE_URL=http://127.0.0.1:8788
BILIBILI_MEDIA_SERVICE_TOKEN=
```

本机回环开发时媒体服务令牌可留空；任何网络或反向代理部署都必须在网站和媒体服务配置相同令牌。启动顺序：

```powershell
.\.venv\Scripts\python.exe media_service\app.py
pnpm.cmd dev
```

原生 FFmpeg/ffprobe 只用于 B站媒体服务；单纯本地上传仍使用浏览器 FFmpeg WebAssembly。

## 关键入口

| 位置 | 职责 |
| --- | --- |
| `app/VideoWorkbench.tsx` | 输入、进度、浏览器预处理、总结与问答 UI |
| `lib/client/video-preprocessor.ts` | FFmpeg WASM 音轨压缩、关键帧与体积控制 |
| `lib/client/bilibili-client.ts` | B站任务轮询、直取媒体、校验与取消 |
| `app/api/bilibili/jobs/` | B站控制面代理，不传输视频字节 |
| `media_service/main.py` | FastAPI 鉴权、任务与签名下载 API |
| `media_service/worker.py` | yt-dlp、FFmpeg/ffprobe 下载合并与校验 |
| `lib/server/qwen-video-engine.ts` | Qwen 多模态请求和总结解析 |
| `lib/server/deepseek-conversation-engine.ts` | DeepSeek V4 Pro 后续问答 |
| `lib/server/runtime-env.ts` | 本地与 Sites 环境变量读取 |
| `docs/architecture.md` | 当前边界与生产化目标架构 |

## 约束

- 只处理用户拥有或获授权分析的、无需登录即可访问的公开内容；不支持会员、付费、番剧、私密、直播、地区受限内容，也不绕过验证码或风控。
- API Key、媒体服务令牌和签名密钥只放服务端环境变量；不得写入 Git、客户端代码、文档、日志或截图。
- 当前媒体任务和产物保存在单实例本地磁盘；未迁移到数据库/对象存储前，不支持多副本共享状态。
- 新任务开始时先读本文件，再检查 `git status` 和最近提交；完成实质变更后更新本文件并移动事项，避免重复记录。
