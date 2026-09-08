import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const GUIDE_MARKDOWN = String.raw`
# FrameNote 使用指南

## 1. 支持的视频来源

| 来源 | 如何使用 | 当前范围 |
| --- | --- | --- |
| 本地视频 | 切到 **本地**，拖入或选择文件 | MP4、WebM、MOV、MKV、M4V；不超过 500 MB、60 分钟，需要可读取的视频与音轨 |
| B站 | 切到 **B站**，粘贴 BV 号或公开视频链接 | 自动尝试 5 次；不登录账号，不处理会员或受限内容 |
| 抖音 | 切到 **抖音**，粘贴分享文本或 HTTPS 分享链接 | 使用应用内匿名会话获取公开内容；平台验证仍可能导致失败 |
| HTTPS 视频 | 在 **B站** 输入框粘贴视频直链 | 适合可直接访问的 MP4 等媒体地址 |

点击 **获取视频** 只准备预览；点击 **生成 AI 总结** 会在需要时自动获取视频并开始分析。已保存的本地对话会记住原文件路径；文件被移动或删除后，需要重新选择。

## 2. 视频总结链路

1. 媒体核心读取视频、时长和音轨。
2. 默认 **6 分钟以内**（可在设置中改为 0–900 秒）把完整视频交给 Qwen 理解。
3. 超过阈值时改用 **关键帧 + 音频**：按时长均匀取样并控制在最多 64 帧。
4. **Qwen 理解画面与声音** 和 **Qwen 在线识别字幕** 并行执行；一支失败时保留另一支结果。
5. 总结、字幕、来源与后续消息保存到本机 SQLite。

## 3. 后续对话

后续回答由 DeepSeek 完成，默认携带视频总结、最近消息以及可用的视频记忆。

- **回顾**：需要字幕细节、完整总结或较早对话时，允许读取已保存的扩展上下文。
- **联网**：允许 DeepSeek Responses API 使用内置网页搜索；明确要求联网或需要最新资料时会强制搜索，其余情况由 DeepSeek 按需决定。
- **深度**：使用 DeepSeek 深度思考模式，通常更慢，也会消耗更多 Token。

> DeepSeek 的内置搜索由服务端完成。网页拒绝访问、需要登录或没有可引用来源时，回答区会显示实际搜索状态。

## 4. API Key 是什么

| Key | 用途 | 获取位置 |
| --- | --- | --- |
| Qwen / DashScope | 视频总结、在线字幕识别 | [阿里云百炼工作台](https://bailian.console.aliyun.com/?apiKey=1&tab=model) |
| DeepSeek | 连续问答、深度思考与内置联网搜索 | [DeepSeek 开放平台](https://platform.deepseek.com/api_keys) |

在 **设置 → 模型 API Key** 中填写。应用只需要 Qwen 和 DeepSeek 两个 Key；Key 由 Electron 主进程使用 Windows 加密保存，不写入对话数据库，也不要提交到 Git。

## 5. 快速检查

- [ ] Qwen Key 已配置
- [ ] DeepSeek Key 已配置
- [ ] 需要联网时，已打开对话区的“联网”按钮
- [ ] 媒体仍可访问，且未超过本地分析限制
`;

export default function UsageGuide() {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setIsOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="usage-guide" ref={containerRef}>
      <button
        ref={buttonRef}
        className="usage-guide-button"
        type="button"
        aria-label="打开使用指南"
        title="使用指南"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={dialogId}
        onClick={() => setIsOpen((current) => !current)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z" />
          <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5v-16Z" />
        </svg>
      </button>

      {isOpen ? (
        <section
          id={dialogId}
          className="usage-guide-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
        >
          <div className="usage-guide-header">
            <div>
              <span>帮助</span>
              <h2 id={titleId}>使用指南</h2>
            </div>
            <button type="button" onClick={() => setIsOpen(false)}>
              关闭
            </button>
          </div>
          <div className="usage-guide-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {GUIDE_MARKDOWN}
            </ReactMarkdown>
          </div>
        </section>
      ) : null}
    </div>
  );
}
