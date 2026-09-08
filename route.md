# FrameNote 当前工作链路与参数

> 本文记录当前桌面版代码的真实运行方式，不是后续规划。更新日期：2026-09-08。

## 1. 运行边界

FrameNote 当前是桌面独占应用，分成四层：

```text
React Renderer
  ├─ 类型安全 IPC ──> Electron preload ──> Electron main
  │                                      ├─ Qwen / DeepSeek Responses
  │                                      ├─ SQLite 与加密 API Key
  │                                      └─ 本地文件打开、下载与外部链接
  └─ 带令牌的 loopback HTTP ─────────────> Python media core
                                         ├─ FFmpeg / ffprobe
                                         ├─ yt-dlp（B站/抖音公开内容）
                                         ├─ 关键帧与音轨
                                         └─ 临时分析任务与签名资源
```

- Renderer 不直接持有 Node.js 能力，也不直接读取 SQLite 或 API Key。
- `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`；preload 只暴露 `window.framenoteDesktop` 中定义的能力。
- 模型调用、对话持久化、凭据、文件系统操作均在 Electron 主进程。
- Python media core 只监听 `127.0.0.1`。Electron 启动时生成访问令牌和签名密钥；Renderer 从 IPC 获取本次连接信息后才能访问媒体接口。
- 在线字幕只有 Qwen ASR，不包含 FunASR、CT-Punc、PyTorch 或本地字幕模型，也不读取 B站内嵌字幕。

主要入口：

| 层 | 入口 | 作用 |
| --- | --- | --- |
| Renderer | `src/renderer/src/components/VideoWorkbench.tsx` | 页面状态、来源选择、进度、总结与问答编排 |
| Preload | `src/preload/index.ts` | 将受控 IPC API 暴露给 Renderer |
| IPC 契约 | `src/shared/ipc-contract.ts` | main / preload / renderer 共用的通道与类型 |
| Main | `src/main/index.ts` | 初始化凭据、sidecar、SQLite、窗口和自动更新 |
| 模型服务 | `src/main/services/model-service.ts` | 总结、回答、回顾和联网搜索的总编排 |
| 媒体核心 | `media_service/main.py` | 本机媒体 HTTP API |
| 媒体 worker | `media_service/worker.py` | 下载、校验、转码并生成分析素材 |

## 2. 视频进入应用

### 2.1 本地视频

1. 用户选择 MP4、WebM、MOV、MKV 或 M4V；Renderer 先拒绝超过 500 MB 的文件。
2. Electron 记录真实绝对路径，并通过受控的 `framenote-media:` 协议提供播放器地址。
3. 点击总结后，文件以 multipart 上传到本机 media core 的 `/v1/media/jobs`。
4. 总结保存时，`source.localPath` 一起进入 SQLite。以后打开历史对话时按该路径重新打开原文件；文件已移动、改名或删除时才提示找不到。

### 2.2 HTTPS 视频直链

1. 只接受没有用户名和密码的 HTTPS 地址。
2. Renderer 下载成 `File`，限制 500 MB，然后复用本地媒体任务链路。
3. 历史记录保存原始 URL；再次打开对话时仍从该 URL 加载。

### 2.3 B站视频

预览和分析是两条独立请求：

- “获取视频”调用 `/v1/bilibili/preview`，media core 解析 CDN 视频/音频流并代理给播放器，不先保存整段视频。
- “总结视频”创建 `/v1/bilibili/jobs` 分析任务，下载并生成受控的分析 MP4。
- 若用户没有先点“获取视频”，点击“生成 AI 总结”会同时启动独立的预览请求并在左栏显示；预览不占用总结进度条，预览失败也不会中断总结链路。
- 当前不携带用户浏览器 Cookie，不登录 B站；仅接受单个、公开、无需登录的 UGC 视频，不支持番剧、会员内容、直播或直播回放。
- 元数据解析遇到 412 等可重试错误时，完整解析最多尝试 5 次，失败后固定等待 2 秒再试；只有第 5 次仍失败才向上报告最终错误。
- 下载层本身还配置网络/分片重试 10 次、文件访问重试 3 次，分片并发数为 4。这和上面的“5 次完整解析”不是同一层重试。
- 播放器画面非原生控制条区域支持单击播放/暂停、双击进入或退出应用内全屏；单击会延迟 220 ms，以区分双击并避免一次双击触发两次播放切换。

### 2.4 抖音视频

