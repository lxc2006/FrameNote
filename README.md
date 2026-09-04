# 帧记 FrameNote

FrameNote 是 Windows 桌面视频总结与连续问答工具。它支持本地视频、HTTPS 视频直链和无需登录即可访问的 B 站公开视频，并使用 Qwen 生成结构化总结、使用 DeepSeek 继续对话。

本仓库已经完成桌面独占化：不再包含 Next.js/Vinext 网页入口、HTTP API Route、Cloudflare Worker、Sites 托管配置、D1 或 Drizzle。Electron Renderer 通过受限 IPC 调用主进程；媒体大文件直接发送到 Electron 管理的本机 Python sidecar。

## 功能边界

- Electron + React/Vite + TypeScript 桌面界面。
- 本地 SQLite 保存对话、总结、字幕与显示设置，不保存原始视频。
- API Key 由 Electron 主进程使用 Windows `safeStorage` 加密保存，Renderer 只能读取配置状态。
- `framenote-media-core.exe` 负责 B 站预览、下载、转码、关键帧、音轨和网页正文提取。
- FunASR Nano、CT-Punc、VAD、PyTorch 与字幕模型作为可独立安装/更新/卸载的扩展，不进入基础安装包。
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
│  ├─ media/                   sidecar 生命周期与媒体服务客户端
│  ├─ extensions/              可选字幕扩展管理
│  ├─ security/                Windows 加密凭据存储
│  └─ updates/                 应用自动更新
├─ preload/index.ts            contextBridge 最小权限桥接
├─ renderer/                   React 桌面界面、客户端与样式
└─ shared/                     IPC 契约和跨进程纯类型

media_service/                 Python 媒体核心与可选字幕后端
scripts/                       媒体构建、字幕构建、IPC 烟测与交付检查
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

开发者可在 `.env.local` 中临时配置模型 Key。普通用户应在软件右上角“设置 → 模型 API Key”中填写自己的 DashScope、DeepSeek 和可选 SerpAPI Key；保存后立即供主进程使用。

## 构建

```powershell
pnpm media:core:build
pnpm subtitles:build
pnpm desktop:build
pnpm desktop:dist
```

基础安装包位于 `release/FrameNote-Setup-<version>-x64.exe`。字幕扩展 ZIP 和清单同样位于 `release/`，但不会被放入基础安装包。

## 数据位置

- SQLite：`%APPDATA%\framenote-video-ai\framenote.sqlite3`
- 加密凭据：Electron `userData` 下的 `credentials.json`
- 媒体临时状态：Electron `userData\media-sidecar`
- 字幕扩展：`%LOCALAPPDATA%\FrameNote\extensions\framenote-subtitles`

卸载应用默认保留用户数据；字幕扩展由设置页独立卸载。

更多边界见 [架构文档](docs/architecture.md) 和 [迁移记录](docs/desktop-migration.md)。
