# 帧记 FrameNote

FrameNote 是 Windows 桌面视频总结与连续问答工具。它支持本地视频、HTTPS 视频直链，以及无需登录即可访问的 B站、抖音公开视频，并使用 Qwen 生成结构化总结、使用 DeepSeek 继续对话。

本仓库已经完成桌面独占化：不再包含 Next.js/Vinext 网页入口、HTTP API Route、Cloudflare Worker、Sites 托管配置、D1 或 Drizzle。Electron Renderer 通过受限 IPC 调用主进程；媒体大文件直接发送到 Electron 管理的本机 Python sidecar。

## 功能边界

- Electron + React/Vite + TypeScript 桌面界面。
- 本地 SQLite 保存对话、总结、字幕、显示设置和本地视频绝对路径，不复制原始视频；再次进入对话时自动按路径恢复，文件移动或删除后提示找不到。
- API Key 由 Electron 主进程使用 Windows `safeStorage` 加密保存，Renderer 只能读取配置状态。
- `framenote-media-core.exe` 负责 B站/抖音公开链接解析与预览，以及下载、转码、关键帧和音轨。
- DeepSeek Responses API 负责后续问答与服务端内置联网搜索，不再依赖第三方搜索 Key、本机正文提取或网页正文缓存。
- `qwen-audio-3.0-asr-flash` 通过 Electron 主进程进行在线字幕识别；媒体核心只准备受限长度的音频分片。
- 媒体准备完成后，在线字幕识别与 Qwen 视频总结并行执行；分叉进度分别显示两路状态，成功的分支变绿，等待两路结束后保存。
- 播放器支持全屏（Esc 退出）；下载按钮在仅预览时位于右侧标题最右边，已有总结时位于“在线识别字幕”右侧。B站下载最高可用、上限 1080p 的预览轨并合并音轨；抖音下载公开分享视频的带音轨 MP4；本地视频另存原文件，HTTPS 直链直接下载。
- electron-builder 生成 NSIS 安装包，electron-updater 使用 GitHub Releases 元数据检查应用更新。

## 源码结构

```text
src/
├─ main/
│  ├─ index.ts                 Electron 生命周期与组件装配
│  ├─ window.ts                BrowserWindow 与导航安全策略
│  ├─ ipc/register.ts          类型化 IPC 注册与错误边界
│  ├─ database/                SQLite、对话 Repository、设置 Repository
│  ├─ services/                对话、模型与联网检索业务编排
│  ├─ model/                   Qwen、DeepSeek、召回与请求校验
│  ├─ media/                   sidecar 生命周期、本地视频协议与下载保存
│  ├─ security/                Windows 加密凭据存储
│  └─ updates/                 应用自动更新
├─ preload/index.ts            contextBridge 最小权限桥接
├─ renderer/                   React 桌面界面、客户端与样式
└─ shared/                     IPC 契约和跨进程纯类型

media_service/                 Python 媒体核心（无离线字幕模型）
scripts/                       媒体构建、IPC 烟测与交付检查
build/installer.nsh            NSIS 安装/升级/卸载规则
electron.vite.config.ts        Electron 三层构建
electron-builder.yml           Windows 安装包配置
```

## 开发环境

需要 Node.js 22.13+、pnpm、Python 3.11+。只有重新构建 Python sidecar 时才需要本机 Python；安装后的最终用户不需要安装 Python 或 FFmpeg。

```powershell
cd C:\Users\Steven\Desktop\VSCodeFiles\VideoConclusion
pnpm install
pnpm desktop:dev
```

如果尚未构建媒体核心，开发模式会回退到项目 `.venv` 中的 `media_service/app.py`。正式安装包不会回退到 Python 源码。

开发者可在 `.env.local` 中临时配置模型 Key。普通用户只需在软件右上角“设置 → 模型 API Key”中填写自己的 DashScope 和 DeepSeek Key；保存后立即供主进程使用。

## 构建

```powershell
pnpm media:core:build
pnpm desktop:build
pnpm desktop:dist
```

基础安装包位于 `release/FrameNote-Setup-<version>-x64.exe`。

## 数据位置

- SQLite：`%APPDATA%\framenote-video-ai\framenote.sqlite3`
- 加密凭据：Electron `userData` 下的 `credentials.json`
- 媒体临时状态：Electron `userData\media-sidecar`

卸载应用默认保留 SQLite 与加密凭据；视频分析产生的临时媒体由媒体核心按 TTL 清理。

旧历史记录没有本地视频路径时无法推断原文件位置；新创建的本地视频对话会保存路径。路径只用于本机恢复，不发送给模型；字幕供后续对话回顾，首次总结直接理解视频/关键帧与音轨，不再等待 ASR 文本。

更多边界见 [架构文档](docs/architecture.md) 和 [迁移记录](docs/desktop-migration.md)。
