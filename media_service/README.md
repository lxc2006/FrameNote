# FrameNote 本地媒体 sidecar

该目录提供 Windows 桌面应用使用的本机媒体服务。所有分析任务会先生成最长边不超过 854px 的 H.264/AAC 素材，再按视频时长选择直接视频或最多 64 张关键帧加独立音轨。

## 两个交付边界

- `framenote-media-core`：B 站预览和下载、本地/HTTPS 上传、探测、转码、关键帧、音轨、签名资源和联网正文提取。
- `framenote-subtitles`：FunASR Nano、CT-Punc、VAD、PyTorch 与字幕模型，独立安装、更新和卸载。

基础核心不包含 FunASR、PyTorch、Transformers、ModelScope、Hugging Face 或字幕模型。字幕扩展不存在时 `/health` 仍返回可用，`capabilities.transcription=false`，其余媒体和 Qwen 总结链路不受影响。

## 本机源码运行

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r media_service\requirements-core.txt
.\.venv\Scripts\python.exe media_service\app.py
```

需要开发字幕后端时再安装：

```powershell
.\.venv\Scripts\python.exe -m pip install -r media_service\requirements-transcription.txt
```

Electron 开发模式会自动启动 sidecar、选择可用 loopback 端口、设置随机 Bearer Token 和签名密钥，并在退出时回收进程树，通常无需手动执行上述命令。

## 冻结构建

```powershell
pnpm media:core:build
pnpm subtitles:build
```

核心输出：

```text
media_service/dist/framenote-media-core/framenote-media-core.exe
```

字幕输出：

```text
media_service/dist/framenote-subtitles/framenote-subtitles.exe
release/FrameNote-Subtitles-<version>-win-x64.zip
```

两者均为 PyInstaller onedir，分发时不能只复制 exe。构建脚本会检查核心产物没有字幕依赖或模型文件。

## 固定限制

- 单个分析源最大 500 MB，最长 60 分钟；
- 最终分析媒体为 MP4/H.264/AAC；
- 最多 2 个下载 worker、20 个排队任务；
- 默认任务超时 20 分钟，产物保留 1 小时；
- B 站只支持无需登录即可访问且用户有权处理的公开 UGC；
- 不读取 Cookie，不处理会员、付费、私有、直播或地区受限内容；
- 网页正文提取只允许公开 HTTP(S) 地址和 80/443 端口，并逐次校验重定向和 DNS 结果。

## 主要接口

```text
GET    /health
POST   /v1/media/jobs
GET    /v1/media/jobs/{jobId}
POST   /v1/media/jobs/{jobId}/transcript
DELETE /v1/media/jobs/{jobId}
POST   /v1/bilibili/preview
POST   /v1/bilibili/jobs
GET    /v1/bilibili/jobs/{jobId}
POST   /v1/bilibili/jobs/{jobId}/transcript
DELETE /v1/bilibili/jobs/{jobId}
POST   /v1/web/extract
```

除 `/health` 和已签名资源外，Electron 启动的服务要求：

```http
Authorization: Bearer <session token>
```

Renderer 通过 IPC 获取当前连接信息后直接流式访问这些 `/v1` 接口；不再存在网页 API 代理。

## 常用环境变量

| 变量 | 说明 |
| --- | --- |
| `FRAMENOTE_MEDIA_PORT` | Electron 自动选择并覆盖的监听端口 |
| `FRAMENOTE_MEDIA_API_TOKEN` | 本机会话 Bearer Token |
| `FRAMENOTE_MEDIA_SIGNING_SECRET` | 临时资源 HMAC 签名密钥 |
| `FRAMENOTE_MEDIA_PUBLIC_BASE_URL` | Electron 设置的 loopback 地址 |
| `FRAMENOTE_MEDIA_CORS_ORIGINS` | 精确允许的 Renderer Origin |
| `FRAMENOTE_MEDIA_STATE_DIR` | 任务和临时媒体目录 |
| `FRAMENOTE_MEDIA_PROXY` | 可选 yt-dlp 代理 |
| `FRAMENOTE_TRANSCRIPTION_EXECUTABLE` | 可选字幕扩展进程路径 |
| `FRAMENOTE_WEB_FETCH_TIMEOUT_SECONDS` | 联网正文提取超时 |

更完整的进程边界见 `docs/architecture.md`。
