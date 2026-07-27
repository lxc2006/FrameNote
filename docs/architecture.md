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

- 来源层：本地上传、HTTPS 直链下载，以及 BVID 标准化和受控 B 站预览。
- 处理层：任务排队、DASH 合并、低分辨率转码、音轨与关键帧提取。
- 模型层：Qwen 结构化总结与 DeepSeek 持续问答。

页面与公共 API 不感知具体模型，只消费标准化的任务状态、总结和回答。

本地上传和 HTTPS 直链先由网页把原始文件流式提交到独立媒体服务。媒体服务使用 `ffprobe` 校验时长和轨道，再由原生 FFmpeg 转成最长边不超过 854px 的 H.264/AAC 临时素材。原始上传在转码完成后删除，分析素材在任务结束或 TTL 到期时删除；它们都不会写入对话数据库。

当前 B站媒体分成两类任务：用户点击“获取视频”时，`preview` 任务准备默认最高兼容画质 MP4，网页使用签名播放 URL 通过 HTTP Range 边播放边缓存，并提供附件下载 URL；AI 总结另建 `analysis` 任务，只准备约 480p、最大 500 MB 的素材，绝不复用最高画质文件。

获取视频和生成总结时，Sites Worker 代理任务控制数据及本地/HTTPS 上传流；独立 FastAPI 服务以受控子进程运行 yt-dlp 和原生 FFmpeg。所有来源在得到低分辨率分析视频后按时长分流：短视频由服务端流式上传 DashScope 临时存储并直接交给 Qwen；长视频由媒体服务提取音轨和关键帧。Qwen 完成后再按用户设置启动 FunASR，字幕独立保存但不进入本次总结提示。B站对话保存 BV 号并自动恢复预览；本地对话不保存视频，恢复后由用户重新选择预览文件。

## 2. 推荐拓扑

```text
浏览器
  ├─ 本地视频 / HTTPS 下载流 ────────────────┐
  └─ 创建任务 / 查询状态 / 继续提问 ────> Sites + vinext Worker
                                              ├─ D1：来源、总结、字幕、对话
                                              └─ 外部媒体处理器 / Container
                                                   ├─ 临时磁盘/带 TTL 对象
                                                   ├─ yt-dlp（受控 B 站场景）
                                                   ├─ FFmpeg / ffprobe
                                                   └─ PySceneDetect / FunASR
```

站点 Worker 适合做鉴权、任务 API、状态与存储门面，不适合直接运行 FFmpeg 或 yt-dlp。当前 `media_service/` 可在本机或单个容器中运行；生产长任务应部署到 Docker 媒体 Worker、Cloudflare Container，或其他具有持久计算和临时磁盘的服务中。

## 3. “先下载视频”的服务端语义

当前采用临时任务文件：本地和 HTTPS 原始上传在低分辨率转码完成后删除；AI 分析素材在 Qwen/字幕步骤结束后由网页主动清理，异常时由 TTL 兜底。最高兼容画质 B 站文件在媒体服务保留期内通过签名 URL 提供 Range 播放和附件下载。B站对话不保存视频副本，恢复历史时依赖保存的 BV 号重新创建临时预览，因此不会持久化过期签名 URL。

如果后续为了多实例共享而接入对象存储，对象也只作为带 TTL 的任务临时产物，不写入对话作为长期恢复依据。转写和总结可以临时读取媒体，但任务完成或 TTL 到期后必须删除。

## 4. 推荐 API

| 方法与路径 | 状态 | 作用 |
| --- | --- | --- |
| `POST /api/bilibili/jobs` | 已实现 | 以 `{"bvid":"BV...","variant":"preview\|analysis"}` 创建受控下载任务，返回 `202` |
| `GET /api/bilibili/jobs/:id` | 已实现 | 查询解析、下载、合并与就绪状态 |
| `POST /api/bilibili/jobs/:id/transcript` | 已实现 | Qwen 完成后异步启动 FunASR 字幕提取 |
| `DELETE /api/bilibili/jobs/:id` | 已实现 | 取消任务并清理临时媒体 |
| `POST /api/media/jobs` | 已实现 | 流式上传本地或 HTTPS 视频，生成低分辨率分析任务 |
| `GET/DELETE /api/media/jobs/:id` | 已实现 | 查询或清理通用媒体分析任务 |
| `POST /api/media/jobs/:id/transcript` | 已实现 | 为通用媒体任务启动 FunASR 字幕提取 |
| `POST /api/model/analyze` | 已实现 | 使用 Qwen 生成结构化视频总结 |
| `POST /api/model/ask` | 已实现 | 使用 DeepSeek 基于总结、证据和历史追问 |
| `POST /api/jobs`、`GET /api/jobs/:id` | 规划 | 创建并恢复持久化总结任务 |
| `GET/POST /api/conversations`、`GET/PATCH/DELETE /api/conversations/:id` | 已实现 | 持久化来源、总结与消息历史，不保存视频 |

