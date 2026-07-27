# FrameNote 项目上下文

> 最后更新：2026-07-27
> 用途：新任务开始时恢复上下文。仅记录当前事实与决策，不记录任何 API Key、令牌或完整对话。

## 项目定位

FrameNote（帧记）是视频 AI 总结与连续问答工作台。网站使用 vinext/Next.js、React、TypeScript 和 Cloudflare Worker；Qwen 负责多模态视频总结，DeepSeek V4 Pro 负责基于总结、视频信息、字幕与历史消息的后续对话。独立 Python/FastAPI 媒体服务负责所有来源的低分辨率分析预处理，以及 B站公开视频下载。

## 已完成

### 产品与浏览器处理

- 已完成本地视频、B站链接/BV号两种输入方式，以及预览、阶段进度、结构化总结、时间线要点和连续追问界面。
- 首屏主标题已移入顶栏中部，来源输入卡片与对话面板顶部对齐；已移除重复的英文眉题、介绍段落和顶栏模型状态胶囊，移动端标题在顶栏内独占第二行。
- 本地视频支持 MP4、MOV、WebM、MKV、M4V；本地和 HTTPS 视频由媒体服务先转为最长边 854px 的 H.264/AAC 素材，再按时长选择直接视频或关键帧＋音轨。
- 所有分析源文件限制为 500 MB、60 分钟；B站“获取视频”会准备默认最高兼容画质的 Range 播放与附件下载 URL，不再把整段预览视频读成浏览器 `File`。
- HTTPS 视频直链先由浏览器按 CORS 规则下载并上传媒体服务；B站页面链接不再误走直链模式。
- B站视频使用网页自己的 HTML5 播放器；最高画质获取与约 480p 的 AI 总结素材是两个独立任务，分析阶段不复用最高画质文件。获取任务完成后播放器通过 HTTP Range 边播放边缓存，并提供浏览器手动下载入口。
- 已处理分析/问答取消、重置竞态、页面离开清理、错误展示与模型配置状态。
- 左侧已加入一视频一对话的 D1 历史列表，支持新建、切换、重命名和删除。B站对话保存 BV 号和标准视频页 URL，刷新或重新进入时自动创建新的临时预览；本地上传只保存总结与消息，刷新后需重新选择原文件。临时签名地址和视频副本都不会写入对话。
- 恢复本地视频对话时不会恢复视频字节；用户可重新选择任意本地视频预览或更改文件，越界时间点不会执行跳转。
- “生成 AI 总结”旁边提供分析设置，字幕提取默认开启；关闭后所有来源都跳过 Nano＋CT-Punc。
- 顶栏显示设置支持浅色/黑灰暗色主题；UI 与总结/对话文本可分别选择中英文字体并输入 12–28px 精确字号，默认均为 16px，偏好保存在浏览器 localStorage。

### 模型调用

- `POST /api/model/analyze`：调用 `qwen3.5-omni-plus`，接受视频 URL、音轨、关键帧或转写文本，返回标题、概览、要点、章节、结论、独立声音分析与证据索引。
- 新总结强制返回 `audioAnalysis`，分别记录讲话、音乐、环境声、声音时间变化和不确定性；没有音频证据时明确标记 `unavailable`，旧总结在追问接口中仍保持兼容。
- Qwen 使用服务端流式接收和 JSON 模式；解析器兼容完整代码块以及响应末尾多出的 Markdown 围栏。
- `POST /api/model/ask`：调用 `deepseek-v4-pro`，输入视频信息、结构化总结、字幕、证据和最近 20 条历史消息，不重复发送原视频。
- Qwen 与 DeepSeek 密钥仅通过服务端环境变量读取，不进入浏览器包。

### B站下载

- 网站控制面已实现 `POST /api/bilibili/jobs`、`GET /api/bilibili/jobs/:jobId`、`DELETE /api/bilibili/jobs/:jobId`，只转发小型 JSON，不代理视频字节。
- `media_service/` 已实现 FastAPI 异步任务服务：只接受严格 BVID，固定拼接 B站标准地址，不接受任意 URL、Cookie、登录信息或自定义 yt-dlp 参数。
- 媒体服务通过 `-I -u -X utf8=1` 强制 UTF-8、非缓冲的受控子进程调用固定版本 `yt-dlp`，只处理无需登录的公开 UGC；`preview` 任务选择默认最高兼容画质并使用独立 1 GB 默认安全上限，`analysis` 任务最长边不超过 854px（约 480p）且使用 500 MB 上限；每个格式 fallback 都从源头硬性筛选 H.264 视频与 AAC 音频。
- 下载前校验来源、公开可用性、直播状态、时长和预计体积；下载中持续限制字节数；完成后用 ffprobe 校验时长、大小、MP4 容器以及全部音视频轨的 H.264/AAC 白名单，并计算 SHA-256。
- `preview` 成品由浏览器通过临时签名 URL 进行 Range 播放或附件下载；`analysis` 成品由媒体服务直接生成分析清单：短视频供网站服务端流式上传 DashScope，长视频返回带真实时间戳的音轨和关键帧证据。
- B站音轨在浏览器与模型 API 两层均为必需证据：音频转码失败或结果为空会终止任务，只有关键帧而无音轨的 B站分析请求会被拒绝，不再静默生成纯画面总结。
- 已实现任务并发/队列上限、20 分钟执行超时、22 分钟网页总等待、取消整个子进程树、失败即时清理、成品 TTL 清理、精确 CORS 与本机无令牌保护；失败清理会删除媒体残片但保留原始错误。
- 本机已安装 Python 依赖并检测到 yt-dlp、FFmpeg、ffprobe；健康检查、CORS 预检和非法 BVID 接口冒烟测试通过。
- 已修复客户端把合法的 `running/failed + error` 任务快照误判为无效响应的问题；worker 错误会原子落为 `failed + error`，轮询、主动清理、服务停止/重启与 TTL 过期均不会再用泛化状态覆盖原始错误。

