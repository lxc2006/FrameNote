# FrameNote 项目上下文

> 最后更新：2026-09-07

## 当前定位

FrameNote 已从网站迁移为 Windows 桌面独占应用。生产运行时由 Electron main、preload、React/Vite Renderer、本地 SQLite 和核心 Python sidecar 组成；仓库不再保留网页版本。

## 已完成

- Electron main/preload/renderer 三层和类型化 IPC。
- 模型总结、连续问答、对话历史与设置全部通过主进程能力调用。
- 对话存储改为原生 `node:sqlite` Repository，不再包含 D1 绑定或兼容适配层。
- Renderer 删除 `/api` HTTP 回退；媒体仅直连带随机 Bearer Token 的 loopback sidecar。
- 字幕统一使用 Qwen Audio 在线识别，API Key 只在 Electron 主进程中解密和使用。
- 媒体准备后并行执行在线字幕识别与视频总结，分叉进度独立显示状态；字幕失败不阻断总结保存，两路结束后释放共享媒体任务。
- 本地视频路径保存在对话 `source_json.localPath`；恢复时检查原路径，以短期不透明 `framenote-media` URL 流式播放。旧记录缺少路径或文件丢失时只提示，不要求每次重新上传。
- 播放器支持全屏；视频下载使用主进程保存对话框，本地原文件复制、HTTPS 流式下载、B站最高可用 1080p 内预览视频与音轨合并。可取消，退出清理临时下载。
- 抖音公开分享链接已接入：Renderer 提取分享文本中的 HTTPS 链接，media core 使用 yt-dlp 解析并通过受控代理预览；解析后的媒体复用通用媒体任务、Qwen 总结、在线字幕、下载和历史恢复链路。不使用浏览器 Cookie，也不绕过登录或验证。
- B站手动预览与总结下载统一为最多 5 次完整解析（1、2、4、8 秒退避）；成功立即继续，只在第 5 次仍失败时向界面报告。
- Electron 自动启动、监控、有限重启并终止媒体 sidecar。
- NSIS 安装、升级、卸载和 GitHub Releases 自动更新已经接入。
- DeepSeek 调用已统一迁移到 Responses API；联网直接使用其服务端内置 `web_search`，不再包含 SerpAPI、智谱搜索、Qwen Rerank、本机网页正文提取或正文缓存。
- 用户只需在设置页录入自己的 DashScope 和 DeepSeek Key；主进程用 Windows `safeStorage` 加密，密钥不会返回 Renderer 或写入 SQLite。
- Next.js、Vinext、Cloudflare Worker、Sites、D1、Drizzle、网页 API Route 和网页测试已删除。

## 关键入口

| 位置 | 职责 |
| --- | --- |
| `src/main/index.ts` | 应用生命周期与组件装配 |
| `src/main/window.ts` | 桌面窗口和外部链接策略 |
| `src/main/ipc/register.ts` | IPC 能力注册、取消和错误映射 |
| `src/main/database/conversation-repository.ts` | SQLite 对话 Repository 与输入校验 |
| `src/main/database/settings-repository.ts` | 本地显示设置 |
| `src/main/security/credential-store.ts` | Windows 加密 API Key 存储 |
| `src/main/media/media-sidecar.ts` | 核心 sidecar 生命周期 |
| `src/main/media/video-files.ts` | 本地路径检查、临时播放协议、流式下载与 FFmpeg 合并 |
| `src/main/model/qwen-asr-service.ts` | Qwen Audio 在线字幕识别与时间戳合并 |
| `src/renderer/src/components/VideoWorkbench.tsx` | 视频、总结、字幕和对话界面 |
| `src/renderer/src/components/AnalysisProgress.tsx` | 居中公共阶段与独立字幕/总结进度分支 |
| `src/shared/ipc-contract.ts` | 跨进程类型和频道白名单 |
| `media_service/core_entry.py` | PyInstaller 核心入口 |

## 约束

- 只处理用户拥有或获授权分析的内容，不绕过会员、登录、付费、地区限制、验证码或风控。
- API Key、令牌和签名密钥不得写入 Git、Renderer、日志或文档。
- SQLite 不保存视频字节或临时签名 URL。
- 在线字幕 Key 不得传给 Renderer、Python sidecar、日志或 SQLite。
- 修改时保留无关用户改动，不自动 commit 或 push。
