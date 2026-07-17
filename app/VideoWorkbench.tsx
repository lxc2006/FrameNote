"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  extractBvid,
  formatDuration,
  formatFileSize,
  type VideoSourceDescriptor,
  type VideoSummary,
} from "@/lib/video-engine";
import {
  ModelClientError,
  analyzeVideo,
  askVideo,
  getModelStatus,
} from "@/lib/model-client";
import type { ModelStatusResponse } from "@/lib/model-api";

type InputMode = "upload" | "bilibili";
type Phase = "idle" | "processing" | "ready" | "error";

interface SelectedVideo {
  file: File;
  objectUrl: string;
  duration?: number;
}

interface ChatMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
}

const acceptedExtensions = ["mp4", "mov", "webm", "mkv", "m4v"];
const MAX_INLINE_VIDEO_SIZE = 7 * 1024 * 1024;

const suggestions = ["这个视频的核心观点是什么？", "按时间线梳理章节", "给我三个行动建议"];

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function fileExtension(filename: string) {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

function titleFromFilename(filename: string) {
  return filename.replace(/\.[^.]+$/, "") || filename;
}

function publicVideoUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:") return null;
    return /\.(?:mp4|mov|webm|mkv|m4v|avi|flv|wmv)$/i.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function titleFromUrl(value: string) {
  try {
    const pathname = new URL(value).pathname;
    return decodeURIComponent(pathname.split("/").filter(Boolean).at(-1) ?? "在线视频");
  } catch {
    return "在线视频";
  }
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取视频文件失败。"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("读取视频文件失败。"));
        return;
      }
      const base64 = reader.result.slice(reader.result.indexOf(",") + 1);
      const mimeType = file.type.startsWith("video/")
        ? file.type
        : `video/${fileExtension(file.name) || "mp4"}`;
      resolve(`data:${mimeType};base64,${base64}`);
    };
    reader.readAsDataURL(file);
  });
}

function stagesFor(source: VideoSourceDescriptor) {
  if (source.kind === "upload") {
    return [
      "校验视频文件",
      "编码安全模型输入",
      "提交视频素材",
      "Qwen 理解画面与声音",
      "生成结构化总结",
    ];
  }

  if (source.kind === "url") {
    return [
      "校验视频直链",
      "提交视频地址",
      "读取视频媒体",
      "Qwen 理解画面与声音",
      "生成结构化总结",
    ];
  }

  if (source.downloadFirst) {
    return [
      "校验 B 站视频地址",
      "下载视频到处理缓存",
      "提取音轨与关键帧",
      "语音转写与内容理解",
      "生成结构化总结",
    ];
  }

  return [
    "校验 B 站视频地址",
    "读取公开页面信息",
    "获取可分析媒体流",
    "语音转写与内容理解",
    "生成结构化总结",
  ];
}

