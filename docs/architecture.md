# FrameNote 桌面架构

## 进程边界

```text
React Renderer
  ├─ contextBridge / 类型化 IPC ──> Electron Main
  │                                  ├─ 模型 Service ──> Qwen / DeepSeek Responses
  │                                  ├─ SQLite Repository
  │                                  ├─ Windows safeStorage
  │                                  ├─ 更新与在线字幕识别
  │                                  └─ 本地视频路径 / 下载保存 / FFmpeg 合并
  └─ loopback HTTP + Bearer Token ─> framenote-media-core.exe
                                         └─ 受控媒体 worker
```

Renderer 没有 Node.js、数据库、文件系统、通用 `ipcRenderer` 或 API Key 权限。preload 只公开 `src/shared/ipc-contract.ts` 定义的能力。模型请求和小型结构化数据走 IPC；视频上传、Range 播放和媒体产物读取直接走本机 sidecar，避免大文件结构化克隆。

## SQLite

`DesktopDatabase` 是唯一 SQLite 连接，启用 foreign keys、WAL 和 busy timeout。`ConversationRepository` 负责 schema、事务与对话数据，`SettingsRepository` 负责普通偏好。Repository 直接依赖本地 SQL 契约，不存在 D1 binding、HTTP Request 或网页身份头。

## 凭据

设置页只能提交新 Key、清除 Key 或读取“是否已配置”。`CredentialStore` 使用 Electron `safeStorage` 加密后写入用户数据目录，并把解密值只注入主进程环境。开发机器仍可使用未纳入安装包的 `.env.local` 作为回退。

应用只使用 DashScope 和 DeepSeek 两类 Key。DeepSeek Responses API 同时负责连续问答、深度思考和服务端内置联网搜索；应用不再保存第三方搜索 Key，也不在本机抓取或缓存网页正文。

## 媒体和字幕

核心 sidecar 是 PyInstaller onedir 产物，包含媒体处理依赖和 FFmpeg，但排除字幕栈。Electron 选择可用 loopback 端口并生成会话 Token；退出时回收进程树。

字幕由主进程调用 Qwen Audio 在线识别。sidecar 只提取并切分低码率音轨，不接触 API Key。媒体准备后 Renderer 同时发起字幕和总结 IPC：总结使用视频/关键帧与音轨，字幕独立合并时间戳供后续对话检索，不再作为首次总结的前置依赖。两路均结束后保存并释放共享媒体任务，单路字幕失败不会丢弃总结。

本地原视频路径仅保存在 SQLite `source_json.localPath` 中，不发送给模型。preload 通过 `webUtils.getPathForFile` 获取用户所选文件路径；主进程验证路径后注册不透明的 `framenote-media://` 播放句柄，通过 Chromium 文件加载器支持 Range。恢复历史时重新验证路径，不持久化临时播放 URL，也不读取整段视频到内存用于预览。

下载走主进程保存对话框和文件流，不经 IPC 传输视频字节。B站重新解析最高可用（上限 1080p）预览轨，必要时调用核心包附带的 FFmpeg 合并音画；抖音重新解析公开分享链接并保存带音轨 MP4。两种平台都不突破登录、验证或会员权限。先写目标目录下的独立临时目录，成功后移动到用户确认的位置，取消/失败清理临时内容。全屏权限仅向应用主 frame 开放，其余权限仍默认拒绝。

B站手动预览、历史预览恢复、视频另存和总结下载最终都进入媒体核心的统一五次解析策略。每次执行完整的 yt-dlp 元数据解析，失败后按 1、2、4、8 秒退避；前四次不输出错误，第五次仍失败才返回结构化错误。视频分片/CDN 下载继续使用独立的传输重试，不与元数据解析次数混算。

抖音输入支持分享文本中的 `douyin.com` HTTPS 链接。Renderer 经带令牌的 `/v1/douyin/preview` 请求解析；原始 CDN URL 和请求头保留在 sidecar 短期会话中，只向页面返回本机代理地址。总结时代理流作为 `sourceKind=douyin` 上传到通用媒体任务，继续复用转码、关键帧、音轨和在线字幕链路。

## 打包

`electron-vite` 分别构建 main、preload 和 renderer；`electron-builder` 把 `out/` 和完整核心 onedir 放入 NSIS 安装包。应用自动更新读取 GitHub Release 元数据。
