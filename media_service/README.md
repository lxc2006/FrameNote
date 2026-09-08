# FrameNote 本地媒体 sidecar

该目录提供 Windows 桌面应用使用的本机媒体服务。所有分析任务会先生成最长边不超过 854px 的 H.264/AAC 素材，再按视频时长选择直接视频或最多 64 张关键帧加独立音轨。

## 交付边界

- `framenote-media-core`：B站/抖音公开链接预览和下载、本地/HTTPS 上传、探测、转码、关键帧、音轨、在线识别音频分片、签名资源和联网正文提取。

sidecar 不执行语音识别，也不接收模型 API Key；Electron 主进程会读取签名音频分片并调用 Qwen Audio。

## 本机源码运行

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r media_service\requirements-core.txt
.\.venv\Scripts\python.exe media_service\app.py
```

Electron 开发模式会自动启动 sidecar、选择可用 loopback 端口、设置随机 Bearer Token 和签名密钥，并在退出时回收进程树，通常无需手动执行上述命令。

B站手动预览和总结下载共用同一套解析策略：一次操作最多完整解析 5 次，失败后按 1、2、4、8 秒退避；任意一次成功即继续，只有第 5 次仍失败才向上报告错误。

抖音只处理公开、无需登录的分享链接。解析最多尝试 5 次，预览返回带画面与声音的 MP4 代理；总结、字幕与关键帧继续走通用 `/v1/media/jobs` 链路。

## 冻结构建

```powershell
pnpm media:core:build
```

核心输出：

```text
media_service/dist/framenote-media-core/framenote-media-core.exe
```

产物为 PyInstaller onedir，分发时不能只复制 exe。

## 固定限制

- 单个分析源最大 500 MB，最长 60 分钟；
- 最终分析媒体为 MP4/H.264/AAC；
- 最多 2 个下载 worker、20 个排队任务；
- 默认任务超时 20 分钟，产物保留 1 小时；
- B 站只支持无需登录即可访问且用户有权处理的公开 UGC；
- 抖音只支持无需登录或验证即可访问且用户有权处理的公开视频；
- 不读取 Cookie，不处理会员、付费、私有、直播或地区受限内容；
- 网页正文提取只允许公开 HTTP(S) 地址和 80/443 端口，并逐次校验重定向和 DNS 结果。

## 主要接口

```text
GET    /health
POST   /v1/media/jobs
GET    /v1/media/jobs/{jobId}
DELETE /v1/media/jobs/{jobId}
POST   /v1/bilibili/preview
POST   /v1/bilibili/jobs
GET    /v1/bilibili/jobs/{jobId}
DELETE /v1/bilibili/jobs/{jobId}
POST   /v1/douyin/preview
GET    /v1/douyin/preview/{sessionId}/video
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
| `FRAMENOTE_WEB_FETCH_TIMEOUT_SECONDS` | 联网正文提取超时 |

更完整的进程边界见 `docs/architecture.md`。