当前 B站创建任务请求：

```json
{"bvid":"BVxxxxxxxxxx","variant":"preview"}
```

当前 B站媒体任务契约：

- `status`: `queued | running | succeeded | failed | cancelled | expired`
- `phase`: `queued | resolving | downloading | merging | analyzing | ready`
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
  "audioAnalysis": {
    "status": "analyzed",
    "summary": "声音整体概述",
    "music": "可听见的音乐风格、节奏、音色和氛围",
    "soundscape": "可辨的环境声，若不存在则为 null",
    "temporalChanges": [
      { "time": "00:30", "description": "声音出现可靠变化" }
    ]
  },
  "evidence": [{ "time": "00:12", "fact": "可核验事实" }]
}
```

`audioAnalysis.status` 取值为 `analyzed | silent | unavailable`。新分析必须返回该字段；旧的已保存总结仍可在问答接口中省略。Qwen 提示词会显式区分独立音轨、视频内嵌音轨和无音频证据三种情况，并禁止从标题或画面猜测音乐、讲话与环境声。

## 5. 存储边界

D1 存结构化数据：

- 稳定来源信息，例如 BVID 或用户提交的 HTTPS 原链接。
- 总结、模型版本、对话、时间引用与所有者。

媒体服务临时目录存任务产物：

- `preview` MP4：在 TTL 内提供 Range 播放和附件下载。
- `analysis` MP4：短视频由网站服务端流式上传到模型临时存储；长视频只向浏览器返回音轨与关键帧证据。任务结束后主动清理，异常时由 TTL 兜底。

视频字节、临时签名 URL 和对象 key 都不能放入 D1。字幕作为文本随对话保存。网站 Worker 不应把整个视频读入 `arrayBuffer()`。

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

- **压缩后的短视频 → Qwen 多模态模型**：适合阈值内的本地、HTTPS 和 B站视频，统一按 1 FPS 读取。
- **音轨 + 关键帧 → Qwen 多模态模型**：适合超过阈值的视频，便于控制请求体和证据时间索引。

后续长视频优化方向是服务端 ASR、分段关键帧、证据检索与文本模型合并；重点验证成本、时间引用和可恢复性。

## 7. 部署选项

### A. 快速上线

- Sites/vinext：页面与任务 API。
- D1：来源、总结与对话。
- 临时磁盘或带 TTL 的对象存储：媒体任务产物。
- 托管容器：FFmpeg、ASR、视频源适配器。
- 云端多模态或文本模型：总结与问答。

这是首个真实版本的推荐组合。

### B. Cloudflare 为主

- Worker 做控制面。
- D1 做持久化数据层；R2 如启用只保存带 TTL 的临时产物。
- Queues/Workflows 做调度。
- Cloudflare Containers 跑媒体处理。

需要额外确认 Sites 对 Queue、Workflow 和 Container 的绑定方式。

### C. 完全自托管

- Web/API、PostgreSQL、S3 兼容存储、Redis 队列和 GPU/CPU 媒体 Worker 全部容器化。
- 控制力最高，但运维、弹性和安全成本也最高。

## 8. B站合规与安全边界

- BV 号第一层格式校验可用 `^BV[0-9A-Za-z]{10}$`，语法通过不代表视频存在或允许下载。
- B 站适配器不抓取用户提交的任意 URL：服务端固定拼接 B站 HTTPS UGC 地址，因此不支持不含 BVID 的短链。HTTPS 直链由浏览器按 CORS 规则读取后作为文件上传，媒体服务本身不发起该 URL 请求。
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

## 9. 推荐实施顺序

1. 用用户有权处理的公开 BVID 完成真实下载、证据抽取、Qwen 总结和 DeepSeek 追问烟测。
2. 将媒体服务部署为单实例 HTTPS 容器，配置 Token、签名密钥、精确 CORS 和临时数据卷。
3. 如需多实例，将临时媒体迁移到带 TTL 的对象存储，并把任务状态迁移到共享队列。
4. 增加持久队列、任务恢复、SSE、幂等重试和数据删除。
5. 增加服务端 ASR、分段总结与证据检索，提升长视频质量。
6. 完成用户鉴权、限流、配额、版权授权与风控评估后，再开放生产环境 B站能力。