1. 用户切到“抖音”并粘贴分享文本或 `douyin.com` / `v.douyin.com` 的 HTTPS 链接；Renderer 只提取其中第一个合法抖音链接。
2. “获取视频”调用 `/v1/douyin/preview`。media core 使用 yt-dlp 解析公开分享页，最多完整尝试 5 次，并选择最高不超过 1080p、同时带画面和声音的 MP4 流。
3. 原始 CDN 地址和所需请求头不会交给 Renderer；media core 建立短期预览会话，由 `/v1/douyin/preview/{session}/video` 代理并支持 Range 播放。
4. 点击总结时，Renderer 从本机代理读取视频并上传到 `/v1/media/jobs`，`sourceKind=douyin`；之后完全复用 HTTPS/本地媒体的校验、转码、关键帧、音轨、Qwen 总结与在线 ASR 链路。
5. 历史记录只保存原分享链接与公开元数据，重新打开时再次解析预览。应用不读取浏览器 Cookie，不处理需要登录、验证码、私密或其他访问限制的内容。

### 2.5 视频下载按钮

- 下载由主进程弹出系统“另存为”，Renderer 不能自行指定任意文件路径。
- 本地视频复制原文件；HTTPS 来源由主进程流式下载；抖音会重新解析原分享链接并流式保存带声音的 MP4。
- B站下载重新获取一次预览流，分别下载视频轨和音频轨，再用随 media core 提供的 FFmpeg 做无重编码合并和 `faststart`。
- 所有来源先写到目标磁盘上的 `.framenote-download-*` 临时目录，成功后原子重命名为用户选择的文件；取消或失败会删除临时目录。
- 单次远程流下载超时 30 分钟；关闭页面或应用会取消在途下载。

## 3. 首次总结链路

### 3.1 页面阶段

Renderer 展示五个阶段：

1. 上传本地视频 / 读取 HTTPS 视频直链 / 下载 B站分析视频 / 读取抖音分享视频。
2. 压缩或准备约 480p 的分析视频。
3. 按时长准备完整视频或关键帧。
4. Qwen 视频总结与在线字幕识别并行运行；关闭字幕时只运行视频总结。
5. 保存总结与对话。

媒体任务轮询间隔为 1 秒，前端最长等待 22 分钟；media core 单任务默认超时为 20 分钟。

### 3.2 媒体约束和转码

通用限制：

- 最大时长：3600 秒（60 分钟）。
- 最大输入/输出：500 MB。
- 必须包含视频轨和音频轨；没有音轨会拒绝，因为完整总结和在线字幕都依赖声音。
- worker 输出 MP4；视频 H.264、`yuv420p`，音频 AAC。
- 本地/HTTPS 输入的分析转码：最大边 854 像素、保持比例、`libx264`、`preset=veryfast`、`CRF=28`、AAC 96 kbps、`faststart`。
- B站分析下载直接选择最大边不超过 854 像素的 H.264 MP4 + AAC M4A，最终仍用 ffprobe 校验容器、编解码、时长和大小。

### 3.3 直接总结与非直接总结的分界

设置项 `qwenDirectSummaryMaxSeconds` 决定分支：

- 默认 360 秒。
- 可设置范围 0～900 秒。
- 视频时长 `<=` 阈值且阈值大于 0：`direct`，把受签名保护的完整分析 MP4 地址交给 Qwen，模型读取视频内嵌音轨，采样参数 `fps=1`。
- 视频长于阈值，或阈值设为 0：`keyframes`，不把整段视频交给总结模型，而是发送关键帧图片和一条从 0 秒开始对齐的完整独立音轨。

注意：两种模式都会先提取 ASR 所需音频。`direct` 的“直接”只表示视频总结走完整 MP4，并不表示在线字幕无需准备音轨。

### 3.4 非直接总结：关键帧规则

实现位于 `media_service/analysis_pipeline.py`。

#### 候选锚点

1. 均匀锚点间隔为 `max(1 秒, 视频时长 / 50)`，所以长视频大约产生 50 个均匀锚点；短视频最多每秒一个。
2. 额外运行 PySceneDetect `AdaptiveDetector`：
   - `adaptive_threshold=3.0`
   - `min_scene_len=12` 帧
   - `window_width=2`
   - `min_content_val=15.0`
   - `start_in_scene=true`
3. 转场起点最多保留 80 个，超过时在整段时间轴上等距取样。
4. 均匀锚点与转场锚点合并，同一时间点只保留一次，并标记它是否为转场点。

#### 每个锚点附近选图

- 搜索半径为 `min(0.75 秒, max(0.12 秒, 锚点间隔 × 0.18))`。
- 在 `-半径、-半径/2、锚点、+半径/2、+半径` 五个位置解码候选帧。
- 转场锚点计算半径时使用 `min(均匀间隔, 1.5 秒)`，避免在过大范围内偏离转场。
- 五张中先保留画面质量最高的一张。

