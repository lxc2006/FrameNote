# FrameNote Windows 桌面迁移

> 状态：四阶段完成；2026-09-04 已完成桌面独占化并删除网页版本。

## 阶段结果

1. 建立 Electron main、preload、React/Vite Renderer，保留原工作台体验。
2. 模型和对话业务迁入主进程，桌面 IPC 与本地 SQLite 可用。
3. 媒体核心和字幕依赖拆分，Electron 接管 sidecar 生命周期；核心 onedir 不含 FunASR/PyTorch/字幕模型。
4. 可选字幕扩展、NSIS 安装包、自动更新和交付流程接入。
5. 最终桌面独占化：UI 和共享类型迁入 `src/`，SQLite 改为 Repository，移除网页 Route、D1、Worker、Sites、Drizzle 及所有 `/api` 回退。

## 当前命令

```powershell
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:pack
pnpm desktop:dist
pnpm media:core:build
pnpm subtitles:build
```

`pnpm dev`、`pnpm build` 和 `pnpm start` 现在也是 Electron 桌面命令，不再启动网站。

## 交付边界

- 基础安装包只携带核心媒体 onedir。
- 字幕扩展独立下载和卸载。
- 最终用户无需安装 Node.js、Python 或 FFmpeg。
- 用户数据默认不随应用卸载删除。
- 仓库不再提供浏览器访问地址或网页部署流程。
