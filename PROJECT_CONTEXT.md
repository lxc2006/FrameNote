# FrameNote 项目上下文

> 最后更新：2026-09-04

## 当前定位

FrameNote 已从网站迁移为 Windows 桌面独占应用。生产运行时由 Electron main、preload、React/Vite Renderer、本地 SQLite、核心 Python sidecar 和可选字幕扩展组成；仓库不再保留网页版本。

## 已完成

- Electron main/preload/renderer 三层和类型化 IPC。
- 模型总结、连续问答、对话历史与设置全部通过主进程能力调用。
- 对话存储改为原生 `node:sqlite` Repository，不再包含 D1 绑定或兼容适配层。
- Renderer 删除 `/api` HTTP 回退；媒体仅直连带随机 Bearer Token 的 loopback sidecar。
- 基础媒体核心与 FunASR/CT-Punc/PyTorch 字幕扩展分离。
- Electron 自动启动、监控、有限重启并终止媒体 sidecar。
- NSIS 安装、升级、卸载、GitHub Releases 自动更新和字幕扩展生命周期已经接入。
- 用户可在设置页录入自己的 DashScope、DeepSeek、SerpAPI Key；主进程用 Windows `safeStorage` 加密，密钥不会返回 Renderer 或写入 SQLite。
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
| `src/main/extensions/subtitle-extension.ts` | 字幕扩展安装、更新和卸载 |
| `src/renderer/src/components/VideoWorkbench.tsx` | 视频、总结、字幕和对话界面 |
| `src/shared/ipc-contract.ts` | 跨进程类型和频道白名单 |
| `media_service/core_entry.py` | PyInstaller 核心入口 |

## 约束

- 只处理用户拥有或获授权分析的内容，不绕过会员、登录、付费、地区限制、验证码或风控。
- API Key、令牌和签名密钥不得写入 Git、Renderer、日志或文档。
- SQLite 不保存视频字节或临时签名 URL。
- 基础安装包不得包含 FunASR、CT-Punc、PyTorch、Transformers、ModelScope 或字幕模型。
- 修改时保留无关用户改动，不自动 commit 或 push。