#### 打分、去重与输出

画面质量分：

```text
0.48 × 清晰度(Laplacian 方差)
+ 0.20 × 对比度
+ 0.14 × 曝光合理度
+ 0.18 × 灰度信息熵
```

最终排序分还会加入：

```text
质量分 + 0.28 × 画面独特性 + 转场锚点奖励 0.08
```

- 每张图计算 8×8 pHash；与已选图片的汉明距离 `<= 8` 视为重复并跳过。
- 最多输出 64 张，按原视频时间重新排序。
- Renderer 要求关键帧模式至少有 3 张，否则认为分析素材无效。
- 图片最长边缩至 640 像素，JPEG 质量 78。
- Renderer 每批并行读取 6 张并转为 data URL，再提交给 Qwen。
- 每张图前插入 `KF_001`、`KF_002`…和真实原视频时间；Qwen 输出中的 KF 标识会在主进程重新映射为真实时间，防止模型把稀疏图片序号误当时间轴。

### 3.5 音频与在线字幕素材

- 从第一条音轨提取单声道、16 kHz、40 kbps MP3，文件名为 `analysis-audio.mp3`。
- 总时长不超过 285 秒时，整条 MP3 同时作为一个 ASR 分片。
- 超过 285 秒时，以 285 秒切片；单片服务端校验上限为 300.5 秒。
- 最多 32 片，每片最多 10 MB。
- Qwen ASR 默认模型：`qwen-audio-3.0-asr-flash`。
- 语言提示只支持中文 `zh`、日语 `ja`、英语 `en`。页面把“全选”和“全不选”都显示为自动识别中、日、英；实际请求中全选会传三种 `language_hints`，全不选则省略 `language_hints`。
- 主进程先并行读回所有受签名保护的音频片，再按时间顺序逐片调用 ASR，保证输出拼接顺序稳定。
- 每片请求超时默认 300 秒；429、5xx、超时或网络错误最多额外重试 2 次，即总共最多 3 次，等待 750 ms、1500 ms。
- 单个分片返回 HTTP 400 且 `code` 或 `message` 为 `ASR_RESPONSE_HAVE_NO_WORDS` 时，按“该分片没有有效语音”跳过，不重试也不丢弃其他分片；只有全部分片都没有文字时，整段字幕才标记为不可用。
- 字幕句对象按 DashScope 的 `output.output.sentence` 读取，同时兼容旧的 `output.sentence`；优先使用词级时间生成 cue，没有可用词级结果时退化到句级时间。
- DashScope 最终失败时只把经过长度限制、控制字符清理和凭据脱敏的 `code`、`message`、`request_id` 写入主进程日志并带回页面错误提示，不记录 API Key、音频 Base64 或完整响应体。

### 3.6 总结与字幕的并行关系

媒体准备完成后立即同时创建两个 Promise：

```text
共享 media job
  ├─ Qwen 视频总结：完整 MP4，或关键帧 + 完整音轨
  └─ Qwen 在线 ASR：285 秒音频分片
```

- 视频总结默认模型为 `qwen3.5-omni-plus`，默认请求超时 300 秒，SDK 最多重试 2 次。
- 总结使用流式响应但只生成文本 JSON，`enable_thinking=false`。
- 结构包含标题、概览、要点、章节、声音分析和最多 24 条可核验证据；要点最多 24 条，声音变化最多 16 条。
- 首次总结不会等待 ASR，也不会把这一次并行生成的字幕再喂回总结。总结依据是完整视频内嵌音轨，或关键帧 + 完整独立音轨。
- 两个任务通过 `Promise.allSettled` 等待：字幕失败会保存为 `unavailable`，不会让已经成功的总结失败；总结失败则本次分析失败。
- 两个分支都结束后才释放共享 media job，避免 ASR 仍在读取音频时临时文件被删。

### 3.7 保存结果

总结成功后创建 SQLite 对话，保存：

- 视频来源元数据（包括本地文件路径、BVID、抖音分享链接或 HTTPS URL）。
- 完整总结 JSON 和当前 Qwen 模型名。
- 初始助手消息。
- 字幕 `ready` 或 `unavailable` 状态、全文、时间 cue、语言和错误说明。
- 后续消息、深度思考内容/耗时、网页来源和 token 用量。

不再计算或保存任何模型费用，只保存 token 统计。

## 4. 后续问答链路

### 4.1 输入资料

Renderer 发起问答时最多提交最近 10 条消息。若有 `conversationId`，主进程以 SQLite 中的来源、总结、完整消息和字幕为准；没有 ID 时才使用请求中附带的来源和总结。