### 工程状态

- Python 编译、媒体服务单元测试、前端生产构建、ESLint、类型检查和页面/API/客户端回归测试均已纳入交付前验证。
- `.env.local`、`.venv` 和媒体服务临时数据均已排除版本控制；`.env.example` 只保留空占位符。
- 私有 Sites 项目已绑定在 `.openai/hosting.json`；D1 逻辑绑定为 `DB`，项目不绑定 R2。
- 此前版本曾发布到 owner-only 私有 Sites；当前本地 Range 播放、去 R2 与清理改动尚未部署。
- Qwen 只负责视频总结；DeepSeek 负责后续对话。总结提示词改为“内容概览 + 带时间的时间线要点”，音轨证据融入概览和时间线，不再在 UI 单独展示“声音与音乐”或“一句话结论”。后续对话提示词允许把视频总结当上下文自然拓展，同时限制提示词泄漏、隐私和无依据声音推断。
- 已修复新总结不再生成一句话结论后，保存对话仍要求 `summary.takeaway` 非空的问题；`takeaway` 现在作为旧总结兼容字段保存，空值会被丢弃，不再阻断 D1 对话创建。

## 正在进行

- 媒体 worker 的真实 B站下载、DASH 合并、ffprobe 白名单校验与单帧解码已成功；所有来源当前统一使用最长边 854px 的分析素材。完整本地/HTTPS 上传、Qwen 总结、可选字幕与 DeepSeek 追问仍待真实媒体端到端复测。
- Sites 只能运行网站控制面，不能运行 Python、yt-dlp、原生 FFmpeg 或 FunASR。线上全部视频分析功能仍需部署独立 HTTPS 媒体容器并配置双方共享令牌。
- 本地 Qwen/DeepSeek 环境已存在配置，但不得在文档或日志中输出值；DeepSeek 真实连续问答仍待用户自行或后续授权执行端到端测试。
- 既往曾暴露的 DeepSeek Key 必须在供应商控制台轮换，旧 Key 不应继续使用。

## 后续计划

### P0：完成真实联调与上线配置

1. 使用有权处理的本地、HTTPS 和 B站视频，完成统一媒体任务、Qwen 总结、可选字幕和 DeepSeek 追问链路。
2. 将 `media_service` 部署为单实例 HTTPS 容器，固定签名密钥、数据卷、精确网站 Origin，并与 Sites 配置同一高强度服务令牌。
3. 在 Sites 配置 Qwen、DeepSeek 与媒体服务运行时变量，重新验证线上状态、下载、总结和追问。
4. 轮换曾暴露的 DeepSeek Key，并只把新 Key 写入本地 `.env.local` 与 Sites Secret。

### P1：支持更大文件与可恢复任务

1. 为当前服务端媒体预处理增加断点续传和可恢复任务，任务结束后继续删除原视频。
2. 如需多实例，仅为临时产物接入带 TTL 的 R2/OSS/S3，不把对象 key 写入对话作为视频恢复依据。
3. 扩展现有 D1 会话库以保存可恢复任务与安全证据元数据；使用 Redis/队列保存异步状态，并将轮询升级为 SSE。
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

原生 FFmpeg/ffprobe 用于所有视频来源；本地上传不再下载或运行浏览器 FFmpeg WebAssembly。

## 关键入口

| 位置 | 职责 |
| --- | --- |
| `app/VideoWorkbench.tsx` | 输入、预览、分析设置、进度、总结、字幕与问答 UI |
| `lib/client/media-analysis-client.ts` | 本地与 HTTPS 视频上传、媒体任务轮询及分析证据读取 |
| `lib/client/bilibili-client.ts` | B站任务轮询、直取媒体、校验与取消 |
| `lib/server/conversation-store.ts` | D1 总结、来源与消息持久化；不保存视频字节 |
| `app/api/bilibili/jobs/` | B站控制面代理，不传输预览视频字节 |
| `app/api/media/jobs/` | 本地与 HTTPS 视频上传和通用任务控制面 |
| `media_service/main.py` | FastAPI 鉴权、任务与签名下载 API |
| `media_service/worker.py` | yt-dlp、FFmpeg/ffprobe 下载、转码、合并与校验 |
| `lib/server/qwen-video-engine.ts` | Qwen 多模态请求和总结解析 |
| `lib/server/deepseek-conversation-engine.ts` | DeepSeek V4 Pro 后续问答 |
| `lib/server/runtime-env.ts` | 本地与 Sites 环境变量读取 |
| `docs/architecture.md` | 当前边界与生产化目标架构 |

## 约束

- 只处理用户拥有或获授权分析的、无需登录即可访问的公开内容；不支持会员、付费、番剧、私密、直播、地区受限内容，也不绕过验证码或风控。
- API Key、媒体服务令牌和签名密钥只放服务端环境变量；不得写入 Git、客户端代码、文档、日志或截图。
- 当前媒体任务和产物保存在单实例本地磁盘；未迁移到数据库/对象存储前，不支持多副本共享状态。
- 新任务开始时先读本文件，再检查 `git status` 和最近提交；完成实质变更后更新本文件并移动事项，避免重复记录。
