# 帧记生产化架构

## 1. 设计原则

当前模型与部署方式尚未确定，因此产品只依赖统一能力，不绑定具体供应商：

```ts
interface VideoEngine {
  readonly mode: "demo" | "remote";
  analyze(source: VideoSourceDescriptor): Promise<VideoSummary>;
  ask(
    question: string,
    source: VideoSourceDescriptor,
    summary: VideoSummary,
  ): Promise<string>;
}
```

生产版建议进一步拆成三个适配器：

- `BilibiliSourceAdapter`：链接标准化、元数据解析、受控素材获取。
- `ProcessorAdapter`：任务排队、音轨提取、关键帧、字幕与转写。
- `VideoAIAdapter`：结构化总结和基于视频上下文的持续问答。

页面与公共 API 不感知具体模型，只消费标准化的任务状态、总结和回答。

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

站点 Worker 适合做鉴权、任务 API、状态与存储门面，不适合直接运行 FFmpeg 或 yt-dlp。长任务应放在 Docker 媒体 Worker、Cloudflare Container，或其他具有持久计算和临时磁盘的服务中。

## 3. “先下载视频”的服务端语义

UI 中的开关在服务端建议命名为 `retainOriginal`：

- `true`：处理完成后保留用户有权保存的视频副本，并提供受鉴权的下载入口。
- `false`：分析过程仍可能临时获取字幕或音频，但任务完成后删除原始媒体。
- 若模型支持直接读取受支持的媒体 URL，可完全不保存源视频。

这比把它解释为“是否发生任何下载”更准确，因为转写和总结通常仍需临时读取媒体数据。

## 4. 推荐 API

| 方法与路径 | 作用 |
| --- | --- |
| `POST /api/uploads` | 初始化 multipart 上传 |
| `PUT /api/uploads/:id/parts/:part` | 流式写入一个分片 |
| `POST /api/uploads/:id/complete` | 完成上传并生成 `sourceId` |
| `DELETE /api/uploads/:id` | 放弃上传 |
| `POST /api/bilibili/resolve` | 校验链接/BV号并返回标准化来源 |
| `POST /api/jobs` | 创建总结任务，返回 `202` |
| `GET /api/jobs/:id` | 获取阶段、进度、错误与结果 ID |
| `GET /api/conversations/:id` | 获取总结和消息历史 |
| `POST /api/conversations/:id/messages` | 基于视频上下文继续提问 |
| `GET /api/artifacts/:id/download` | 鉴权下载被允许保留的产物 |

创建任务示例：

```json
{
  "source": {
    "type": "bilibili",
    "bvid": "BVxxxxxxxxxx"
  },
  "options": {
    "retainOriginal": false,
    "language": "zh-CN",
    "model": "auto"
  }
}
```

任务状态应统一为：

- `status`: `queued | running | succeeded | failed | cancelled`
- `phase`: `resolving | downloading | extracting | transcribing | summarizing | ready`
- `error`: `{ code, message, retryable } | null`

总结不要只返回一大段 Markdown。建议返回概览、关键点、章节与时间引用，以便前端跳转和问答引用：

```json
{
  "overview": "整体摘要",
  "keyPoints": [{ "text": "关键观点", "startSec": 82 }],
  "chapters": [
    {
      "startSec": 0,
      "endSec": 95,
      "title": "章节标题",
      "summary": "章节摘要"
    }
  ]
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

可先实现两种真实适配器中的一种：

- **视频原生模型**：接入快，链路短；需重点验证长视频限制、成本和时间引用。
- **ASR + 关键帧 + 文本模型**：工程复杂，但更容易控制成本、缓存转写和做可核验引用。

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
- 只允许 HTTPS 和明确域名白名单；短链每次跳转都重新校验，防止 SSRF。
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

1. 保留当前 Demo 流程作为 UI 和回归基线。
2. 接入 D1/R2 与真实上传，仍使用 Demo AI。
3. 上线媒体处理器与异步任务状态。
4. 接入第一个真实 AI 适配器。
5. 增加时间戳引用、SSE、任务恢复和数据删除。
6. 在授权与风控完成后，再启用生产环境的 B站素材获取开关。
