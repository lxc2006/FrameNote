# FrameNote 媒体服务

这是 FrameNote 的独立媒体服务，统一处理本地上传、HTTPS 视频直链分析和 B 站公开 UGC。所有 `analysis` 任务都会先生成最长边不超过 854px 的 H.264/AAC 素材，再按视频时长选择“直接视频”或“最多 64 张关键帧 + 独立音轨”。Qwen 完成后，网页可以按设置异步启动 FunASR；Nano 自动识别或按单一语言约束识别中、日、英文，CT-Punc 为中英文重新恢复整段标点，最终只按句号、问号和感叹号合并为整句字幕。

B 站 `preview` 任务准备默认最高兼容画质，网页通过 HTTP Range 内联播放 URL 边播放边缓存，并可使用附件 URL 手动下载。B 站任务只接收严格的 12 位 BVID，不读取 Cookie，不登录 B 站，也不尝试访问会员、私有、付费或地区受限内容。HTTPS 视频直链仍由网页下载后作为文件上传，本服务不会为视频分析直接抓取该地址。联网搜索另有一个仅供网站服务端调用、需要同一 Token 的正文提取接口。

## 固定限制

- 单视频、禁止播放列表；本地与 HTTPS 分析上传最大 500 MB；
- 手动下载选择默认最高兼容画质，默认最大 1 GB；
- 分析素材最长边不超过 854px（约 480p），最大 500 MB；
- 最终媒体固定为 MP4 容器、H.264 视频与 AAC 音频；
- 最长 60 分钟；
- 2 个并行下载 worker；
- 最多 20 个等待中的任务；
- 默认任务超时 20 分钟（网页总等待上限为 22 分钟）；
- 下载文件默认保留 1 小时；
- `preview` 播放/下载 URL 默认随文件保留 1 小时，`analysis` 签名 URL 默认有效 10 分钟。
- 关键帧固定锚点间隔为 `max(1 秒, 视频时长 / 50)`；每个锚点及 AdaptiveDetector 场景点前后取 5 个候选，按清晰度、曝光、对比度、信息熵与独特性评分，并用 pHash 去重。
- 网页正文抓取只允许公开 HTTP(S) 地址和 80/443 端口，逐次校验重定向与 DNS 结果；HTML 最大 5 MB，PDF 最大 20 MB。

这些安全上限固定在服务端，不能由请求覆盖。

## 本机启动

需要 Python 3.11+，并确保原生 `ffmpeg` 和 `ffprobe` 都能从 `PATH` 找到：

```powershell
ffmpeg -version
ffprobe -version
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r media_service\requirements.txt
.\.venv\Scripts\python.exe media_service\app.py
```

依赖安装会包含 PyTorch、PySceneDetect、OpenCV、ImageHash 与 FunASR，体积明显大于基础下载服务。FunASR 第一次识别时还会从 ModelScope 下载模型并写入用户缓存；之后会复用缓存。

默认未设置 API Token 时，服务只接受 loopback 请求，并拒绝带 `Forwarded`、`X-Forwarded-For` 或 `X-Real-IP` 的请求。因此本机开发可以直接访问 `http://127.0.0.1:8788`，不能以无 Token 模式对公网开放。

Docker 镜像默认关闭无 Token 模式；未设置 `FRAMENOTE_MEDIA_API_TOKEN` 时会拒绝启动。只应在直接回环开发时保留 `FRAMENOTE_MEDIA_ALLOW_TOKENLESS_LOOPBACK=1`。

FrameNote 网站服务端配置：

```dotenv
BILIBILI_MEDIA_SERVICE_URL=http://127.0.0.1:8788
# 仅当媒体服务配置了 Token 时填写，值必须相同
BILIBILI_MEDIA_SERVICE_TOKEN=
```

## Docker

镜像内已安装 FFmpeg：

```powershell
docker build -t framenote-media ./media_service
docker run --rm -p 8788:8788 `
  -e FRAMENOTE_MEDIA_API_TOKEN=replace-with-a-long-random-token `
  -e FRAMENOTE_MEDIA_SIGNING_SECRET=replace-with-another-long-random-secret `
  -e FRAMENOTE_MEDIA_PUBLIC_BASE_URL=https://media.example.com `
  -v framenote-media-data:/data `
  framenote-media
```