回答默认由 DeepSeek 完成，当前代码默认配置为：

- 快速模型：`deepseek-v4-flash`
- 深度模型：`deepseek-v4-pro`
- Base URL：`https://api.deepseek.com`
- 默认请求超时：300 秒
- 最终回答流式输出，最大 2048 tokens。
- 开启“深度思考”时使用 pro 模型并传入 `reasoning_effort=high`；否则使用 flash 模型。

### 4.2 证据充分性判断

每次回答前先用 flash 模型执行一次 JSON 判断：`answer / recall / web / unable`，最多 800 tokens。判断可见资料为：

- 精简视频记忆：来源、标题、概览和声音概览。
- 完整总结时间线。
- 最近 10 条消息，即通常约 5 轮用户/助手对话。

强制规则优先于模型判断：

- 用户明确要求看字幕、核对原话、完整回顾或较早历史时，强制进入 `recall`。
- 用户明确要求联网，或问题依赖当前天气、新闻、实时价格、最新版本、现行规则、官方公告等时，强制进入 `web`。
- 所需开关未开启时不会假装资料充分，而是生成明确的无法完成说明，再由最终回答模型解释。

### 4.3 完整回顾（recall）

完整回顾不重新分析视频文件，而是从 SQLite 中的“冷资料”检索：完整总结、完整 ASR 字幕、较早对话。

1. flash 模型先规划需要 `summary / transcript / history` 中的哪些来源，规划最多 700 tokens；明确时间问题默认围绕该时间前后约 45 秒。
2. 字幕候选按最多 45 秒或 700 字分组，相邻组保留一个 cue 重叠；没有时间 cue 的纯文本最多取 24000 字。
3. 历史候选只取最近 10 条消息之前的较早消息，因为最近消息已在热上下文中。
4. 关键词预选上限：
   - 普通回顾：总结 7、字幕 12、历史 8。
   - 完整复盘：总结 20、字幕 16、历史 8。
   - 跨来源合并后最多 36 个候选；无明确时间时还会补少量均匀字幕样本，避免只命中局部高频词。
5. flash 模型重排候选：普通回顾最多 7 条，完整复盘最多 12 条，单候选送入重排器最多 1400 字，重排响应最多 900 tokens。
6. 对命中的字幕块补前后邻块，最终证据普通回顾最多 9 条、完整复盘最多 14 条；每条交给回答模型最多 4000 字。
7. 回顾后再执行一次充分性判断；此阶段不能再次返回 `recall`，只能回答、联网或说明资料仍不足。

### 4.4 联网搜索（web）

联网只依赖 DeepSeek Key，并由最终回答请求中的 Responses API 内置 `web_search` 完成：

1. 联网开关关闭时不向模型提供搜索工具；开启时提供 `web_search`，普通问题使用 `tool_choice=auto`。
2. 用户明确要求联网，或充分性判断认为问题依赖最新、官方或外部资料时，使用 `tool_choice={type: "web_search"}` 强制至少执行一次搜索。
3. 搜索、打开网页和页内查找均由 DeepSeek 服务端自动完成，最多自动继续 10 轮；应用不再生成搜索词，也不调用第三方搜索 API。
4. Responses 流中的 `web_search_call` 用于显示搜索阶段和统计调用次数；最终输出中的 URL citation 与搜索动作来源用于生成“网页证据”列表。
5. SQLite 只保存回答附带的来源标题、URL 和搜索状态，不保存网页正文；后续指代旧来源时把最近的来源索引重新提供给 DeepSeek，正文仍由内置搜索按需重新打开。
6. 已删除 SerpAPI、智谱搜索、Qwen Rerank、本机 Trafilatura/pypdf 提取、Cloudflare Browser Rendering 和网页正文缓存链路。

### 4.5 流式事件、停止和重发

- 主进程通过 IPC 推送 `assess / recall / reassess / search / answer` 阶段事件，以及 `reasoning_delta`、`answer_delta`。
- 点击停止会 Abort 当前请求；已产生的内容以“已停止”状态保存。
- 重发某条问题会先从 SQLite 删除该问题及之后的消息，再用此前消息重新提问，防止旧分支残留。
- 回答成功后，用户问题和助手回答以一个批次追加到 SQLite；模型成功但保存失败时仍保留当前页面结果并显示保存错误。

## 5. 本地数据与恢复

Electron 使用 `app.getPath("userData")` 作为数据根目录。Windows 正式安装版通常是：

