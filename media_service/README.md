# FrameNote B 站媒体服务

这是 FrameNote 的独立媒体获取服务。它只接收严格的 12 位 BVID，在服务器端使用 `yt-dlp` 获取 B 站公开视频最高 720p 的 H.264 视频流与 AAC 音频流，再由 FFmpeg 合并、`ffprobe` 复核，最终返回短时有效的签名下载 URL。

服务不会接收任意 URL，不读取 Cookie，不登录 B 站，也不尝试访问会员、私有、付费或地区受限内容。请只处理你拥有或已获授权使用的公开视频。

## 固定限制

- 单视频、禁止播放列表；
- 最高 720p；
- 最终媒体固定为 MP4 容器、H.264 视频与 AAC 音频；
- 最长 60 分钟；
- 最终文件及下载过程默认最大 150 MB；
- 2 个并行下载 worker；
- 最多 20 个等待中的任务；
- 默认任务超时 20 分钟（网页总等待上限为 22 分钟）；
- 下载文件默认保留 1 小时；
- 签名下载 URL 默认有效 10 分钟。

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
| `FRAMENOTE_MEDIA_MAX_BYTES` | `157286400`（150 MB） | 媒体服务上限，可在 1–300 MB 范围覆盖；FrameNote 网页仍会拒绝超过 150 MB 的下载结果 |
| `FRAMENOTE_MEDIA_JOB_TIMEOUT_SECONDS` | `1200` | 单任务执行超时，范围 60–7200 秒；网页额外预留排队与传输时间 |
| `FRAMENOTE_MEDIA_ARTIFACT_TTL_SECONDS` | `3600` | 成品保留时间，范围 60–86400 秒 |
| `FRAMENOTE_MEDIA_SIGNED_URL_TTL_SECONDS` | `600` | 单个签名 URL 有效期，范围 30–3600 秒 |
| `FRAMENOTE_MEDIA_TERMINAL_RETENTION_SECONDS` | `3600` | 失败、取消及过期记录的保留时间 |
| `FRAMENOTE_MEDIA_CLEANUP_INTERVAL_SECONDS` | `60` | 过期目录扫描间隔 |

如果 Qwen 需要直接读取 `downloadUrl`，`FRAMENOTE_MEDIA_PUBLIC_BASE_URL` 必须是 Qwen 服务能够访问的公网 HTTPS 地址；`127.0.0.1` 只适合本机接口联调。

默认 CORS 只放行两种常见的本地前端 Origin。生产部署时应把 `FRAMENOTE_MEDIA_CORS_ORIGINS` 覆盖为 FrameNote 网站的准确 HTTPS Origin；如果始终由网站服务端调用媒体服务，也可以把它设置为空字符串来关闭 CORS 中间件。

## API

设置 Token 后，除 `/health` 和已签名的媒体下载路由外，请求都要携带：

```http
Authorization: Bearer <FRAMENOTE_MEDIA_API_TOKEN>
```

### 创建任务

```http
POST /v1/bilibili/jobs
Content-Type: application/json

{"bvid":"BV1xx411c7mD"}
```

成功返回 `202 Accepted`，并附带 `Location` 响应头：

```json
{
  "jobId": "5541368e-cc92-43e8-90f9-9be1d2ab4d75",
  "status": "queued",
  "phase": "queued",
  "progress": 0,
  "source": {"bvid": "BV1xx411c7mD"}
}
```

请求体只允许 `bvid` 字段。完整 URL、短链、AV 号、首尾空格及额外字段都会返回 `422`。

### 查询任务

```http
GET /v1/bilibili/jobs/{jobId}
GET /v1/bilibili/jobs?limit=50
```

状态为 `queued | running | succeeded | failed | cancelled | expired`，阶段为 `queued | resolving | downloading | merging | ready`。失败任务会携带结构化 `error`；成功后响应包含：

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
    "downloadUrl": "https://media.example.com/v1/bilibili/jobs/.../artifact?expires=...&signature=...",
    "filename": "示例视频 [BV1xx411c7mD].mp4",
    "mimeType": "video/mp4",
    "sizeBytes": 12345678,
    "sha256": "<64-character-lowercase-hex>",
    "expiresAt": "2026-07-18T12:00:00Z"
  }
}
```

每次查询成功任务都会生成一个新的短时签名 URL；`expiresAt` 对应该 URL 的过期时间。文件保留期结束后任务转为 `expired` 并自动清理。

### 取消或删除结果

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

1. API 对 BVID、鉴权和队列容量做入口校验，只拼接固定的 `https://www.bilibili.com/video/{BVID}`，因此用户不能利用该服务请求任意站点。
2. 两个异步消费者各自以参数数组（不经过 shell）和 `-I -u -X utf8=1` 启动隔离的 `worker.py` 子进程。worker 使用 UTF-8 JSON Lines 输出进度与错误，主进程负责状态机、超时和取消。
3. worker 先用 `yt-dlp` 只解析元数据，拒绝直播、未知时长、超过 60 分钟或预计超过配置大小上限的内容；格式选择器的每个 fallback 都硬性要求不高于 720p 的 AVC/H.264 视频与 AAC 音频，不会回退到 AV1、HEVC 或 Opus。
4. B 站通常使用 DASH，把画面与声音作为两个流返回。`yt-dlp` 下载后调用 FFmpeg 合并/重封装为 MP4，过程中持续检查累计字节数；重封装不负责把不兼容编码转码为 H.264/AAC。
5. 下载结束后用 `ffprobe` 再次核对实际时长、文件大小、MP4 容器以及全部音视频轨的 H.264/AAC 白名单，并计算 SHA-256。校验失败的文件不会进入成功状态。
6. API 使用 HMAC-SHA256 为 `jobId + 过期时间` 签名。媒体路由验证签名、有效期和规范化路径后才发送文件，后台清理器按 TTL 删除临时内容。

常见失败会映射为结构化的 `error: {code, message, retryable}`，例如 `VIDEO_TOO_LONG`、`VIDEO_TOO_LARGE`、`UNSUPPORTED_VIDEO_CODEC`、`UNSUPPORTED_AUDIO_CODEC`、`ACCESS_RESTRICTED`、`TIMEOUT` 和 `DOWNLOAD_FAILED`。

## 测试

测试不联网，也不下载视频：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s media_service/tests -v
.\.venv\Scripts\python.exe -m compileall -q media_service
```

单元测试覆盖严格 BVID、HMAC 防篡改、loopback 鉴权基础逻辑、路径逃逸防护、精确 CORS、队列上限/取消释放、时长与体积校验、yt-dlp 的 H.264/AAC 选择语义，以及 ffprobe 对 AV1、HEVC、Opus、缺失音轨和非 MP4 产物的拒绝。真实 B 站端到端测试需要安装 requirements 和 FFmpeg，并使用你有权处理的公开视频单独执行。
