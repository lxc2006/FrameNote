# 帧记生产化架构

## 1. 设计原则

当前实现采用 Qwen3.5-Omni Plus 生成视频总结、DeepSeek V4 Pro 完成总结后的文本问答，并用两类请求隔离页面与供应商细节：

```ts
interface AnalyzeVideoRequest {
  source: VideoSourceDescriptor;
  context: VideoModelContext;
}

interface AskVideoRequest {
  question: string;
  source: VideoSourceDescriptor;
  summary: VideoSummary;
  context?: VideoModelContext;
  history?: VideoConversationMessage[];
}
```

当前已初步拆为三层，后续生产版再将其抽象为可替换接口：

- B站来源层：BVID 标准化、受控下载任务与签名产物。
- 处理层：任务排队、DASH 合并、浏览器音轨/关键帧提取。
- 模型层：Qwen 结构化总结与 DeepSeek 持续问答。

页面与公共 API 不感知具体模型，只消费标准化的任务状态、总结和回答。

当前本地上传提供一条浏览器快速路径：FFmpeg WebAssembly 直接读取用户文件，将单声道 MP3 音轨压缩到目标体积，并按原视频时长均匀抽取最多 24 张 JPEG 关键帧；服务端只接收这些模型证据，不接收完整原视频。该路径适合不超过 300 MB、60 分钟的个人处理，不承担生产环境的大文件持久化、断点续传和后台恢复。

当前 B站来源也已接入这条快速路径：Sites Worker 只代理创建、查询与取消任务的小型 JSON；独立 FastAPI 服务以受控子进程运行 yt-dlp，并调用原生 FFmpeg 合并 B站 DASH 音视频。任务成功后，浏览器通过短期 HMAC 签名 URL 直接下载临时媒体，再复用同一套 FFmpeg WebAssembly 证据抽取。媒体字节不会经过 Sites Worker。由于网络响应需要先形成浏览器 `File`，首版 B站上限收紧为 150 MB；更大来源应改为媒体服务直接抽取证据或写入对象存储。

## 2. 推荐拓扑

```text
浏览器
  ├─ 本地视频分片直传 ──────────────> R2
  └─ 创建任务 / 查询状态 / 继续提问 ─> Sites + vinext Worker
                                           ├─ D1：任务、总结、对话、文件元数据
                                           ├─ R2：视频、音频、字幕、中间产物
                                           └─ 外部媒体处理器 / Container
                                                ├─ yt-dlp（受控场景）
                                                ├─ FFmpeg / ffprobe
                                                ├─ ASR
                                                └─ VideoAIAdapter
```

站点 Worker 适合做鉴权、任务 API、状态与存储门面，不适合直接运行 FFmpeg 或 yt-dlp。当前 `media_service/` 可在本机或单个容器中运行；生产长任务应部署到 Docker 媒体 Worker、Cloudflare Container，或其他具有持久计算和临时磁盘的服务中。

## 3. “先下载视频”的服务端语义

当前首版固定采用“临时下载后分析”：合并文件只在独立媒体服务的任务目录中短期存在，浏览器完整读取后会主动取消/清理任务，服务端 TTL 清理器负责兜底；它不会自动把视频保存到用户下载目录，也不承诺长期保留。

后续加入对象存储后，UI 中的保留选项在服务端建议命名为 `retainOriginal`：

- `true`：处理完成后保留用户有权保存的视频副本，并提供受鉴权的下载入口。
- `false`：分析过程仍可能临时获取字幕或音频，但任务完成后删除原始媒体。
- 若模型支持直接读取受支持的媒体 URL，可完全不保存源视频。

这比把它解释为“是否发生任何下载”更准确，因为转写和总结通常仍需临时读取媒体数据。

## 4. 推荐 API

| 方法与路径 | 状态 | 作用 |
| --- | --- | --- |
| `POST /api/bilibili/jobs` | 已实现 | 以 `{"bvid":"BV..."}` 创建受控下载任务，返回 `202` |
| `GET /api/bilibili/jobs/:id` | 已实现 | 查询解析、下载、合并与就绪状态 |
| `DELETE /api/bilibili/jobs/:id` | 已实现 | 取消任务并清理临时媒体 |
| `POST /api/model/analyze` | 已实现 | 使用 Qwen 生成结构化视频总结 |
| `POST /api/model/ask` | 已实现 | 使用 DeepSeek 基于总结、证据和历史追问 |
| `POST /api/uploads` 与 multipart 分片路由 | 规划 | 初始化、写入、完成或放弃大文件上传 |
| `POST /api/jobs`、`GET /api/jobs/:id` | 规划 | 创建并恢复持久化总结任务 |
| `GET/POST /api/conversations/:id` | 规划 | 持久化总结与消息历史 |
| `GET /api/artifacts/:id/download` | 规划 | 鉴权下载被允许长期保留的产物 |

当前 B站创建任务请求：

```json
{"bvid":"BVxxxxxxxxxx"}
```

当前 B站媒体任务契约：

