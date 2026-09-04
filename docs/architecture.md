# FrameNote 桌面架构

## 进程边界

```text
React Renderer
  ├─ contextBridge / 类型化 IPC ──> Electron Main
  │                                  ├─ 模型 Service ──> Qwen / DeepSeek / SerpAPI
  │                                  ├─ SQLite Repository
  │                                  ├─ Windows safeStorage
  │                                  └─ 更新与字幕扩展管理
  └─ loopback HTTP + Bearer Token ─> framenote-media-core.exe
                                         └─ 受控 worker / 可选字幕进程
```

Renderer 没有 Node.js、数据库、文件系统、通用 `ipcRenderer` 或 API Key 权限。preload 只公开 `src/shared/ipc-contract.ts` 定义的能力。模型请求和小型结构化数据走 IPC；视频上传、Range 播放和媒体产物读取直接走本机 sidecar，避免大文件结构化克隆。

## SQLite

`DesktopDatabase` 是唯一 SQLite 连接，启用 foreign keys、WAL 和 busy timeout。`ConversationRepository` 负责 schema、事务与对话数据，`SettingsRepository` 负责普通偏好。Repository 直接依赖本地 SQL 契约，不存在 D1 binding、HTTP Request 或网页身份头。

## 凭据

设置页只能提交新 Key、清除 Key 或读取“是否已配置”。`CredentialStore` 使用 Electron `safeStorage` 加密后写入用户数据目录，并把解密值只注入主进程环境。开发机器仍可使用未纳入安装包的 `.env.local` 作为回退。

## 媒体和字幕

核心 sidecar 是 PyInstaller onedir 产物，包含媒体处理依赖和 FFmpeg，但排除字幕栈。Electron 选择可用 loopback 端口并生成会话 Token；退出时回收进程树。

字幕扩展是另一个冻结进程和独立 ZIP。主进程负责下载、SHA-256 校验、解压、版本切换与卸载，然后重启核心 sidecar 使能力生效。

## 打包

`electron-vite` 分别构建 main、preload 和 renderer；`electron-builder` 把 `out/` 和完整核心 onedir 放入 NSIS 安装包。应用自动更新读取 GitHub Release 元数据，字幕扩展沿用自己的清单和版本生命周期。