容器对外监听，因此必须设置 Token。生产环境还应放在 HTTPS 反向代理之后、挂载持久化 `/data`，并使用单实例部署；当前队列和运行中的进程状态属于单个服务实例，不支持多副本共享同一个数据目录。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FRAMENOTE_MEDIA_API_TOKEN` | 空 | 设置后，作业 API 必须使用同值的 Bearer Token |
| `FRAMENOTE_MEDIA_ALLOW_TOKENLESS_LOOPBACK` | `true`（Docker 为 `false`） | 仅供直接本机开发；公网或反向代理部署必须关闭并配置 Token |
| `FRAMENOTE_MEDIA_SIGNING_SECRET` | 启动时随机生成 | HMAC 下载签名密钥；生产环境必须固定配置，建议至少 32 个随机字节 |
| `FRAMENOTE_MEDIA_PUBLIC_BASE_URL` | 当前请求 Origin | 返回下载链接使用的公网 HTTPS Origin |
| `FRAMENOTE_MEDIA_CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | 精确 Origin 的逗号分隔列表；不允许 `*`，生产环境应显式覆盖 |
| `FRAMENOTE_MEDIA_STATE_DIR` | `media_service/data` | 任务元数据及临时视频目录；容器默认 `/data` |
| `FRAMENOTE_MEDIA_MAX_BYTES` | `524288000`（500 MB） | AI 分析素材上限，可在 1–500 MB 范围覆盖 |
| `FRAMENOTE_MEDIA_DOWNLOAD_MAX_BYTES` | `1073741824`（1 GB） | 媒体服务的 preview 临时成品安全上限，可在 1 MB–2 GB 范围覆盖；网页不再设置整文件下载上限 |
| `FRAMENOTE_MEDIA_JOB_TIMEOUT_SECONDS` | `1200` | 单任务执行超时，范围 60–7200 秒；网页额外预留排队与传输时间 |
| `FRAMENOTE_MEDIA_ARTIFACT_TTL_SECONDS` | `3600` | 成品保留时间，范围 60–86400 秒 |
| `FRAMENOTE_MEDIA_SIGNED_URL_TTL_SECONDS` | `600` | AI 分析签名 URL 有效期，范围 30–3600 秒；预览 URL 跟随成品保留期 |
| `FRAMENOTE_MEDIA_TERMINAL_RETENTION_SECONDS` | `3600` | 失败、取消及过期记录的保留时间 |
| `FRAMENOTE_MEDIA_CLEANUP_INTERVAL_SECONDS` | `60` | 过期目录扫描间隔 |
| `FRAMENOTE_MEDIA_PROXY` | 空 | 可选的 yt-dlp HTTP/HTTPS/SOCKS 代理，例如 `http://127.0.0.1:7890`；不自动继承系统代理 |
| `FRAMENOTE_FUNASR_MODEL` | `FunAudioLLM/Fun-ASR-Nano-2512` | FunASR 主识别模型名称或本地模型目录 |
| `FRAMENOTE_FUNASR_HUB` | `ms` | 模型来源；中国大陆默认使用 ModelScope，也可设为 `hf` |
| `FRAMENOTE_FUNASR_VAD_MODEL` | `fsmn-vad` | 长音频语音活动检测模型 |
| `FRAMENOTE_FUNASR_PUNC_MODEL` | `ct-punc` | Nano 识别完成后的独立标点恢复模型；设置为空可回退到 Nano 原生标点 |
| `FRAMENOTE_FUNASR_DEVICE` | `cpu` | 推理设备，例如 `cpu` 或 `cuda:0` |
| `FRAMENOTE_WEB_FETCH_TIMEOUT_SECONDS` | `12` | 单个搜索结果正文的连接与读取超时，范围会限制在 3–30 秒 |

`playbackUrl` 与 `downloadUrl` 由浏览器直接访问，因此 `FRAMENOTE_MEDIA_PUBLIC_BASE_URL` 必须是浏览器能够访问的 HTTPS Origin；`127.0.0.1` 只适合本机联调。

