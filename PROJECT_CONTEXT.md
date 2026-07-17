# FrameNote 项目上下文

> 最后更新：2026-07-18  
> 用途：在新任务开始时恢复上下文。本文件只记录当前事实与决策，不记录 API Key、令牌或完整对话。

## 项目定位

FrameNote（帧记）是视频 AI 总结与持续问答工作台。当前技术栈为 vinext/Next.js、React、Cloudflare Worker 与 OpenAI 兼容 SDK；采用双模型分工：Qwen 理解视频，DeepSeek 负责总结后的文本问答。

## 已完成

### 产品与前端

- 已完成响应式工作台：本地视频选择/预览、B站或直链输入、处理进度、结构化总结、章节时间线和连续追问。
- 本地视频当前支持 MP4、MOV、WebM、MKV、M4V，模型内联直传上限为 7 MB。
- 支持可由模型直接访问的 HTTPS 视频直链；B站页面链接只做识别与规范化，尚不获取实际媒体流。
- 已处理分析和问答请求的取消、重置竞态、错误提示及模型配置状态展示。

### 模型调用

- `GET /api/model/status`：返回 Qwen 视频模型和 DeepSeek 对话模型的配置状态，不泄露密钥。
- `POST /api/model/analyze`：调用 `qwen3.5-omni-plus`，接受视频 URL/Base64、关键帧或转写文本，返回概览、要点、章节、结论和证据索引。
- Qwen 请求使用服务端流式接收、JSON 模式、输入校验与提示注入防护；解析器兼容完整代码块及单独多出的 Markdown 围栏。
- `POST /api/model/ask`：调用 `deepseek-v4-pro`，输入结构化总结、证据索引和最近 20 条历史消息；不重复发送完整视频。
- Qwen 与 DeepSeek 均通过服务端环境变量配置，API Key 不进入客户端包。

### 工程与部署

- 已实现统一的 Worker/Sites 运行时环境绑定、供应商鉴权/限流/失败错误映射和客户端错误处理。
- 已覆盖服务端渲染、状态接口、请求校验、Qwen 分析、异常 JSON 围栏和 DeepSeek 问答的自动化回归；最近一次构建、类型检查、Lint 与 5 项测试均通过。
- 私有站点已部署：[https://framenote-video-ai.tsanugussh.chatgpt.site](https://framenote-video-ai.tsanugussh.chatgpt.site)。最近部署源码提交为 `86de638`。
- `.env.example` 仅保留空白占位符；本地密钥文件已由 `.gitignore` 排除。

## 正在进行

- 建立并持续维护本交接文档；后续每次完成实质变更后同步更新。
- 本地 `.env.local` 已检测到 Qwen 与 DeepSeek Key，但 DeepSeek 真实问答尚未执行端到端烟雾测试。
- Sites 托管环境当前没有运行时变量，因此线上模型调用在配置 Secrets 前不可用。
- 曾误填入 `.env.example` 的 DeepSeek Key 已清除，但因其出现在当前任务输出中，仍需在 DeepSeek 控制台轮换。

## 后续计划

### P0：完成双模型上线

1. 轮换 DeepSeek Key，将新 Key 写入本地 `.env.local` 和 Sites Secret。
2. 在本地分别完成 Qwen 视频分析与 DeepSeek 连续追问的真实烟雾测试。
3. 配置 Sites 的 Qwen/DeepSeek 运行时变量，重新部署并验证线上状态、分析和追问。

### P1：支持 B站与大文件

1. 接入 R2/OSS/S3：预签名 multipart 直传，避免大视频经过 Base64 JSON 和普通 Worker 请求体。
2. 接入 D1/数据库：保存来源、上传会话、任务状态、总结、证据和对话记录。
3. 建立异步任务 API、队列和 SSE/轮询进度，支持失败重试、取消及页面恢复。
4. 部署独立媒体 Worker：负责 ffprobe/FFmpeg、音视频合并、转写、关键帧和分段。
5. 实现合规的 B站来源适配器；只处理用户有权分析的公开内容，不绕过登录、付费、地区或风控限制。

### P2：提升长视频质量与生产可靠性

1. 按场景或时长分段，执行“分段分析 → 全局合并”，统一原视频时间戳。
2. 为问答增加证据检索/RAG，只召回相关字幕、关键帧和章节，降低成本并提高可核验性。
3. 增加身份鉴权、速率限制、配额、幂等、审计、日志脱敏、成本监控和数据删除策略。
4. 增加真实媒体、超时、限流、空响应、格式异常与大上下文的集成测试。
5. 同步更新 `docs/architecture.md` 中仍以 Demo/未选模型为前提的旧描述。

## 关键入口

| 位置 | 职责 |
| --- | --- |
| `app/VideoWorkbench.tsx` | 上传、来源输入、进度、总结和问答 UI |
| `app/api/model/analyze/route.ts` | Qwen 视频分析接口 |
| `app/api/model/ask/route.ts` | DeepSeek 视频问答接口 |
| `app/api/model/status/route.ts` | 双模型配置状态 |
| `lib/server/qwen-video-engine.ts` | Qwen 多模态请求与总结解析 |
| `lib/server/deepseek-conversation-engine.ts` | DeepSeek V4 Pro 问答 |
| `lib/server/model-route.ts` | 请求校验与统一错误响应 |
| `lib/server/runtime-env.ts` | 本地及 Sites 环境变量读取 |
| `.env.example` | 无密钥的环境变量模板 |
| `docs/architecture.md` | B站、大文件和生产化目标架构 |

## 配置与约束

- 本地密钥只放 `.env.local`；托管密钥只放 Sites Runtime Environment Variables，并标记为 Secret。
- Qwen：`DASHSCOPE_API_KEY`，默认模型 `qwen3.5-omni-plus`。
- DeepSeek：`DEEPSEEK_API_KEY`，默认模型 `deepseek-v4-pro`，默认 Base URL `https://api.deepseek.com`。
- 普通模型请求体上限为 14 MB；7 MB 本地视频经 Base64 后仍可落在该限制内。
- `.openai/hosting.json` 已绑定 Sites 项目，但 D1/R2 目前均为 `null`。

## 新任务接续步骤

1. 先阅读本文件，再查看 `git status` 和最近提交；不要从聊天记录猜测状态。
2. 检查相关代码与运行时配置是否发生变化，不输出任何密钥值。
3. 从“正在进行”或最高优先级未完成项继续。
4. 完成工作后更新日期，并把事项在各章节间移动，避免重复保留。
