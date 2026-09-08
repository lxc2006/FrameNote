# FrameNote Windows 桌面迁移

> 状态：四阶段完成；2026-09-04 已完成桌面独占化并删除网页版本。

## 阶段结果

1. 建立 Electron main、preload、React/Vite Renderer，保留原工作台体验。
2. 模型和对话业务迁入主进程，桌面 IPC 与本地 SQLite 可用。
3. 媒体核心和模型能力拆分，Electron 接管 sidecar 生命周期。
4. NSIS 安装包、自动更新和交付流程接入。
5. 最终桌面独占化：UI 和共享类型迁入 `src/`，SQLite 改为 Repository，移除网页 Route、D1、Worker、Sites、Drizzle 及所有 `/api` 回退。

## 当前命令

```powershell
pnpm desktop:dev
pnpm desktop:build
pnpm desktop:pack
pnpm desktop:dist
pnpm media:core:build
```

`pnpm dev`、`pnpm build` 和 `pnpm start` 现在也是 Electron 桌面命令，不再启动网站。

## 交付边界

- 基础安装包只携带核心媒体 onedir。
- 字幕通过 Qwen Audio API 在线识别，不安装本地字幕模型。
- 最终用户无需安装 Node.js、Python 或 FFmpeg。
- 用户数据默认不随应用卸载删除。
- 仓库不再提供浏览器访问地址或网页部署流程。

## 桌面视频体验（2026-09-06）

- 全屏播放、主进程下载/另存、本地原视频路径恢复已接入；旧对话无路径时显示提示，原文件移动或删除不会影响已有总结和对话。
- 在线字幕与视频总结在媒体准备后并行，两路各自变绿，均结束后保存；关闭字幕识别时只运行总结。
- 本轮改动不改变 Python 核心接口，不需要重新冻结媒体核心；重启 `pnpm desktop:dev` 或重新构建桌面端即可载入 main/preload 和 UI 更改。
- B站获取链路随后改为媒体核心统一执行最多 5 次完整解析；此项修改涉及 Python，因此需要重新冻结媒体核心。手动获取、历史恢复、另存视频使用预览入口，总结使用 worker 入口，两者共用相同次数和退避规则。
- 抖音公开视频分享链接已增加独立解析/预览入口；解析后复用通用媒体任务完成转码、总结、在线字幕和历史恢复。该能力不读取 Cookie，不支持需要登录、验证码或其他访问限制的内容。