默认 CORS 只放行两种常见的本地前端 Origin。生产部署时应把 `FRAMENOTE_MEDIA_CORS_ORIGINS` 覆盖为 FrameNote 网站的准确 HTTPS Origin；如果始终由网站服务端调用媒体服务，也可以把它设置为空字符串来关闭 CORS 中间件。

## API

设置 Token 后，除 `/health` 和已签名的媒体下载路由外，请求都要携带：

```http
Authorization: Bearer <FRAMENOTE_MEDIA_API_TOKEN>
```

### 创建本地或 HTTPS 分析任务

```http
POST /v1/media/jobs
Content-Type: multipart/form-data

file=<video bytes>
sourceKind=upload | url
directSummaryMaxSeconds=360
sourceUrl=https://example.com/video.mp4   # 仅作为 HTTPS 来源元数据
```

服务以流式方式把上传内容写入单独任务目录，超过 500 MB 时立即拒绝。任务始终为 `analysis`：先用 `ffprobe` 校验时长和音视频轨，再用 FFmpeg 转码为最长边不超过 854px 的 MP4，最后按阈值生成直接视频或关键帧证据。对应控制接口为：

```http
GET /v1/media/jobs/{jobId}
POST /v1/media/jobs/{jobId}/transcript
Content-Type: application/json

{"languages":["zh","ja","en"]}
DELETE /v1/media/jobs/{jobId}
```

### 提取搜索结果正文

```http
POST /v1/web/extract
Content-Type: application/json
Authorization: Bearer <FRAMENOTE_MEDIA_API_TOKEN>

{"url":"https://example.com/article"}
```

普通 HTML 使用 Trafilatura，PDF 使用 pypdf。成功时返回 `status: "ok"` 和正文；静态响应没有正文时返回 `status: "requires_browser"`，由网站服务端决定是否调用 Cloudflare Browser Rendering；登录、反爬验证、超时和不公开地址返回 `status: "skipped"`。

### 创建 B 站任务

```http
POST /v1/bilibili/jobs
Content-Type: application/json

{"bvid":"BV1xx411c7mD","variant":"analysis","directSummaryMaxSeconds":360}
```

成功返回 `202 Accepted`，并附带 `Location` 响应头：

```json
{
  "jobId": "5541368e-cc92-43e8-90f9-9be1d2ab4d75",
  "status": "queued",
  "phase": "queued",
  "progress": 0,
  "source": {"kind": "bilibili", "bvid": "BV1xx411c7mD"}
}
```

请求体允许 `bvid`、`variant` 和 `directSummaryMaxSeconds`；`variant` 为 `preview`（手动下载最高兼容画质）或 `analysis`（AI 总结约 480p 素材），省略时默认为 `preview`。直接总结阈值只适用于 `analysis`，范围为 0–900 秒，0 表示关闭直接视频路径。

### 查询 B 站任务

```http
GET /v1/bilibili/jobs/{jobId}
GET /v1/bilibili/jobs?limit=50
```

状态为 `queued | running | succeeded | failed | cancelled | expired`，阶段为 `queued | resolving | downloading | merging | analyzing | ready`。失败任务会携带结构化 `error`；成功后响应包含视频 `artifact`；`analysis.mode` 为 `direct` 或 `keyframes`。直接路径不返回音轨或关键帧，长视频路径返回带签名 URL 的 `analysis.audio` 与 `analysis.frames`；初始 `analysis.transcript.status` 为 `pending`。

Qwen 总结完成后，网站调用以下接口启动 FunASR，并继续查询任务，直到字幕状态变为 `ready` 或 `unavailable`：

```http
POST /v1/bilibili/jobs/{jobId}/transcript
```

```json
{
  "jobId": "5541368e-cc92-43e8-90f9-9be1d2ab4d75",
  "status": "succeeded",
  "phase": "ready",
  "progress": 1,
  "source": {
    "bvid": "BV1xx411c7mD",
    "title": "示例视频",
    "durationSeconds": 93.4
  },
  "artifact": {
    "playbackUrl": "https://media.example.com/v1/bilibili/jobs/.../artifact?expires=...&signature=...&download=0",
    "downloadUrl": "https://media.example.com/v1/bilibili/jobs/.../artifact?expires=...&signature=...&download=1",
    "filename": "示例视频 [BV1xx411c7mD].mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 12345678,
    "sha256": "<64-character-lowercase-hex>",
    "expiresAt": "2026-07-18T12:00:00Z"
  }
}
```