```text
%APPDATA%\FrameNote\
  framenote.sqlite3       # 对话、字幕、设置、token 统计和来源 URL
  framenote.sqlite3-wal   # SQLite WAL（运行时可能存在）
  framenote.sqlite3-shm   # SQLite 共享内存（运行时可能存在）
  credentials.json       # Windows safeStorage 加密后的 API Key
  media-core\            # media core 临时任务与分析素材
```

- SQLite 开启外键、WAL，锁等待为 5000 ms。
- API Key 不写入 SQLite，也不把明文返回 Renderer；`credentials.json` 只存 Windows `safeStorage` 加密后的 Base64 密文。
- 只支持 DashScope 和 DeepSeek 两类 Key。主进程解密后只注入自身进程环境。
- 对话删除使用外键级联清除消息、消息详情和字幕。
- media core 的分析产物默认 TTL 为 1 小时，签名 URL 默认 10 分钟；正常分析结束会主动删除任务，异常遗留由定时清理回收。

## 6. IPC 与本机媒体路由

### 6.1 Renderer 可用 IPC

| 分组 | 能力 |
| --- | --- |
| Runtime | 获取版本/平台、打开受校验的外部链接、通过主进程写入系统剪贴板 |
| Media | 获取本次 sidecar 的 loopback 地址和访问令牌 |
| Video files | 打开/释放本地视频、下载本地/B站/抖音/HTTPS 视频、取消下载 |
| Model | Qwen 总结、DeepSeek 问答、取消请求、订阅流式事件 |
| Transcription | Qwen 在线字幕提取与取消 |
| Conversations | 列表、创建、读取、重命名、更新字幕、删除、追加/截断消息 |
| Settings | 读取和保存界面、字体及直接总结阈值 |
| Credentials | 查询 Key 是否已配置、更新加密 Key |

精确通道名以 `src/shared/ipc-contract.ts` 的 `DESKTOP_CHANNELS` 为唯一来源。

### 6.2 media core HTTP API

| 方法与路径 | 作用 |
| --- | --- |
| `GET /health` | 依赖、版本和队列健康状态 |
| `POST /v1/media/jobs` | 上传本地/HTTPS 文件并创建分析任务 |
| `POST /v1/bilibili/preview` | 解析 B站播放器预览 |
| `GET /v1/bilibili/preview/{session}/video` | 代理 B站视频流，支持 Range |
| `GET /v1/bilibili/preview/{session}/audio` | 代理 B站独立音频流 |
| `POST /v1/bilibili/jobs` | 创建 B站下载与分析任务 |
| `POST /v1/douyin/preview` | 解析抖音公开分享链接并创建短期预览会话 |
| `GET /v1/douyin/preview/{session}/video` | 代理带画面和声音的抖音视频流，支持 Range |
| `GET /v1/media/jobs/{id}` | 查询普通媒体任务 |
| `GET /v1/bilibili/jobs/{id}` | 查询 B站任务 |
| `DELETE /v1/media/jobs/{id}` | 取消/释放普通媒体任务 |
| `DELETE /v1/bilibili/jobs/{id}` | 取消/释放 B站任务 |
| `GET /v1/{kind}/jobs/{id}/artifact` | 用限时签名读取完整分析 MP4 |
| `GET /v1/{kind}/jobs/{id}/analysis/{asset}` | 用限时签名读取关键帧或音频分片 |

桌面 sidecar 默认从 8788 端口开始寻找可用 loopback 端口；启动等待 45 秒，每 5 秒健康检查一次，异常最多自动重启 3 次。队列默认 2 个并行 worker、最多 20 个排队任务。

## 7. 维护时应同步检查的位置

参数或链路改变时，至少同步检查以下文件并更新本文：

- 阶段、并行关系、历史恢复：`src/renderer/src/components/VideoWorkbench.tsx`
- 直接总结阈值：`src/shared/preference-types.ts`
- 媒体限制和 B站下载：`media_service/worker.py`
- 关键帧和音频切片：`media_service/analysis_pipeline.py`
- B站完整解析重试：`media_service/bilibili_retry.py`
- Qwen 总结：`src/main/model/qwen-video-engine.ts`
- Qwen ASR：`src/main/model/qwen-asr-service.ts`
- 问答路由：`src/main/services/model-service.ts`
- 充分性判断：`src/main/model/answer-readiness.ts`
- 回顾参数：`src/main/model/video-recall.ts`
- DeepSeek 回答与联网：`src/main/model/deepseek-conversation-engine.ts`
- SQLite 字段与上限：`src/main/database/conversation-repository.ts`
- IPC 表面：`src/shared/ipc-contract.ts` 与 `src/main/ipc/register.ts`