- `status`: `queued | running | succeeded | failed | cancelled | expired`
- `phase`: `queued | resolving | downloading | merging | ready`
- `error`: `{ code, message, retryable } | null`

规划中的通用持久化任务可在此基础上增加 `extracting | transcribing | summarizing` 阶段，但不能与当前媒体任务契约混用。

当前 Qwen 总结不是一大段 Markdown，而是以下结构化数据：

```json
{
  "title": "视频标题",
  "overview": "整体摘要",
  "keyPoints": [{ "title": "关键点", "detail": "详细说明" }],
  "chapters": [
    {
      "time": "00:00",
      "title": "章节标题",
      "description": "章节摘要"
    }
  ],
  "takeaway": "一句话结论",
  "evidence": [{ "time": "00:12", "fact": "可核验事实" }]
}
```

## 5. 存储边界

D1 存结构化数据：

- 来源、BV 号、R2 key、所有者与保留策略。
- 上传会话、任务状态、阶段、进度与错误。
- 总结、模型版本、提示词版本、对话和时间引用。
- 可下载产物的元数据。

R2 存大对象：

- 原视频、合并后视频和抽取音频。
- 完整字幕 JSON/VTT。
- 大型模型中间产物。

视频和完整字幕不能放入 D1。上传过程必须流式或 multipart，不能在 Worker 中对整个视频调用 `arrayBuffer()`。

## 6. 模型选择标准

在选型时比较以下能力，而不是先写死模型名称：

1. 中文语音识别准确率、说话人区分和时间戳质量。
2. 是否原生支持长视频，或需要“音频/关键帧/字幕”组合管线。
3. 单视频时长与文件大小限制。
4. 结构化 JSON 输出与时间引用能力。
5. 问答流式输出、上下文复用和缓存价格。
6. 数据驻留、保留策略、内容安全与可观测性。
7. 失败重试、并发限制和成本上限。

当前已经采用两条真实输入路径：

- **HTTPS 视频直链 → Qwen 多模态模型**：链路短，适合模型可直接访问的媒体。
- **音轨 + 关键帧 → Qwen 多模态模型**：适合本地上传与 B站下载，便于控制请求体和证据时间索引。

后续长视频优化方向是服务端 ASR、分段关键帧、证据检索与文本模型合并；重点验证成本、时间引用和可恢复性。

## 7. 部署选项

### A. 快速上线

- Sites/vinext：页面与任务 API。
- D1/R2：任务与文件。
- 托管容器：FFmpeg、ASR、视频源适配器。
- 云端多模态或文本模型：总结与问答。

这是首个真实版本的推荐组合。

### B. Cloudflare 为主

- Worker 做控制面。
- R2/D1 做数据层。
- Queues/Workflows 做调度。
- Cloudflare Containers 跑媒体处理。

需要额外确认 Sites 对 Queue、Workflow 和 Container 的绑定方式。

### C. 完全自托管

- Web/API、PostgreSQL、S3 兼容存储、Redis 队列和 GPU/CPU 媒体 Worker 全部容器化。
- 控制力最高，但运维、弹性和安全成本也最高。

## 8. B站合规与安全边界

- BV 号第一层格式校验可用 `^BV[0-9A-Za-z]{10}$`，语法通过不代表视频存在或允许下载。
- 当前不抓取用户提交的任意 URL：前端只提取 BVID，服务端固定拼接 B站 HTTPS UGC 地址，因此不支持不含 BVID 的短链。
- 如后续支持短链，只允许 HTTPS 和明确域名白名单，并在每次跳转后重新校验，防止 SSRF。
- 默认只处理无需登录即可访问的公开 UGC。
- 不支持会员、付费、番剧、课堂、私密、地区限制内容，也不绕过验证码和风控。
- 不接收用户名、密码或共享运营账号 Cookie；不得跨用户缓存源视频。
- 正式公开下载能力前，应取得平台书面许可并完成版权、隐私与内容安全评估。
- 总结应以事实性概述为主，避免输出完整逐字稿或大段原文。

相关一手资料：

- [B站用户使用协议](https://www.bilibili.com/blackboard/user-rule-linux.html)
- [B站开放平台](https://open.bilibili.com/doc)
- [yt-dlp Bilibili 提取器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)
- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
- [R2 multipart](https://developers.cloudflare.com/r2/api/workers/workers-multipart-usage/)

## 9. 推荐实施顺序

1. 用用户有权处理的公开 BVID 完成真实下载、证据抽取、Qwen 总结和 DeepSeek 追问烟测。
2. 将媒体服务部署为单实例 HTTPS 容器，配置 Token、签名密钥、精确 CORS 和临时数据卷。
3. 接入 D1/R2 与 multipart 直传，将浏览器整文件处理迁移为服务端证据抽取。
4. 增加持久队列、任务恢复、SSE、幂等重试和数据删除。
5. 增加服务端 ASR、分段总结与证据检索，提升长视频质量。
6. 完成用户鉴权、限流、配额、版权授权与风控评估后，再开放生产环境 B站能力。