export default function VideoWorkbench() {
  const [mode, setMode] = useState<InputMode>("upload");
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo | null>(null);
  const [bilibiliInput, setBilibiliInput] = useState("");
  const [downloadFirst, setDownloadFirst] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<VideoSummary | null>(null);
  const [activeSource, setActiveSource] = useState<VideoSourceDescriptor | null>(null);
  const [processingStages, setProcessingStages] = useState<string[]>([]);
  const [stageIndex, setStageIndex] = useState(-1);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [modelStatus, setModelStatus] = useState<ModelStatusResponse | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runTokenRef = useRef(0);
  const messageCounterRef = useRef(0);
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const askAbortRef = useRef<AbortController | null>(null);

  const bvid = useMemo(() => extractBvid(bilibiliInput), [bilibiliInput]);
  const directVideoUrl = useMemo(
    () => publicVideoUrl(bilibiliInput),
    [bilibiliInput],
  );

  const pendingSource = useMemo<VideoSourceDescriptor | null>(() => {
    if (mode === "upload") {
      if (!selectedVideo) return null;

      const durationLabel = selectedVideo.duration
        ? formatDuration(selectedVideo.duration)
        : "等待读取时长";

      return {
        kind: "upload",
        title: titleFromFilename(selectedVideo.file.name),
        subtitle: `${selectedVideo.file.name} · ${formatFileSize(
          selectedVideo.file.size,
        )} · ${durationLabel}`,
        durationLabel,
        downloadFirst: false,
      };
    }

    if (directVideoUrl) {
      return {
        kind: "url",
        title: titleFromUrl(directVideoUrl),
        subtitle: "HTTPS 视频直链 · 由 Qwen 直接读取",
        sourceUrl: directVideoUrl,
        downloadFirst: false,
      };
    }

    if (!bvid) return null;

    return {
      kind: "bilibili",
      title: `B站视频 ${bvid}`,
      subtitle: downloadFirst ? "下载后分析 · 等待读取视频信息" : "直接分析 · 等待读取视频信息",
      bvid,
      sourceUrl: `https://www.bilibili.com/video/${bvid}`,
      downloadFirst,
    };
  }, [bvid, directVideoUrl, downloadFirst, mode, selectedVideo]);

  useEffect(() => {
    const controller = new AbortController();
    void getModelStatus(controller.signal)
      .then(setModelStatus)
      .catch(() => setModelStatus(null));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    return () => {
      if (selectedVideo?.objectUrl) URL.revokeObjectURL(selectedVideo.objectUrl);
    };
  }, [selectedVideo]);

  function nextMessageId(role: ChatMessage["role"]) {
    messageCounterRef.current += 1;
    return `${role}-${messageCounterRef.current}`;
  }

  function selectMode(nextMode: InputMode) {
    if (phase === "processing") return;
    setMode(nextMode);
    setNotice(null);
  }

  function acceptFile(file: File) {
    const extension = fileExtension(file.name);

    if (!acceptedExtensions.includes(extension)) {
      setNotice("暂不支持这个文件格式，请选择 MP4、MOV、WebM、MKV 或 M4V 视频。");
      return;
    }

    if (file.size > MAX_INLINE_VIDEO_SIZE) {
      setNotice("当前模型直传上限为 7 MB。更大的视频请改用可公开读取的 HTTPS 视频直链。");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSelectedVideo({ file, objectUrl });
    setNotice(null);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) acceptFile(file);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  }

  async function handleAnalyze() {
    if (!pendingSource) {
      setNotice(
        mode === "upload"
          ? "请先选择一个视频文件。"
          : "请输入有效的 B 站视频链接或 BV 号。",
      );
      return;
    }

    if (pendingSource.kind === "bilibili") {
      setNotice("B 站页面地址还需要先解析为可读取的视频流；请先上传小于 7 MB 的视频，或粘贴 HTTPS 视频直链。");
      return;
    }
    if (pendingSource.kind === "upload" && selectedVideo && selectedVideo.file.size > MAX_INLINE_VIDEO_SIZE) {
      setNotice("当前 Qwen 内联直传上限为 7 MB。更大的视频请使用可公开读取的 HTTPS 视频直链，或等待对象存储上传接入。");
      return;
    }

    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    analyzeAbortRef.current?.abort();
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    const stages = stagesFor(pendingSource);

    setNotice(null);
    setPhase("processing");
    setSummary(null);
    setActiveModel(null);
    setMessages([]);
    setActiveSource(pendingSource);
    setProcessingStages(stages);
    setStageIndex(0);

    try {
      setStageIndex(1);
      const videoUrl = pendingSource.kind === "upload" && selectedVideo
        ? await fileToDataUrl(selectedVideo.file)
        : pendingSource.sourceUrl;
      if (!videoUrl) throw new Error("没有可提交给模型的视频输入。");
      if (runTokenRef.current !== runToken) return;
      setStageIndex(2);
      await delay(120);
      setStageIndex(3);
      const result = await analyzeVideo(
        {
          source: pendingSource,
          context: { videoUrl, fps: 0.5 },
        },
        controller.signal,
      );
      if (runTokenRef.current !== runToken) return;

      setStageIndex(4);
      setSummary(result.summary);
      setActiveModel(result.model);
      setMessages([
        {
          id: nextMessageId("assistant"),
          role: "assistant",
          content:
            "Qwen 已完成视频理解与结构化总结。接下来由 DeepSeek V4 Pro 回答核心观点、章节结构、术语解释或行动建议。",
        },
      ]);
      setPhase("ready");
    } catch (error) {
      if (runTokenRef.current !== runToken) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPhase("error");
      setNotice(
        error instanceof ModelClientError || error instanceof Error
          ? error.message
          : "处理没有完成，请检查素材后重试。",
      );
    } finally {
      if (analyzeAbortRef.current === controller) analyzeAbortRef.current = null;
    }
  }

  function resetWorkspace() {
    runTokenRef.current += 1;
    analyzeAbortRef.current?.abort();
    analyzeAbortRef.current = null;
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    setPhase("idle");
    setSummary(null);
    setActiveModel(null);
    setActiveSource(null);
    setProcessingStages([]);
    setStageIndex(-1);
    setMessages([]);
    setQuestion("");
    setIsReplying(false);
    setNotice(null);
  }

  async function askQuestion(rawQuestion: string) {
    const trimmed = rawQuestion.trim();
    if (!trimmed || !summary || !activeSource || isReplying || askAbortRef.current) return;

    const controller = new AbortController();
    askAbortRef.current = controller;

    const userMessage: ChatMessage = {
      id: nextMessageId("user"),
      role: "user",
      content: trimmed,
    };
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setIsReplying(true);

    try {
      const result = await askVideo(
        {
          question: trimmed,
          source: activeSource,
          summary,
          history: messages.slice(-12).map(({ role, content }) => ({ role, content })),
        },
        controller.signal,
      );
      if (askAbortRef.current !== controller) return;
      setMessages((current) => [
        ...current,
        {
          id: nextMessageId("assistant"),
          role: "assistant",
          content: result.answer,
        },
      ]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (askAbortRef.current !== controller) return;
      setMessages((current) => [
        ...current,
        {
          id: nextMessageId("assistant"),
          role: "assistant",
          content: error instanceof Error ? `回答失败：${error.message}` : "回答失败，请稍后重试。",
        },
      ]);
    } finally {
      if (askAbortRef.current === controller) {
        askAbortRef.current = null;
        setIsReplying(false);
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void askQuestion(question);
  }

  const progress =
    processingStages.length > 0
      ? Math.round(((stageIndex + 1) / processingStages.length) * 100)
      : 0;

  const shownSource = activeSource ?? pendingSource;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="帧记首页">
          <span className="brand-mark" aria-hidden="true">
            帧
          </span>
          <span className="brand-copy">
            <strong>帧记</strong>
            <small>FrameNote</small>
          </span>
        </a>

        <div className="topbar-actions">
          <span className="engine-badge">
            <span className="status-dot" aria-hidden="true" />
            {modelStatus
              ? modelStatus.configured && modelStatus.conversation.configured
                ? "Qwen 视频 · DeepSeek 对话"
                : modelStatus.configured
                  ? "等待 DeepSeek API Key"
                  : modelStatus.conversation.configured
                    ? "等待 Qwen API Key"
                    : "等待模型 API Key"
              : "正在检查模型"}
          </span>
          <button className="new-task-button" type="button" onClick={resetWorkspace}>
            <span aria-hidden="true">＋</span>
            新建任务
          </button>
        </div>
      </header>

      <div className="workspace" id="top">
        <section className="setup-column" aria-labelledby="setup-title">
          <div className="intro-block">
            <span className="eyebrow">VIDEO INTELLIGENCE</span>
            <h1 id="setup-title">让一段视频，变成一次可继续的对话。</h1>
            <p>
              上传小型本地视频，或粘贴 HTTPS 视频直链。帧记会先生成结构化总结，再保留上下文回答你的后续问题。
            </p>
          </div>

          <div className="source-card">
            <div className="mode-tabs" role="tablist" aria-label="选择视频来源">
              <button
                className={mode === "upload" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={mode === "upload"}
                onClick={() => selectMode("upload")}
              >
                <span aria-hidden="true">↥</span>
                上传视频
              </button>
              <button
                className={mode === "bilibili" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={mode === "bilibili"}
                onClick={() => selectMode("bilibili")}
              >
                <span aria-hidden="true">BV</span>
                B站 / 直链
              </button>
            </div>

            {mode === "upload" ? (
              <div className="source-form" role="tabpanel">
                <input
                  ref={fileInputRef}
                  className="sr-only"
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,.mkv,.m4v"
                  onChange={handleFileChange}
                  aria-label="选择视频文件"
                />

                {!selectedVideo ? (
                  <div
                    className={`drop-zone ${isDragging ? "dragging" : ""}`}
                    onDragEnter={(event) => {
                      event.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={handleDrop}
                  >
                    <span className="drop-icon" aria-hidden="true">
                      ↥
                    </span>
                    <strong>拖放视频到这里</strong>
                    <p>MP4、MOV、WebM、MKV、M4V · 当前模型直传 ≤ 7 MB</p>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      选择视频文件
                    </button>
                  </div>
                ) : (
                  <div className="selected-file">
                    <div className="file-preview">
                      <video
                        src={selectedVideo.objectUrl}
                        preload="metadata"
                        muted
                        onLoadedMetadata={(event) => {
                          const duration = event.currentTarget.duration;
                          setSelectedVideo((current) =>
                            current ? { ...current, duration } : current,
                          );
                        }}
                      />
                      <span aria-hidden="true">▶</span>
                    </div>
                    <div className="file-details">
                      <strong>{selectedVideo.file.name}</strong>
                      <span>
                        {formatFileSize(selectedVideo.file.size)} · {" "}
                        {selectedVideo.duration
                          ? formatDuration(selectedVideo.duration)
                          : "正在读取时长"}
                      </span>
                    </div>
                    <button
                      className="replace-file"
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      更换
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="source-form" role="tabpanel">
                <label className="field-label" htmlFor="bilibili-source">
                  B站链接、BV 号或 HTTPS 视频直链
                </label>
                <div
                  className={`link-input ${
                    bilibiliInput && !bvid && !directVideoUrl ? "invalid" : ""
                  }`}
                >
                  <span aria-hidden="true">↗</span>
                  <input
                    id="bilibili-source"
                    value={bilibiliInput}
                    onChange={(event) => {
                      setBilibiliInput(event.target.value);
                      setNotice(null);
                    }}
                    placeholder="BV... 或 https://example.com/video.mp4"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {bvid || directVideoUrl ? (
                    <span className="valid-mark">
                      {directVideoUrl ? "视频直链" : "已识别"}
                    </span>
                  ) : null}
                </div>
                {bilibiliInput && !bvid && !directVideoUrl ? (
                  <p className="field-error">没有识别到 BV 号或受支持的 HTTPS 视频直链。</p>
                ) : (
                  <p className="field-help">视频直链可直接调用 Qwen；B站链接仍需先完成取流。</p>
                )}

                <label className={`download-option ${directVideoUrl ? "disabled" : ""}`}>
                  <span className="switch-wrap">
                    <input
                      type="checkbox"
                      checked={downloadFirst}
                      disabled={Boolean(directVideoUrl)}
                      onChange={(event) => setDownloadFirst(event.target.checked)}
                    />
                    <span className="switch" aria-hidden="true" />
                  </span>
                  <span>
                    <strong>{directVideoUrl ? "视频直链由 Qwen 直接读取" : "先下载视频，再进行总结"}</strong>
                    <small>{directVideoUrl ? "无需经过浏览器上传" : "B站来源需要在后续取流服务中处理"}</small>
                  </span>
                </label>
              </div>
            )}

            {notice ? (
              <div className="inline-notice" role="alert">
                <span aria-hidden="true">!</span>
                {notice}
              </div>
            ) : null}

            <button
              className="primary-action"
              type="button"
              disabled={!pendingSource || phase === "processing"}
              onClick={() => void handleAnalyze()}
            >
              {phase === "processing" ? (
                <>
                  <span className="button-spinner" aria-hidden="true" />
                  正在理解视频
                </>
              ) : (
                <>
                  生成 AI 总结
                  <span aria-hidden="true">→</span>
                </>
              )}
            </button>
          </div>

          <div className="architecture-note">
            <span aria-hidden="true">◎</span>
            <div>
              <strong>Qwen 视频理解 + DeepSeek V4 Pro 对话</strong>
              <p>
                Qwen 负责生成总结，DeepSeek 基于总结、证据和会话历史继续回答；B站链接和大文件仍需接入媒体存储与取流。
              </p>
            </div>
          </div>
        </section>

        <section className="conversation-panel" aria-labelledby="conversation-title">
          <div className="conversation-header">
            <div>
              <span className="panel-kicker">视频总结对话</span>
              <h2 id="conversation-title">
                {shownSource?.title ?? "等待添加视频"}
              </h2>
              <p>{shownSource?.subtitle ?? "总结生成后，可在这里围绕视频继续提问"}</p>
            </div>
            <span className={`phase-badge ${phase}`}>
              {phase === "processing"
                ? "处理中"
                : phase === "ready"
                  ? "可对话"
                  : phase === "error"
                    ? "需重试"
                    : "未开始"}
            </span>
          </div>

          <div className="conversation-scroll" aria-live="polite">
            {phase === "idle" || phase === "error" ? (
              <div className="empty-state">
                <div className="empty-orbit" aria-hidden="true">
                  <span>✦</span>
                </div>
                <span className="empty-label">SUMMARY SPACE</span>
                <h3>视频内容，会在这里沉淀下来。</h3>
                <p>
                  完成左侧设置后，你会先得到一份带章节的总结，然后可以像聊天一样继续追问。
                </p>
                <div className="empty-capabilities" aria-label="可生成的内容">
                  <span>内容概览</span>
                  <span>关键观点</span>
                  <span>时间章节</span>
                  <span>后续问答</span>
                </div>
              </div>
            ) : null}

            {phase === "processing" ? (
              <div className="processing-view">
                <div className="processing-heading">
                  <div>
                    <span>正在构建视频上下文</span>
                    <strong>{progress}%</strong>
                  </div>
                  <div className="progress-track" aria-hidden="true">
                    <span style={{ width: `${progress}%` }} />
                  </div>
                </div>

                <ol className="stage-list">
                  {processingStages.map((stage, index) => (
                    <li
                      key={stage}
                      className={
                        index < stageIndex
                          ? "complete"
                          : index === stageIndex
                            ? "active"
                            : ""
                      }
                    >
                      <span className="stage-mark" aria-hidden="true">
                        {index < stageIndex ? "✓" : index + 1}
                      </span>
                      <div>
                        <strong>{stage}</strong>
                        <small>
                          {index < stageIndex
                            ? "已完成"
                            : index === stageIndex
                              ? "正在处理"
                              : "等待中"}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>

                <div className="processing-tip">
                  <span aria-hidden="true">i</span>
                  视频理解可能需要几分钟；处理完成前请保持当前页面打开。
                </div>
              </div>
            ) : null}

            {phase === "ready" && summary && activeSource ? (
              <div className="ready-view">
                <div className="demo-disclaimer real-model">
                  <span className="demo-tag">QWEN</span>
                  <p>
                    以下内容由真实 Qwen 视频模型生成。AI 结果可能有误，请结合原视频核对重要信息。
                  </p>
                  {activeSource.sourceUrl ? (
                    <a href={activeSource.sourceUrl} target="_blank" rel="noreferrer">
                      查看源视频 ↗
                    </a>
                  ) : null}
                </div>

                <article className="summary-document">
                  <div className="summary-title-row">
                    <div>
                      <span className="section-label">AI 视频总结</span>
                      <h3>{summary.title}</h3>
                    </div>
                    <span className="summary-mode">结构化</span>
                  </div>

                  <div className="summary-stats">
                    <span>
                      <strong>{summary.keyPoints.length}</strong> 个要点
                    </span>
                    <span>
                      <strong>{summary.chapters.length}</strong> 个章节
                    </span>
                    <span>
                      <strong>{activeModel ?? "Qwen"}</strong> 分析引擎
                    </span>
                  </div>

                  <section className="summary-section">
                    <h4>内容概览</h4>
                    <p className="overview-copy">{summary.overview}</p>
                  </section>

                  <section className="summary-section">
                    <h4>关键观点</h4>
                    <ol className="key-point-list">
                      {summary.keyPoints.map((point, index) => (
                        <li key={point.title}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <div>
                            <strong>{point.title}</strong>
                            <p>{point.detail}</p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </section>

                  <section className="summary-section">
                    <h4>章节时间线</h4>
                    <div className="chapter-list">
                      {summary.chapters.map((chapter) => (
                        <div className="chapter-row" key={`${chapter.time}-${chapter.title}`}>
                          <time>{chapter.time}</time>
                          <div>
                            <strong>{chapter.title}</strong>
                            <p>{chapter.description}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  <blockquote className="takeaway-block">
                    <span>一句话结论</span>
                    <p>{summary.takeaway}</p>
                  </blockquote>
                </article>

                <div className="chat-divider">
                  <span>围绕视频继续讨论</span>
                </div>

                <div className="message-list">
                  {messages.map((message) => (
                    <div className={`message ${message.role}`} key={message.id}>
                      <span className="message-avatar" aria-hidden="true">
                        {message.role === "assistant" ? "帧" : "你"}
                      </span>
                      <div>
                        <strong>{message.role === "assistant" ? "帧记 AI" : "你"}</strong>
                        <p>{message.content}</p>
                      </div>
                    </div>
                  ))}
                  {isReplying ? (
                    <div className="message assistant">
                      <span className="message-avatar" aria-hidden="true">
                        帧
                      </span>
                      <div>
                        <strong>帧记 AI</strong>
                        <span className="typing-indicator" aria-label="正在生成回答">
                          <i />
                          <i />
                          <i />
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className={`composer-area ${phase === "ready" ? "enabled" : ""}`}>
            {phase === "ready" ? (
              <div className="suggestion-row" aria-label="推荐问题">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    disabled={isReplying}
                    onClick={() => void askQuestion(suggestion)}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : null}

            <form className="composer" onSubmit={handleSubmit}>
              <label className="sr-only" htmlFor="video-question">
                围绕视频提问
              </label>
              <textarea
                id="video-question"
                rows={1}
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void askQuestion(question);
                  }
                }}
                placeholder={
                  phase === "ready" ? "问问视频里的细节…" : "总结生成后即可继续提问"
                }
                disabled={phase !== "ready" || isReplying}
              />
              <button
                type="submit"
                disabled={phase !== "ready" || isReplying || !question.trim()}
                aria-label="发送问题"
              >
                ↑
              </button>
            </form>
            <p className="composer-caption">AI 结果可能有误，请结合原视频核对重要信息。</p>
          </div>
        </section>
      </div>
    </main>
  );
}