每次查询成功任务都会生成新的签名 URL；`playbackUrl` 使用 `Content-Disposition: inline` 并支持字节范围请求，`downloadUrl` 使用 `Content-Disposition: attachment`。`expiresAt` 对应该 URL 的过期时间，文件保留期结束后任务转为 `expired` 并自动清理。

### 取消或删除 B 站结果

```http
DELETE /v1/bilibili/jobs/{jobId}
```

等待或运行中且尚未报告错误的任务会被取消，运行中的子进程会先终止后强制回收。已经报告错误或进入 `failed` 的任务会清理媒体残片，但保持 `failed` 并保留原始 `error`；已经成功的任务会删除视频文件并转为 `cancelled`。重复删除是幂等的。

### 健康检查

```http
GET /health
```

返回服务状态、队列统计以及 `yt-dlp`、FFmpeg、`ffprobe` 的可用性。健康接口不要求 Token，但不会暴露任务内容。

## 实现原理

1. API 对文件体积、来源类型、BVID、鉴权和队列容量做入口校验。B 站只拼接固定的 `https://www.bilibili.com/video/{BVID}`；HTTPS 直链则由浏览器下载后作为普通文件上传，媒体服务不会成为任意 URL 代理。
2. 两个异步消费者各自以参数数组（不经过 shell）和 `-I -u -X utf8=1` 启动隔离的 `worker.py` 子进程。worker 使用 UTF-8 JSON Lines 输出进度与错误，主进程负责状态机、超时和取消。
3. B 站 worker 先用 `yt-dlp` 只解析元数据，拒绝直播、未知时长、超过 60 分钟或预计超过对应任务大小上限的内容；`preview` 选择最高兼容画质，B 站 `analysis` 的每个 fallback 都硬性要求最长边不超过 854px。上传文件先用 `ffprobe` 校验，再由 FFmpeg 转码为同样的 H.264/AAC 低分辨率分析素材。
4. B 站通常使用 DASH，把画面与声音作为两个流返回。`yt-dlp` 下载后调用 FFmpeg 合并/重封装为 MP4，过程中持续检查累计字节数；重封装不负责把不兼容编码转码为 H.264/AAC。
5. 下载结束后用 `ffprobe` 再次核对实际时长、文件大小、MP4 容器以及全部音视频轨的 H.264/AAC 白名单，并计算 SHA-256。`analysis` 任务随后根据阈值决定：短视频立即就绪；长视频再运行 AdaptiveDetector、候选帧质量评分、pHash 去重和音轨提取。
6. Qwen 总结完成后，单独的 transcript 请求才在后台执行 FunASR，并原子更新分析清单；字幕暂不作为 Qwen 总结输入。
7. API 使用 HMAC-SHA256 为 `jobId + 过期时间` 签名。媒体与分析素材路由验证签名、有效期和规范化路径后返回文件；后台清理器按 TTL 删除临时内容。

常见失败会映射为结构化的 `error: {code, message, retryable}`，例如 `VIDEO_TOO_LONG`、`VIDEO_TOO_LARGE`、`UNSUPPORTED_VIDEO_CODEC`、`UNSUPPORTED_AUDIO_CODEC`、`ACCESS_RESTRICTED`、`TIMEOUT` 和 `DOWNLOAD_FAILED`。

## 测试

测试不联网，也不下载视频：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s media_service/tests -v
.\.venv\Scripts\python.exe -m compileall -q media_service
```

单元测试覆盖严格 BVID、通用上传任务命令、HMAC 防篡改、Range/206/Content-Range、内联与附件响应、loopback 鉴权、路径逃逸防护、精确 CORS、队列上限/取消释放、时长与体积校验、yt-dlp 的 H.264/AAC 选择语义，以及 ffprobe 对 AV1、HEVC、Opus、缺失音轨和非 MP4 产物的拒绝。真实端到端测试需要安装 requirements 和 FFmpeg，并使用你有权处理的视频单独执行。
