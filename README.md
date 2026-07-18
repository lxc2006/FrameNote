# 帧记 FrameNote

一个面向长视频的 AI 总结与持续问答工作台。当前版本优先验证完整产品体验，同时把视频处理、B站素材获取和 AI 模型隔离为可替换的适配器。

## 当前可用

- 导入 MP4、MOV、WebM、MKV、M4V 视频，读取文件名、大小和时长并本地预览。
- 在浏览器内使用 FFmpeg 提取压缩 MP3 音轨和带原视频时间索引的代表性关键帧，原视频不经过应用服务器。
- 粘贴 B站视频链接或 BV 号，进行格式校验和标准化。
- 对 B站来源选择“先下载视频，再进行总结”。
- 展示素材校验、媒体读取、转写理解、总结生成等处理阶段。
- 生成结构化演示总结：概览、关键观点、章节时间线和一句话结论。
- 在独立会话区围绕视频继续追问。
- 响应式桌面与移动端布局，并支持键盘操作和减少动画偏好。

> 当前使用 **Qwen + DeepSeek 双模型适配器**：Qwen 负责视频理解和结构化总结，DeepSeek V4 Pro 负责基于总结、证据与历史消息继续对话。本地视频会先在浏览器中压缩为音轨与关键帧证据；当前安全上限为 300 MB、60 分钟。带正确媒体响应头的 HTTPS 视频直链仍可由 Qwen 直接读取。

## 模型接口

服务端已经接入阿里云百炼的 OpenAI 兼容接口，默认使用 `qwen3.5-omni-plus` 同时理解视频画面、语音和音效。模型层提供：

- `GET /api/model/status`：检查服务端是否已经配置模型。
- `POST /api/model/analyze`：接收视频公网 URL、音频、关键帧列表或转写文本，返回结构化总结。
- `POST /api/model/ask`：使用 `deepseek-v4-pro`，基于结构化总结、事实索引和历史消息继续问答。

复制 `.env.example` 为 `.env.local`，填写 `DASHSCOPE_API_KEY` 和 `DEEPSEEK_API_KEY`。如果百炼控制台提供了带 Workspace ID 的专属兼容地址，同时修改 `DASHSCOPE_BASE_URL`。两种 API Key 都只在服务端读取，不会打包到浏览器。

模型调用层与媒体获取层保持分离。浏览器预处理适合个人使用和中等体积视频；超出本地限制、需要页面恢复或多人并发时，仍应把原视频直传对象存储，再由独立媒体处理器生成音轨和关键帧。

## 本地运行

要求 Node.js `>=22.13.0` 与 pnpm。

```bash
pnpm install
pnpm dev
```

首次处理本地视频时，浏览器会从固定版本的 jsDelivr 地址加载 FFmpeg WebAssembly 核心；随后由浏览器缓存。处理期间需要保持页面打开。

默认预览地址为 `http://localhost:3000`。

```bash
pnpm build
pnpm test
pnpm lint
```

## 代码结构

- `app/VideoWorkbench.tsx`：上传、B站输入、处理进度、总结与追问的完整交互。
- `lib/client/video-preprocessor.ts`：浏览器端 FFmpeg 加载、音轨压缩、关键帧抽取和输入体积控制。
- `lib/video-engine.ts`：统一视频 AI 接口与 Demo 实现；真实模型接入点位于这里。
- `worker/index.ts`：Cloudflare Worker 入口。
- `.openai/hosting.json`：未来 D1 与 R2 逻辑绑定。
- `docs/architecture.md`：生产化架构、API 契约、模型与部署选择建议。

## 下一阶段

1. 增加 D1/R2，保存上传会话、任务状态、总结和对话。
2. 实现浏览器直传 R2 multipart，避免大视频穿过普通 Worker 请求体。
3. 部署独立媒体处理器，负责 FFmpeg、转写和受控的视频源获取。
4. 接入第一个真实 `VideoEngine`，保留 Demo 适配器用于开发和回归测试。
5. 将轮询升级为 SSE，并给总结与回答增加时间戳引用。

## B站能力边界

公开部署前，不应默认开放“下载任意 B站视频”。正式产品建议以用户上传自有视频为主；B站来源只处理用户有权处理的公开视频，并在获得平台授权或受控自托管场景中启用下载能力。不支持会员、付费、番剧、私密或受地区限制的内容，也不接收共享账号 Cookie。

详细约束与生产化拓扑见 [docs/architecture.md](docs/architecture.md)。
