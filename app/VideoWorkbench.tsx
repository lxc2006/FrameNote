"use client";

import {
  type CSSProperties,
  type ReactNode,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  extractBvid,
  formatDuration,
  formatFileSize,
  type VideoTranscript,
  type TranscriptLanguage,
  type VideoModelContext,
  type VideoSourceDescriptor,
  type VideoSummary,
} from "@/lib/video-engine";
import {
  ModelClientError,
  analyzeVideo,
  askVideo,
} from "@/lib/model-client";
import {
  downloadBilibiliVideo,
  extractBilibiliTranscript,
  prepareBilibiliVideoDownload,
  releaseBilibiliAnalysis,
  type BilibiliDownloadResult,
  type BilibiliPreparedDownloadResult,
} from "@/lib/client/bilibili-client";
import {
  extractMediaTranscript,
  prepareMediaAnalysis,
  releaseMediaAnalysis,
} from "@/lib/client/media-analysis-client";
import {
  appendConversationMessages,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
} from "@/lib/client/conversation-client";
import type {
  ConversationListItem,
  ConversationMessage,
} from "@/lib/conversation";
import UserSettingsMenu, {
  DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
  parseUserPreferences,
  USER_PREFERENCES_CHANGE_EVENT,
  USER_PREFERENCES_STORAGE_KEY,
} from "@/app/UserSettingsMenu";

type InputMode = "upload" | "bilibili";
type Phase = "idle" | "processing" | "ready" | "error";
type ResizeMode = "columns" | "rows" | "diagonal-source" | "diagonal-history";

interface SelectedVideo {
  file: File;
  objectUrl: string;
  duration?: number;
  width?: number;
  height?: number;
}

interface VideoPreview {
  kind: "bilibili" | "local" | "remote";
  playbackUrl: string;
  filename: string;
  title?: string;
  description?: string;
  sizeLabel?: string;
  durationLabel?: string;
  resolutionLabel?: string;
  sourceLabel?: string;
  durationSeconds?: number;
}

interface InlineNotice {
  message: string;
  tone: "error" | "success";
}

type ChatMessage = Pick<ConversationMessage, "id" | "role" | "content">;

const acceptedExtensions = ["mp4", "mov", "webm", "mkv", "m4v"];
const SUMMARY_READY_MESSAGE = "总结生成完毕，我还可以继续和你讨论相关内容 : )";
const MAX_MEDIA_ANALYSIS_BYTES = 500 * 1024 * 1024;
const ANALYSIS_SETTINGS_STORAGE_KEY = "framenote.analysis-settings.v1";
const CHAT_SETTINGS_STORAGE_KEY = "framenote.chat-settings.v1";
const TRANSCRIPT_LANGUAGE_OPTIONS: ReadonlyArray<{
  value: TranscriptLanguage;
  label: string;
}> = [
  { value: "zh", label: "中文" },
  { value: "ja", label: "日文" },
  { value: "en", label: "英文" },
];
const DEFAULT_TRANSCRIPT_LANGUAGES = TRANSCRIPT_LANGUAGE_OPTIONS.map(
  ({ value }) => value,
);
const WORKSPACE_LAYOUT_STORAGE_KEY = "framenote.workspace-layout.v1";
const MIN_SIDEBAR_WIDTH = 340;
const MIN_CONVERSATION_WIDTH = 560;
const MIN_SOURCE_PANE_HEIGHT = 260;
const MIN_HISTORY_PANE_HEIGHT = 220;
const WORKSPACE_RESIZER_SIZE = 10;
const PANE_RESIZER_SIZE = 10;

interface StoredWorkspaceLayout {
  sidebarVisible?: boolean;
  sourcePaneCollapsed?: boolean;
  historyPaneCollapsed?: boolean;
  sidebarWidth?: number | null;
  sourcePaneHeight?: number | null;
}

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

function sourceKindLabel(kind: ConversationListItem["sourceKind"]) {
  if (kind === "bilibili") return "B站";
  if (kind === "url") return "直链";
  return "上传";
}

function formatConversationDate(timestamp: number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function summaryParagraphs(value: string) {
  return value
    .split(/\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function summaryTimeline(summary: VideoSummary) {
  if (summary.keyPoints.length > 0) {
    return summary.keyPoints.map((point, index) => ({
      key: `point-${index}-${point.title}`,
      time: point.time ?? summary.chapters[index]?.time ?? "时间未知",
      title: point.title,
      detail: point.detail,
    }));
  }

  return summary.chapters.map((chapter, index) => ({
    key: `chapter-${index}-${chapter.time}-${chapter.title}`,
    time: chapter.time,
    title: chapter.title,
    detail: chapter.description,
  }));
}

function timestampToSeconds(value: string) {
  const normalized = value.trim();
  const colonParts = normalized.split(":");
  if (
    colonParts.length >= 2 &&
    colonParts.length <= 3 &&
    colonParts.every((part) => /^\d+(?:\.\d+)?$/.test(part))
  ) {
    return colonParts.reduce(
      (total, part) => total * 60 + Number(part),
      0,
    );
  }
  const chinese = normalized.match(
    /^(?:(\d+)\s*时)?(?:(\d+)\s*分)?(?:(\d+(?:\.\d+)?)\s*秒)?$/,
  );
  if (chinese && (chinese[1] || chinese[2] || chinese[3])) {
    return Number(chinese[1] ?? 0) * 3600 +
      Number(chinese[2] ?? 0) * 60 +
      Number(chinese[3] ?? 0);
  }
  return null;
}

function formatPlaybackTimestamp(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? [hours, minutes, remainder]
        .map((part) => String(part).padStart(2, "0"))
        .join(":")
    : [minutes, remainder]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}

function transcriptForConversationContext(transcript: VideoTranscript | null) {
  if (!transcript || transcript.status !== "ready") return undefined;
  const timedTranscript = transcript.cues
    .map(
      (cue) =>
        `[${formatPlaybackTimestamp(cue.startSeconds)}] ${cue.text.trim()}`,
    )
    .filter((line) => line.trim())
    .join("\n");
  return timedTranscript || transcript.text.trim() || undefined;
}

function renderInlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  return value
    .split(/(\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**")) {
        return (
          <strong key={`${keyPrefix}-strong-${index}`}>
            {part.slice(2, -2)}
          </strong>
        );
      }
      const link = part.match(/^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (link) {
        return (
          <a
            key={`${keyPrefix}-link-${index}`}
            href={link[2]}
            target="_blank"
            rel="noopener noreferrer"
          >
            {/^\d{1,2}$/.test(link[1]) ? `[${link[1]}]` : link[1]}
          </a>
        );
      }
      return <span key={`${keyPrefix}-text-${index}`}>{part}</span>;
    });
}

function MarkdownMessage({ content }: { content: string }) {
  const normalized = content
    .trim()
    .replace(/\s+(?=\*\*(?:\d+[.、]|[^*\n]{1,18}[：:])\*\*)/g, "\n\n");
  const blocks = normalized.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);

  return (
    <div className="message-markdown">
      {blocks.map((block, blockIndex) => {
        const lines = block.split(/\n/).map((line) => line.trim()).filter(Boolean);
        const unordered = lines.every((line) => /^[-*]\s+/.test(line));
        const ordered = lines.every((line) => /^\d+[.、]\s*/.test(line));
        if (unordered || ordered) {
          const List = ordered ? "ol" : "ul";
          return (
            <List key={`list-${blockIndex}`}>
              {lines.map((line, lineIndex) => (
                <li key={`item-${blockIndex}-${lineIndex}`}>
                  {renderInlineMarkdown(
                    line.replace(unordered ? /^[-*]\s+/ : /^\d+[.、]\s*/, ""),
                    `item-${blockIndex}-${lineIndex}`,
                  )}
                </li>
              ))}
            </List>
          );
        }
        const heading = block.match(/^#{1,6}\s+([\s\S]+)$/);
        if (heading) {
          return (
            <h5 key={`heading-${blockIndex}`}>
              {renderInlineMarkdown(heading[1], `heading-${blockIndex}`)}
            </h5>
          );
        }
        return (
          <p key={`paragraph-${blockIndex}`}>
            {lines.map((line, lineIndex) => (
              <span key={`line-${blockIndex}-${lineIndex}`}>
                {lineIndex > 0 ? <br /> : null}
                {renderInlineMarkdown(line, `line-${blockIndex}-${lineIndex}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function bilibiliAnalysisLabel(result: BilibiliDownloadResult) {
  return result.width && result.height
    ? `分析素材 ${result.width}×${result.height}`
    : "480p 等价分析素材";
}

function bilibiliPreviewResolutionLabel(
  result: Pick<BilibiliPreparedDownloadResult, "width" | "height">,
) {
  return result.width && result.height ? `${result.width}x${result.height}` : undefined;
}

async function downloadRemoteVideoFile(url: string, signal?: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      credentials: "omit",
      headers: { accept: "video/*,application/octet-stream" },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(
      "浏览器无法读取这个 HTTPS 视频直链；请确认地址允许跨域访问。",
    );
  }
  if (!response.ok) {
    throw new Error(`视频直链下载失败（HTTP ${response.status}）。`);
  }
  const blob = await response.blob();
  if (blob.size > MAX_MEDIA_ANALYSIS_BYTES) {
    throw new Error(
      "视频直链超过 500 MB 分析上限。",
    );
  }
  return new File([blob], titleFromUrl(url), {
    type: blob.type || "video/mp4",
    lastModified: Date.now(),
  });
}

function readVideoMetadata(file: File, signal?: AbortSignal) {
  return new Promise<{ duration: number; width: number; height: number }>(
    (resolve, reject) => {
      const video = document.createElement("video");
      const objectUrl = URL.createObjectURL(file);
      const finish = (callback: () => void) => {
        signal?.removeEventListener("abort", onAbort);
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(objectUrl);
        callback();
      };
      const onAbort = () =>
        finish(() =>
          reject(new DOMException("视频读取已取消。", "AbortError")),
        );
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        const duration = video.duration;
        const width = video.videoWidth;
        const height = video.videoHeight;
        finish(() =>
          Number.isFinite(duration) && duration > 0 && width > 0 && height > 0
            ? resolve({ duration, width, height })
            : reject(new Error("无法读取视频时长。")),
        );
      };
      video.onerror = () =>
        finish(() => reject(new Error("浏览器无法读取视频时长。")));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      video.src = objectUrl;
    },
  );
}

function stagesFor(
  source: VideoSourceDescriptor,
  transcriptEnabled: boolean,
) {
  const firstStage =
    source.kind === "upload"
      ? "上传本地视频"
      : source.kind === "url"
        ? "读取 HTTPS 视频直链"
        : "下载 B站分析视频";
  return [
    firstStage,
    source.kind === "bilibili"
      ? "准备约 480p 分析视频"
      : "压缩为约 480p 分析视频",
    "按时长准备完整视频或关键帧",
    "Qwen 理解画面与声音",
    ...(transcriptEnabled
      ? ["FunASR Nano＋CT-Punc 提取字幕"]
      : []),
    "保存总结与对话",
  ];
}

export default function VideoWorkbench() {
  const [mode, setMode] = useState<InputMode>("upload");
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo | null>(null);
  const [bilibiliInput, setBilibiliInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<VideoSummary | null>(null);
  const [activeSource, setActiveSource] = useState<VideoSourceDescriptor | null>(null);
  const [processingStages, setProcessingStages] = useState<string[]>([]);
  const [stageIndex, setStageIndex] = useState(-1);
  const [stageProgress, setStageProgress] = useState(0);
  const [notice, setNotice] = useState<InlineNotice | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<VideoTranscript | null>(null);
  const [qwenDirectSummaryMaxSeconds, setQwenDirectSummaryMaxSeconds] =
    useState(DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS);
  const [transcriptExtractionEnabled, setTranscriptExtractionEnabled] =
    useState(true);
  const [transcriptLanguages, setTranscriptLanguages] = useState<
    TranscriptLanguage[]
  >([...DEFAULT_TRANSCRIPT_LANGUAGES]);
  const [deepThinkingEnabled, setDeepThinkingEnabled] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [isAnalysisSettingsOpen, setIsAnalysisSettingsOpen] = useState(false);
  const [isFetchingVideo, setIsFetchingVideo] = useState(false);
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  const [conversationItems, setConversationItems] = useState<ConversationListItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isConversationListLoading, setIsConversationListLoading] = useState(true);
  const [conversationListError, setConversationListError] = useState<string | null>(null);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sourcePaneCollapsed, setSourcePaneCollapsed] = useState(false);
  const [historyPaneCollapsed, setHistoryPaneCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [sourcePaneHeight, setSourcePaneHeight] = useState<number | null>(null);
  const [workspaceLayoutReady, setWorkspaceLayoutReady] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runTokenRef = useRef(0);
  const messageCounterRef = useRef(0);
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const fetchVideoAbortRef = useRef<AbortController | null>(null);
  const askAbortRef = useRef<AbortController | null>(null);
  const pendingReplyRef = useRef<{
    controller: AbortController;
    userMessage: ChatMessage;
    conversationId: string | null;
  } | null>(null);
  const conversationLoadAbortRef = useRef<AbortController | null>(null);
  const restoreConversationRef = useRef<(id: string) => void>(() => undefined);
  const hasRestoredConversationRef = useRef(false);
  const videoPlayerRef = useRef<HTMLVideoElement>(null);
  const sideVideoPreviewRef = useRef<HTMLDivElement>(null);
  const pendingSeekSecondsRef = useRef<number | null>(null);
  const analysisSettingsRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const setupColumnRef = useRef<HTMLElement>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);

  const bvid = useMemo(() => extractBvid(bilibiliInput), [bilibiliInput]);
  const directVideoUrl = useMemo(
    () => publicVideoUrl(bilibiliInput),
    [bilibiliInput],
  );
  const overviewParagraphs = useMemo(
    () => (summary ? summaryParagraphs(summary.overview) : []),
    [summary],
  );
  const timelineItems = useMemo(
    () => (summary ? summaryTimeline(summary) : []),
    [summary],
  );

  useEffect(() => {
    const readSetting = () => {
      try {
        setQwenDirectSummaryMaxSeconds(
          parseUserPreferences(
            window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY) ?? "",
          ).qwenDirectSummaryMaxSeconds,
        );
      } catch {
        setQwenDirectSummaryMaxSeconds(
          DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
        );
      }
    };
    const handleStorage = (event: StorageEvent) => {
      if (
        event.key === USER_PREFERENCES_STORAGE_KEY ||
        event.key === null
      ) {
        readSetting();
      }
    };
    readSetting();
    window.addEventListener("storage", handleStorage);
    window.addEventListener(USER_PREFERENCES_CHANGE_EVENT, readSetting);
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(USER_PREFERENCES_CHANGE_EVENT, readSetting);
    };
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(
        ANALYSIS_SETTINGS_STORAGE_KEY,
      );
      if (stored) {
        const parsed = JSON.parse(stored) as {
          transcriptExtraction?: unknown;
          transcriptLanguages?: unknown;
        };
        if (typeof parsed.transcriptExtraction === "boolean") {
          setTranscriptExtractionEnabled(parsed.transcriptExtraction);
        }
        if (Array.isArray(parsed.transcriptLanguages)) {
          const languages = parsed.transcriptLanguages.filter(
            (value): value is TranscriptLanguage =>
              TRANSCRIPT_LANGUAGE_OPTIONS.some(
                (option) => option.value === value,
              ),
          );
          setTranscriptLanguages([...new Set(languages)]);
        }
      }
    } catch {
      setTranscriptExtractionEnabled(true);
    }
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CHAT_SETTINGS_STORAGE_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as {
        deepThinking?: unknown;
        webSearch?: unknown;
      };
      if (typeof parsed.deepThinking === "boolean") {
        setDeepThinkingEnabled(parsed.deepThinking);
      }
      if (typeof parsed.webSearch === "boolean") {
        setWebSearchEnabled(parsed.webSearch);
      }
    } catch {
      setDeepThinkingEnabled(false);
      setWebSearchEnabled(false);
    }
  }, []);

  useEffect(() => {
    if (!isAnalysisSettingsOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !analysisSettingsRef.current?.contains(event.target)
      ) {
        setIsAnalysisSettingsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsAnalysisSettingsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isAnalysisSettingsOpen]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as StoredWorkspaceLayout;
        if (typeof parsed.sidebarVisible === "boolean") {
          setSidebarVisible(parsed.sidebarVisible);
        }
        const sourceCollapsed = parsed.sourcePaneCollapsed === true;
        const historyCollapsed =
          parsed.historyPaneCollapsed === true && !sourceCollapsed;
        setSourcePaneCollapsed(sourceCollapsed);
        setHistoryPaneCollapsed(historyCollapsed);
        if (typeof parsed.sidebarWidth === "number") {
          setSidebarWidth(clampSidebarWidth(parsed.sidebarWidth));
        }
        if (typeof parsed.sourcePaneHeight === "number") {
          setSourcePaneHeight(clampSourcePaneHeight(parsed.sourcePaneHeight));
        }
      }
    } catch {
      // 损坏的本地布局设置直接回退到默认布局。
    } finally {
      setWorkspaceLayoutReady(true);
    }
  }, []);

  useEffect(() => {
    if (!workspaceLayoutReady) return;
    const saveTimer = window.setTimeout(() => {
      try {
        const layout: StoredWorkspaceLayout = {
          sidebarVisible,
          sourcePaneCollapsed,
          historyPaneCollapsed,
          sidebarWidth,
          sourcePaneHeight,
        };
        window.localStorage.setItem(
          WORKSPACE_LAYOUT_STORAGE_KEY,
          JSON.stringify(layout),
        );
      } catch {
        // 无法写入时只影响下次打开页面的布局恢复。
      }
    }, 120);
    return () => window.clearTimeout(saveTimer);
  }, [
    historyPaneCollapsed,
    sidebarVisible,
    sidebarWidth,
    sourcePaneCollapsed,
    sourcePaneHeight,
    workspaceLayoutReady,
  ]);

  useEffect(() => {
    const clampSavedSizes = () => {
      setSidebarWidth((current) =>
        current === null ? null : clampSidebarWidth(current),
      );
      setSourcePaneHeight((current) =>
        current === null ? null : clampSourcePaneHeight(current),
      );
    };
    window.addEventListener("resize", clampSavedSizes);
    return () => window.removeEventListener("resize", clampSavedSizes);
  }, []);

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
      };
    }

    if (directVideoUrl) {
      return {
        kind: "url",
        title: titleFromUrl(directVideoUrl),
        subtitle: "HTTPS 视频直链 · 由 Qwen 直接读取",
        sourceUrl: directVideoUrl,
      };
    }

    if (!bvid) return null;

    return {
      kind: "bilibili",
      title: `B站视频 ${bvid}`,
      subtitle: "公开 UGC · 等待读取视频信息",
      bvid,
      sourceUrl: `https://www.bilibili.com/video/${bvid}`,
    };
  }, [bvid, directVideoUrl, mode, selectedVideo]);

  useEffect(() => {
    return () => {
      if (selectedVideo?.objectUrl) URL.revokeObjectURL(selectedVideo.objectUrl);
    };
  }, [selectedVideo?.objectUrl]);

  useEffect(() => {
    const controller = new AbortController();
    setIsConversationListLoading(true);
    void listConversations(controller.signal)
      .then((items) => {
        setConversationItems(items);
        setConversationListError(null);
        if (!hasRestoredConversationRef.current && items[0]) {
          hasRestoredConversationRef.current = true;
          restoreConversationRef.current(items[0].id);
        }
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setConversationListError(
          error instanceof Error ? error.message : "无法读取对话列表。",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsConversationListLoading(false);
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    const cancelActiveWork = () => {
      runTokenRef.current += 1;
      analyzeAbortRef.current?.abort();
      fetchVideoAbortRef.current?.abort();
      askAbortRef.current?.abort();
      pendingReplyRef.current = null;
      conversationLoadAbortRef.current?.abort();
      activeResizeCleanupRef.current?.();
    };
    globalThis.addEventListener("pagehide", cancelActiveWork);
    return () => {
      globalThis.removeEventListener("pagehide", cancelActiveWork);
      cancelActiveWork();
    };
  }, []);

  function nextMessageId(role: ChatMessage["role"]) {
    messageCounterRef.current += 1;
    return `${role}-${messageCounterRef.current}`;
  }

  function showNotice(message: string, tone: InlineNotice["tone"] = "error") {
    setNotice({ message, tone });
  }

  function persistAnalysisSettings(
    transcriptExtraction: boolean,
    languages: TranscriptLanguage[],
  ) {
    try {
      window.localStorage.setItem(
        ANALYSIS_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          transcriptExtraction,
          transcriptLanguages: languages,
        }),
      );
    } catch {
      // 无法写入浏览器偏好时，本次会话中的设置仍然生效。
    }
  }

  function updateTranscriptExtraction(enabled: boolean) {
    setTranscriptExtractionEnabled(enabled);
    persistAnalysisSettings(enabled, transcriptLanguages);
  }

  function toggleTranscriptLanguage(language: TranscriptLanguage) {
    setTranscriptLanguages((current) => {
      const next = current.includes(language)
        ? current.filter((value) => value !== language)
        : [...current, language].sort(
            (left, right) =>
              DEFAULT_TRANSCRIPT_LANGUAGES.indexOf(left) -
              DEFAULT_TRANSCRIPT_LANGUAGES.indexOf(right),
          );
      persistAnalysisSettings(transcriptExtractionEnabled, next);
      return next;
    });
  }

  function updateChatSetting(
    setting: "deepThinking" | "webSearch",
    enabled: boolean,
  ) {
    const nextDeepThinking =
      setting === "deepThinking" ? enabled : deepThinkingEnabled;
    const nextWebSearch =
      setting === "webSearch" ? enabled : webSearchEnabled;
    setDeepThinkingEnabled(nextDeepThinking);
    setWebSearchEnabled(nextWebSearch);
    try {
      window.localStorage.setItem(
        CHAT_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          deepThinking: nextDeepThinking,
          webSearch: nextWebSearch,
        }),
      );
    } catch {
      // 无法保存时，开关在本次页面会话中仍然有效。
    }
  }

  function sidebarWidthLimits() {
    const workspaceWidth =
      workspaceRef.current?.getBoundingClientRect().width ??
      MIN_SIDEBAR_WIDTH + MIN_CONVERSATION_WIDTH + WORKSPACE_RESIZER_SIZE;
    return {
      min: MIN_SIDEBAR_WIDTH,
      max: Math.max(
        MIN_SIDEBAR_WIDTH,
        workspaceWidth - MIN_CONVERSATION_WIDTH - WORKSPACE_RESIZER_SIZE,
      ),
    };
  }

  function sourcePaneHeightLimits() {
    const columnHeight =
      setupColumnRef.current?.getBoundingClientRect().height ??
      MIN_SOURCE_PANE_HEIGHT + MIN_HISTORY_PANE_HEIGHT + PANE_RESIZER_SIZE;
    return {
      min: MIN_SOURCE_PANE_HEIGHT,
      max: Math.max(
        MIN_SOURCE_PANE_HEIGHT,
        columnHeight - MIN_HISTORY_PANE_HEIGHT - PANE_RESIZER_SIZE,
      ),
    };
  }

  function clampTo(value: number, minimum: number, maximum: number) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function clampSidebarWidth(value: number) {
    const { min, max } = sidebarWidthLimits();
    return clampTo(value, min, max);
  }

  function clampSourcePaneHeight(value: number) {
    const { min, max } = sourcePaneHeightLimits();
    return clampTo(value, min, max);
  }

  function beginResize(
    mode: ResizeMode,
    event: ReactPointerEvent<HTMLElement>,
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    activeResizeCleanupRef.current?.();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const resizesColumns = mode !== "rows";
    const resizesRows = mode !== "columns";
    const startX = event.clientX;
    const startY = event.clientY;
    const startSidebarWidth =
      setupColumnRef.current?.getBoundingClientRect().width ??
      sidebarWidth ??
      MIN_SIDEBAR_WIDTH;
    const startSourcePaneHeight =
      setupColumnRef.current?.firstElementChild?.getBoundingClientRect()
        .height ??
      sourcePaneHeight ??
      MIN_SOURCE_PANE_HEIGHT;

    target.setPointerCapture?.(pointerId);
    document.documentElement.dataset.resizing = mode;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      if (resizesColumns) {
        setSidebarWidth(
          clampSidebarWidth(
            startSidebarWidth + moveEvent.clientX - startX,
          ),
        );
      }
      if (resizesRows) {
        setSourcePaneHeight(
          clampSourcePaneHeight(
            startSourcePaneHeight + moveEvent.clientY - startY,
          ),
        );
      }
    };
    const finishResize = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      delete document.documentElement.dataset.resizing;
      if (target.hasPointerCapture?.(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      activeResizeCleanupRef.current = null;
    };

    activeResizeCleanupRef.current = finishResize;
    window.addEventListener("pointermove", handlePointerMove, {
      passive: false,
    });
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
  }

  function handleWorkspaceResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const { min, max } = sidebarWidthLimits();
    const current =
      setupColumnRef.current?.getBoundingClientRect().width ??
      sidebarWidth ??
      min;
    const next =
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max
          : current + (event.key === "ArrowLeft" ? -24 : 24);
    setSidebarWidth(clampTo(next, min, max));
  }

  function handlePaneResizeKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const { min, max } = sourcePaneHeightLimits();
    const current =
      sourcePaneHeight ??
      event.currentTarget.previousElementSibling?.getBoundingClientRect()
        .height ??
      min;
    const next =
      event.key === "Home"
        ? min
        : event.key === "End"
          ? max
          : current + (event.key === "ArrowUp" ? -24 : 24);
    setSourcePaneHeight(clampTo(next, min, max));
  }

  function handleDiagonalResizeKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
  ) {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
        event.key,
      )
    ) {
      return;
    }
    event.preventDefault();

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const { min, max } = sidebarWidthLimits();
      const current =
        setupColumnRef.current?.getBoundingClientRect().width ??
        sidebarWidth ??
        min;
      setSidebarWidth(
        clampTo(
          current + (event.key === "ArrowLeft" ? -24 : 24),
          min,
          max,
        ),
      );
      return;
    }

    const { min, max } = sourcePaneHeightLimits();
    const current =
      setupColumnRef.current?.firstElementChild?.getBoundingClientRect()
        .height ??
      sourcePaneHeight ??
      min;
    setSourcePaneHeight(
      clampTo(
        current + (event.key === "ArrowUp" ? -24 : 24),
        min,
        max,
      ),
    );
  }

  function toggleSourcePane() {
    setSourcePaneCollapsed((current) => {
      const next = !current;
      if (next) {
        setHistoryPaneCollapsed(false);
        setIsAnalysisSettingsOpen(false);
      }
      return next;
    });
  }

  function toggleHistoryPane() {
    setHistoryPaneCollapsed((current) => {
      const next = !current;
      if (next) setSourcePaneCollapsed(false);
      return next;
    });
  }

  function upsertConversationItem(item: ConversationListItem) {
    setConversationItems((current) =>
      [item, ...current.filter((conversation) => conversation.id !== item.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    );
  }

  function touchConversationItem(id: string) {
    setConversationItems((current) =>
      current
        .map((item) =>
          item.id === id ? { ...item, updatedAt: Date.now() } : item,
        )
        .sort((left, right) => right.updatedAt - left.updatedAt),
    );
  }

  function clearVideoPreview() {
    setVideoPreview(null);
  }

  function showRemoteVideo(url: string) {
    setVideoPreview({
      kind: "remote",
      playbackUrl: url,
      filename: titleFromUrl(url),
      title: titleFromUrl(url),
      sourceLabel: "HTTPS 视频直链",
    });
  }

  function showLocalVideo(video: SelectedVideo) {
    setVideoPreview({
      kind: "local",
      playbackUrl: video.objectUrl,
      filename: video.file.name,
      title: titleFromFilename(video.file.name),
      sizeLabel: formatFileSize(video.file.size),
      durationLabel: video.duration ? formatDuration(video.duration) : undefined,
      durationSeconds: video.duration,
      resolutionLabel:
        video.width && video.height
          ? `${video.width}x${video.height}`
          : undefined,
      sourceLabel: "本地上传",
    });
  }

  function showBilibiliVideo(
    result: BilibiliPreparedDownloadResult,
    fallbackDescription?: string,
  ) {
    setVideoPreview({
      kind: "bilibili",
      playbackUrl: result.playbackUrl,
      filename: result.filename || "bilibili-video.mp4",
      title: result.title,
      description: result.description ?? fallbackDescription,
      sizeLabel: formatFileSize(result.sizeBytes),
      durationLabel: formatDuration(result.durationSeconds),
      durationSeconds: result.durationSeconds,
      resolutionLabel: bilibiliPreviewResolutionLabel(result),
      sourceLabel: result.bvid,
    });
  }

  function selectMode(nextMode: InputMode) {
    if (phase === "processing" || isFetchingVideo) return;
    setMode(nextMode);
    if (nextMode === "upload") {
      if (videoPreview?.kind === "bilibili") clearVideoPreview();
    }
    setNotice(null);
  }

  async function acceptFile(file: File) {
    if (phase === "processing") return;
    const extension = fileExtension(file.name);

    if (!acceptedExtensions.includes(extension)) {
      showNotice("暂不支持这个文件格式，请选择 MP4、MOV、WebM、MKV 或 M4V 视频。");
      return;
    }

    if (file.size > MAX_MEDIA_ANALYSIS_BYTES) {
      showNotice("当前视频分析支持不超过 500 MB 的文件。");
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const nextVideo: SelectedVideo = { file, objectUrl };
    setSelectedVideo(nextVideo);
    setNotice(null);
    try {
      const metadata = await readVideoMetadata(file);
      const hydratedVideo = { ...nextVideo, ...metadata };
      setSelectedVideo((current) =>
        current?.objectUrl === objectUrl ? hydratedVideo : current,
      );
      if (
        phase === "ready" &&
        activeConversationId &&
        activeSource?.kind === "upload"
      ) {
        showLocalVideo(hydratedVideo);
        showNotice("已选择本地视频，可预览并跳转时间点。", "success");
      }
    } catch (error) {
      setSelectedVideo((current) =>
        current?.objectUrl === objectUrl ? null : current,
      );
      URL.revokeObjectURL(objectUrl);
      showNotice(
        error instanceof Error ? error.message : "无法读取本地视频信息。",
      );
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void acceptFile(file);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void acceptFile(file);
  }

  function reportAnalysisPreparationProgress(progress: {
    stage: string;
    progress: number;
    phase?: string;
  }) {
    if (progress.stage === "uploading") {
      setStageIndex(0);
      setStageProgress((current) => Math.max(current, progress.progress));
      return;
    }
    if (progress.stage === "downloading") {
      setStageIndex(2);
      setStageProgress(progress.progress);
      return;
    }
    if (progress.phase === "analyzing") {
      setStageIndex(2);
      setStageProgress(
        Math.min(1, Math.max(0.05, (progress.progress - 0.9) / 0.1)),
      );
      return;
    }
    if (progress.phase === "merging") {
      setStageIndex(1);
      setStageProgress(Math.min(1, progress.progress / 0.9));
      return;
    }
    setStageIndex(0);
    setStageProgress(Math.min(1, progress.progress));
  }

  async function downloadBilibiliAnalysis(
    source: VideoSourceDescriptor,
    controller: AbortController,
    runToken: number,
  ) {
    if (!source.bvid) {
      throw new Error("没有可下载的 BV 号。");
    }

    const downloaded = await downloadBilibiliVideo(source.bvid, {
      signal: controller.signal,
      directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
      onProgress: ({ stage, progress, phase }) => {
        if (runTokenRef.current !== runToken) return;
        reportAnalysisPreparationProgress({ stage, progress, phase });
      },
    });
    if (runTokenRef.current !== runToken) return null;
    return downloaded;
  }

  async function prepareBilibiliPreview(
    source: VideoSourceDescriptor,
    controller: AbortController,
    runToken: number,
  ) {
    if (!source.bvid) {
      throw new Error("没有可获取的 BV 号。");
    }

    const prepared = await prepareBilibiliVideoDownload(source.bvid, {
      signal: controller.signal,
      onProgress: ({ stage, progress }) => {
        if (runTokenRef.current !== runToken) return;
        setStageIndex(1);
        setStageProgress(
          stage === "preparing"
            ? Math.min(0.95, progress * 0.95)
            : 1,
        );
      },
    });
    if (runTokenRef.current !== runToken) return null;

    showBilibiliVideo(prepared, source.description);
    return prepared;
  }

  async function loadBilibiliConversationPreview(
    source: VideoSourceDescriptor,
    restoredBvid: string,
    runToken: number,
    reason: "restore" | "first-summary",
  ) {
    const restoring = reason === "restore";
    fetchVideoAbortRef.current?.abort();
    const controller = new AbortController();
    fetchVideoAbortRef.current = controller;
    setIsFetchingVideo(true);
    setProcessingStages(["校验 B 站视频地址", "准备最高画质浏览器预览"]);
    setStageIndex(0);
    setStageProgress(0.15);
    showNotice(
      restoring
        ? "总结和对话已恢复，正在自动恢复视频预览……"
        : "总结已生成，正在自动获取视频预览……",
      "success",
    );

    try {
      const prepared = await prepareBilibiliPreview(
        { ...source, bvid: restoredBvid },
        controller,
        runToken,
      );
      if (
        !prepared ||
        fetchVideoAbortRef.current !== controller ||
        runTokenRef.current !== runToken
      ) {
        return;
      }
      setActiveSource({
        ...source,
        bvid: prepared.bvid,
        sourceUrl:
          source.sourceUrl ?? `https://www.bilibili.com/video/${prepared.bvid}`,
        title: prepared.title,
        description: prepared.description ?? source.description,
        durationLabel: formatDuration(prepared.durationSeconds),
        subtitle: `${prepared.bvid} · ${formatFileSize(
          prepared.sizeBytes,
        )} · ${formatDuration(prepared.durationSeconds)}`,
      });
      setStageIndex(2);
      setStageProgress(1);
      showNotice(
        restoring
          ? "总结、对话和视频预览已恢复。"
          : "总结已生成，视频预览已准备好。",
        "success",
      );
    } catch (error) {
      if (
        fetchVideoAbortRef.current !== controller ||
        runTokenRef.current !== runToken ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      showNotice(
        error instanceof Error
          ? `${restoring ? "总结和对话已恢复" : "总结已生成"}，但视频预览自动获取失败：${error.message}`
          : `${restoring ? "总结和对话已恢复" : "总结已生成"}，但视频预览自动获取失败。`,
      );
    } finally {
      if (
        fetchVideoAbortRef.current === controller &&
        runTokenRef.current === runToken
      ) {
        fetchVideoAbortRef.current = null;
        setIsFetchingVideo(false);
      }
    }
  }

  async function handleFetchVideo() {
    if (!pendingSource || pendingSource.kind === "upload") {
      showNotice("请输入 B站链接、BV 号或 HTTPS 视频直链后再获取视频。");
      return;
    }
    if (phase === "processing" || isFetchingVideo) return;

    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    fetchVideoAbortRef.current?.abort();
    analyzeAbortRef.current?.abort();
    stopReply();
    const controller = new AbortController();
    fetchVideoAbortRef.current = controller;
    const preservesConversation =
      phase === "ready" &&
      Boolean(summary) &&
      Boolean(activeConversationId) &&
      activeSource?.kind === pendingSource.kind &&
      (pendingSource.kind === "bilibili"
        ? activeSource.bvid === pendingSource.bvid
        : pendingSource.kind === "url"
          ? activeSource.sourceUrl === pendingSource.sourceUrl
          : false);

    setNotice(null);
    if (!preservesConversation) {
      setSummary(null);
      setTranscript(null);
      setActiveModel(null);
      setMessages([]);
      setActiveConversationId(null);
      setActiveSource(pendingSource);
    }

    if (pendingSource.kind === "url" && pendingSource.sourceUrl) {
      showRemoteVideo(pendingSource.sourceUrl);
      setPhase(preservesConversation ? "ready" : "idle");
      showNotice(
        preservesConversation
          ? "总结、对话和视频直链已恢复。"
          : "视频直链已准备好，可预览；点击生成 AI 总结后再开始分析。",
        "success",
      );
      if (fetchVideoAbortRef.current === controller) {
        fetchVideoAbortRef.current = null;
      }
      return;
    }

    if (!pendingSource.bvid) {
      showNotice("没有识别到可播放的 BV 号。");
      if (fetchVideoAbortRef.current === controller) {
        fetchVideoAbortRef.current = null;
      }
      return;
    }

    const stages = ["校验 B 站视频地址", "准备最高画质浏览器预览"];
    setIsFetchingVideo(true);
    if (!preservesConversation) setPhase("processing");
    setProcessingStages(stages);
    setStageIndex(0);
    setStageProgress(0.15);
    if (!preservesConversation) clearVideoPreview();

    try {
      const prepared = await prepareBilibiliPreview(
        pendingSource,
        controller,
        runToken,
      );
      if (!prepared || runTokenRef.current !== runToken) return;

      const preparedSource: VideoSourceDescriptor = {
        ...(preservesConversation && activeSource ? activeSource : pendingSource),
        title: prepared.title,
        description: prepared.description ?? pendingSource.description,
        durationLabel: formatDuration(prepared.durationSeconds),
        subtitle: `${prepared.bvid} · ${formatFileSize(
          prepared.sizeBytes,
        )} · ${formatDuration(prepared.durationSeconds)}`,
      };
      setActiveSource(preparedSource);

      setStageIndex(stages.length);
      setStageProgress(1);
      setPhase(preservesConversation ? "ready" : "idle");
      showNotice(
        preservesConversation
          ? "总结、对话和视频预览已恢复。"
          : "视频预览已准备好。",
        "success",
      );
    } catch (error) {
      if (runTokenRef.current !== runToken) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPhase(preservesConversation ? "ready" : "error");
      showNotice(
        error instanceof Error ? error.message : "获取视频失败，请检查链接后重试。",
      );
    } finally {
      if (fetchVideoAbortRef.current === controller) {
        fetchVideoAbortRef.current = null;
      }
      if (runTokenRef.current === runToken) {
        setIsFetchingVideo(false);
      }
    }
  }

  async function handleAnalyze() {
    if (isFetchingVideo) return;
    if (!pendingSource) {
      showNotice(
        mode === "upload"
          ? "请先选择一个视频文件。"
          : "请输入有效的 B 站视频链接或 BV 号。",
      );
      return;
    }

    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    analyzeAbortRef.current?.abort();
    stopReply();
    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    const stages = stagesFor(pendingSource, transcriptExtractionEnabled);

    setNotice(null);
    setIsAnalysisSettingsOpen(false);
    setPhase("processing");
    setSummary(null);
    setTranscript(null);
    setActiveModel(null);
    setMessages([]);
    setActiveConversationId(null);
    setActiveSource(pendingSource);
    setProcessingStages(stages);
    setStageIndex(0);
    setStageProgress(0.2);
    if (pendingSource.kind === "url" && pendingSource.sourceUrl) {
      showRemoteVideo(pendingSource.sourceUrl);
    } else if (pendingSource.kind === "upload") {
      if (selectedVideo) showLocalVideo(selectedVideo);
    }

    let bilibiliAnalysisJobId: string | null = null;
    let mediaAnalysisJobId: string | null = null;
    let analysisTranscript: VideoTranscript | null = null;
    try {
      let context: VideoModelContext;
      let analysisSource = pendingSource;
      if (pendingSource.kind === "upload") {
        if (!selectedVideo) {
          throw new Error("请重新选择需要分析的本地视频。");
        }
        const prepared = await prepareMediaAnalysis(selectedVideo.file, {
          sourceKind: "upload",
          directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
          signal: controller.signal,
          onProgress: (progress) => {
            if (runTokenRef.current !== runToken) return;
            reportAnalysisPreparationProgress(progress);
          },
        });
        mediaAnalysisJobId = prepared.jobId;
        context = prepared.context;
        analysisTranscript = prepared.transcript ?? null;
        analysisSource = {
          ...pendingSource,
          title: titleFromFilename(selectedVideo.file.name),
          durationLabel: formatDuration(prepared.durationSeconds),
        };
        setActiveSource(analysisSource);
      } else if (pendingSource.kind === "bilibili") {
        if (!pendingSource.bvid) {
          throw new Error("没有可下载的 BV 号。");
        }
        setStageIndex(1);
        setStageProgress(0);
        const downloaded = await downloadBilibiliAnalysis(
          pendingSource,
          controller,
          runToken,
        );
        if (!downloaded) return;
        bilibiliAnalysisJobId = downloaded.jobId;
        if (runTokenRef.current !== runToken) return;

        analysisSource = {
          ...pendingSource,
          title: downloaded.title,
          description: downloaded.description ?? pendingSource.description,
          durationLabel: formatDuration(downloaded.durationSeconds),
          subtitle: `${downloaded.bvid} · ${formatFileSize(
            downloaded.sizeBytes,
          )} · ${formatDuration(downloaded.durationSeconds)} · ${bilibiliAnalysisLabel(
            downloaded,
          )}`,
        };
        setActiveSource(analysisSource);
        analysisTranscript = downloaded.transcript ?? null;
        setTranscript(analysisTranscript);
        setStageIndex(2);
        setStageProgress(1);
        context = {
          ...downloaded.context,
          durationSeconds: downloaded.durationSeconds,
        };
      } else {
        const videoUrl = pendingSource.sourceUrl;
        if (!videoUrl) throw new Error("没有可提交给模型的视频输入。");
        setStageIndex(0);
        setStageProgress(0.1);
        const remoteFile = await downloadRemoteVideoFile(
          videoUrl,
          controller.signal,
        );
        setStageProgress(0.45);
        const prepared = await prepareMediaAnalysis(remoteFile, {
          sourceKind: "url",
          sourceUrl: videoUrl,
          directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
          signal: controller.signal,
          onProgress: (progress) => {
            if (runTokenRef.current !== runToken) return;
            reportAnalysisPreparationProgress(progress);
          },
        });
        mediaAnalysisJobId = prepared.jobId;
        context = prepared.context;
        analysisTranscript = prepared.transcript ?? null;
        analysisSource = {
          ...pendingSource,
          title: prepared.title || pendingSource.title,
          durationLabel: formatDuration(prepared.durationSeconds),
          subtitle: `HTTPS 视频直链 · ${formatDuration(
            prepared.durationSeconds,
          )}`,
        };
        setActiveSource(analysisSource);
      }
      if (runTokenRef.current !== runToken) return;
      setStageIndex(3);
      setStageProgress(0.15);
      const result = await analyzeVideo(
        {
          source: analysisSource,
          context,
        },
        controller.signal,
      );
      if (runTokenRef.current !== runToken) return;

      setStageProgress(1);
      if (transcriptExtractionEnabled) {
        setStageIndex(4);
        setStageProgress(0.1);
        if (bilibiliAnalysisJobId) {
          analysisTranscript = await extractBilibiliTranscript(
            bilibiliAnalysisJobId,
            transcriptLanguages,
            controller.signal,
          );
        } else if (mediaAnalysisJobId) {
          analysisTranscript = await extractMediaTranscript(
            mediaAnalysisJobId,
            transcriptLanguages,
            controller.signal,
          );
        }
        if (runTokenRef.current !== runToken) return;
        setTranscript(analysisTranscript);
        setStageProgress(1);
      } else {
        analysisTranscript = null;
        setTranscript(null);
      }
      setStageIndex(stages.length - 1);
      setStageProgress(0.2);
      setSummary(result.summary);
      setActiveModel(result.model);
      const initialMessage: ChatMessage = {
        id: nextMessageId("assistant"),
        role: "assistant",
        content: SUMMARY_READY_MESSAGE,
      };
      setMessages([initialMessage]);

      try {
        const saved = await createConversation({
          source: analysisSource,
          summary: result.summary,
          activeModel: result.model,
          messages: [{ role: initialMessage.role, content: initialMessage.content }],
          ...(analysisTranscript ? { transcript: analysisTranscript } : {}),
        });
        if (runTokenRef.current !== runToken) return;
        setActiveConversationId(saved.id);
        upsertConversationItem(saved);
        setConversationListError(null);
        setStageProgress(1);
      } catch (saveError) {
        if (runTokenRef.current !== runToken) return;
        setConversationListError(
          saveError instanceof Error
            ? `总结已生成，但保存对话失败：${saveError.message}`
            : "总结已生成，但保存对话失败。",
        );
      }
      if (runTokenRef.current !== runToken) return;
      setStageProgress(1);
      setPhase("ready");
      if (
        analysisSource.kind === "bilibili" &&
        analysisSource.bvid &&
        !(
          videoPreview?.kind === "bilibili" &&
          videoPreview.sourceLabel === analysisSource.bvid
        )
      ) {
        void loadBilibiliConversationPreview(
          analysisSource,
          analysisSource.bvid,
          runToken,
          "first-summary",
        );
      }
    } catch (error) {
      if (runTokenRef.current !== runToken) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPhase("error");
      showNotice(
        error instanceof ModelClientError || error instanceof Error
          ? error.message
          : "处理没有完成，请检查素材后重试。",
      );
    } finally {
      if (bilibiliAnalysisJobId) {
        void releaseBilibiliAnalysis(bilibiliAnalysisJobId);
      }
      if (mediaAnalysisJobId) {
        void releaseMediaAnalysis(mediaAnalysisJobId);
      }
      if (analyzeAbortRef.current === controller) analyzeAbortRef.current = null;
    }
  }

  function resetWorkspace() {
    runTokenRef.current += 1;
    analyzeAbortRef.current?.abort();
    analyzeAbortRef.current = null;
    fetchVideoAbortRef.current?.abort();
    fetchVideoAbortRef.current = null;
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    pendingReplyRef.current = null;
    conversationLoadAbortRef.current?.abort();
    conversationLoadAbortRef.current = null;
    setPhase("idle");
    setSummary(null);
    setTranscript(null);
    setActiveModel(null);
    setActiveSource(null);
    setProcessingStages([]);
    setStageIndex(-1);
    setStageProgress(0);
    setIsFetchingVideo(false);
    clearVideoPreview();
    setMessages([]);
    setActiveConversationId(null);
    setLoadingConversationId(null);
    setRenamingConversationId(null);
    setSelectedVideo(null);
    setBilibiliInput("");
    setMode("upload");
    setQuestion("");
    setIsReplying(false);
    setNotice(null);
  }

  async function handleSelectConversation(id: string) {
    if (
      phase === "processing" ||
      busyConversationId ||
      loadingConversationId === id
    ) {
      return;
    }

    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    analyzeAbortRef.current?.abort();
    analyzeAbortRef.current = null;
    fetchVideoAbortRef.current?.abort();
    fetchVideoAbortRef.current = null;
    setIsFetchingVideo(false);
    stopReply();
    conversationLoadAbortRef.current?.abort();
    const controller = new AbortController();
    conversationLoadAbortRef.current = controller;
    setLoadingConversationId(id);
    setConversationListError(null);

    try {
      const conversation = await getConversation(id, controller.signal);
      if (
        conversationLoadAbortRef.current !== controller ||
        runTokenRef.current !== runToken
      ) {
        return;
      }

      setPhase("ready");
      setSummary(conversation.summary);
      setTranscript(conversation.transcript ?? null);
      setActiveModel(conversation.activeModel);
      setActiveSource(conversation.source);
      setActiveConversationId(conversation.id);
      setMessages(
        conversation.messages.map(({ id: messageId, role, content }) => ({
          id: messageId,
          role,
          content,
        })),
      );
      setProcessingStages([]);
      setStageIndex(-1);
      setStageProgress(0);
      setSelectedVideo(null);
      setQuestion("");
      setIsReplying(false);
      setIsFetchingVideo(false);
      upsertConversationItem(conversation);

      if (conversation.source.kind === "bilibili") {
        const restoredBvid =
          conversation.source.bvid ??
          extractBvid(conversation.source.sourceUrl ?? "");
        setMode("bilibili");
        setBilibiliInput(
          conversation.source.bvid ?? conversation.source.sourceUrl ?? "",
        );
        clearVideoPreview();
        if (restoredBvid) {
          void loadBilibiliConversationPreview(
            conversation.source,
            restoredBvid,
            runToken,
            "restore",
          );
        } else {
          showNotice("已恢复总结和对话，但无法识别原视频的 BV 号。");
        }
      } else if (conversation.source.kind === "url" && conversation.source.sourceUrl) {
        setMode("bilibili");
        setBilibiliInput(conversation.source.sourceUrl);
        showRemoteVideo(conversation.source.sourceUrl);
        setNotice(null);
      } else {
        setMode("upload");
        setBilibiliInput("");
        clearVideoPreview();
        showNotice(
          "总结和对话已恢复；本地原视频不会保存，请重新选择视频后再预览或分析。",
          "success",
        );
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setConversationListError(
        error instanceof Error ? error.message : "无法打开这个对话。",
      );
    } finally {
      if (conversationLoadAbortRef.current === controller) {
        conversationLoadAbortRef.current = null;
        setLoadingConversationId(null);
      }
    }
  }

  function beginRenameConversation(item: ConversationListItem) {
    setRenamingConversationId(item.id);
    setRenameDraft(item.title);
    setConversationListError(null);
  }

  async function saveConversationRename(id: string) {
    const title = renameDraft.trim();
    if (!title) {
      setConversationListError("对话名称不能为空。");
      return;
    }

    setBusyConversationId(id);
    try {
      const renamed = await renameConversation(id, title);
      upsertConversationItem(renamed);
      setRenamingConversationId(null);
      setRenameDraft("");
      setConversationListError(null);
    } catch (error) {
      setConversationListError(
        error instanceof Error ? error.message : "重命名失败，请稍后重试。",
      );
    } finally {
      setBusyConversationId(null);
    }
  }

  async function handleDeleteConversation(item: ConversationListItem) {
    if (!globalThis.confirm(`删除对话“${item.title}”？此操作不可撤销。`)) return;

    setBusyConversationId(item.id);
    setConversationListError(null);
    try {
      await deleteConversation(item.id);
      setConversationItems((current) =>
        current.filter((conversation) => conversation.id !== item.id),
      );
      if (activeConversationId === item.id) resetWorkspace();
    } catch (error) {
      setConversationListError(
        error instanceof Error ? error.message : "删除失败，请稍后重试。",
      );
    } finally {
      setBusyConversationId(null);
    }
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
    pendingReplyRef.current = {
      controller,
      userMessage,
      conversationId: activeConversationId,
    };
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setIsReplying(true);

    try {
      const transcriptContext = transcriptForConversationContext(transcript);
      const result = await askVideo(
        {
          question: trimmed,
          source: activeSource,
          summary,
          ...(transcriptContext
            ? {
                context: {
                  transcript: transcriptContext,
                },
              }
            : {}),
          history: messages.slice(-12).map(({ role, content }) => ({ role, content })),
          reasoningMode: deepThinkingEnabled ? "pro" : "flash",
          webSearchEnabled,
          ...(webSearchEnabled
            ? {
                searchContext: {
                  locale: navigator.language,
                  timeZone:
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                  ...(transcript?.language
                    ? { transcriptLanguage: transcript.language }
                    : {}),
                },
              }
            : {}),
        },
        controller.signal,
      );
      if (askAbortRef.current !== controller) return;
      const assistantMessage: ChatMessage = {
        id: nextMessageId("assistant"),
        role: "assistant",
        content: result.answer,
      };
      setMessages((current) => [
        ...current,
        assistantMessage,
      ]);

      if (activeConversationId) {
        const conversationId = activeConversationId;
        void appendConversationMessages(conversationId, [
          { role: userMessage.role, content: userMessage.content },
          { role: assistantMessage.role, content: assistantMessage.content },
        ])
          .then(() => touchConversationItem(conversationId))
          .catch((error: unknown) => {
            setConversationListError(
              error instanceof Error
                ? `回答已生成，但未保存：${error.message}`
                : "回答已生成，但未能保存到对话历史。",
            );
          });
      }
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
        pendingReplyRef.current = null;
        setIsReplying(false);
      }
    }
  }

  function stopReply() {
    const controller = askAbortRef.current;
    if (!controller) return;

    const pendingReply =
      pendingReplyRef.current?.controller === controller
        ? pendingReplyRef.current
        : null;
    askAbortRef.current = null;
    pendingReplyRef.current = null;
    controller.abort();
    setIsReplying(false);

    if (pendingReply?.conversationId) {
      const { conversationId, userMessage } = pendingReply;
      void appendConversationMessages(conversationId, [
        { role: userMessage.role, content: userMessage.content },
      ])
        .then(() => touchConversationItem(conversationId))
        .catch((error: unknown) => {
          setConversationListError(
            error instanceof Error
              ? `问题已保留在当前页面，但未保存：${error.message}`
              : "问题已保留在当前页面，但未能保存到对话历史。",
          );
        });
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (askAbortRef.current) {
      stopReply();
      return;
    }
    void askQuestion(question);
  }

  const progress =
    processingStages.length > 0
      ? Math.round(
          ((stageIndex + Math.max(0, Math.min(1, stageProgress))) /
            processingStages.length) *
            100,
        )
      : 0;

  restoreConversationRef.current = (id) => {
    void handleSelectConversation(id);
  };

  const shownSource = activeSource ?? pendingSource;
  const activeConversationTitle = activeConversationId
    ? conversationItems.find((item) => item.id === activeConversationId)?.title
    : null;
  const canFetchVideo =
    mode === "bilibili" && pendingSource !== null && pendingSource.kind !== "upload";
  const fetchVideoLabel = directVideoUrl ? "预览视频" : "获取视频";
  const isRestoredLocalConversation =
    phase === "ready" &&
    Boolean(activeConversationId) &&
    activeSource?.kind === "upload";

  function seekToTimeline(time: string) {
    const seconds = timestampToSeconds(time);
    if (seconds === null || !videoPreview) return;
    seekToSeconds(seconds);
  }

  function seekToSeconds(seconds: number) {
    if (!videoPreview) return;
    const player = videoPlayerRef.current;
    if (!player) return;
    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
      if (
        Number.isFinite(player.duration) &&
        (seconds < 0 || seconds >= player.duration)
      ) {
        return;
      }
      player.currentTime = seconds;
      void player.play().catch(() => undefined);
    } else {
      pendingSeekSecondsRef.current = seconds;
      player.load();
    }
    sideVideoPreviewRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    player.focus({ preventScroll: true });
  }

  function renderVideoPreviewCard(placement: "conversation" | "side") {
    if (!videoPreview) return null;
    const details = (
      <div className="video-preview-details">
        <strong>{videoPreview.title ?? videoPreview.filename}</strong>
        <div className="video-preview-meta" aria-label="视频信息">
          {videoPreview.sourceLabel ? <span>{videoPreview.sourceLabel}</span> : null}
          {videoPreview.sizeLabel ? <span>{videoPreview.sizeLabel}</span> : null}
          {videoPreview.durationLabel ? <span>{videoPreview.durationLabel}</span> : null}
          {videoPreview.resolutionLabel ? <span>{videoPreview.resolutionLabel}</span> : null}
        </div>
        {placement === "side" && videoPreview.kind === "local" ? (
          <button
            className="video-preview-change"
            type="button"
            onClick={() => fileInputRef.current?.click()}
          >
            更改
          </button>
        ) : null}
      </div>
    );
    const player = (
      <div className="video-preview-player">
        <video
          ref={videoPlayerRef}
          src={videoPreview.playbackUrl}
          controls
          playsInline
          preload="metadata"
          tabIndex={-1}
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration;
            if (
              videoPreview.kind === "remote" &&
              Number.isFinite(duration) &&
              duration > 0
            ) {
              setVideoPreview((current) =>
                current?.kind === "remote"
                  ? {
                      ...current,
                      durationSeconds: duration,
                      durationLabel: formatDuration(duration),
                    }
                  : current,
              );
            }
            const pendingSeconds = pendingSeekSecondsRef.current;
            if (pendingSeconds !== null) {
              pendingSeekSecondsRef.current = null;
              if (
                pendingSeconds >= 0 &&
                pendingSeconds < event.currentTarget.duration
              ) {
                event.currentTarget.currentTime = pendingSeconds;
                void event.currentTarget.play().catch(() => undefined);
              }
            }
          }}
        >
          当前浏览器无法播放这个视频。
        </video>
      </div>
    );

    return (
      <section
        className={`video-preview-card ${placement}`}
        aria-label="视频预览"
      >
        {placement === "side" ? details : player}
        {placement === "side" ? player : details}
        {placement === "conversation" && videoPreview.description ? (
          <section className="video-preview-description" aria-labelledby="preview-description-title">
            <h3 id="preview-description-title">视频简介</h3>
            {summaryParagraphs(videoPreview.description).map((paragraph, index) => (
              <p key={`preview-description-${index}`}>{paragraph}</p>
            ))}
          </section>
        ) : null}
      </section>
    );
  }

  function renderAnalysisSettings() {
    return (
      <div className="analysis-settings" ref={analysisSettingsRef}>
        <button
          className="analysis-settings-button"
          type="button"
          aria-label="视频分析设置"
          aria-haspopup="dialog"
          aria-expanded={isAnalysisSettingsOpen}
          disabled={phase === "processing" || isFetchingVideo}
          onClick={() => setIsAnalysisSettingsOpen((current) => !current)}
        >
          ⚙
        </button>
        {isAnalysisSettingsOpen ? (
          <section
            className="analysis-settings-popover"
            role="dialog"
            aria-label="视频分析设置"
          >
            <div>
              <strong>视频分析设置</strong>
              <span>只影响下一次生成的总结</span>
            </div>
            <label className="analysis-setting-row">
              <span>
                <strong>字幕提取</strong>
                <small>FunASR Nano＋CT-Punc</small>
              </span>
              <input
                type="checkbox"
                checked={transcriptExtractionEnabled}
                onChange={(event) =>
                  updateTranscriptExtraction(event.target.checked)
                }
              />
              <i aria-hidden="true" />
            </label>
            <details
              className="transcript-language-settings"
              aria-disabled={!transcriptExtractionEnabled}
            >
              <summary>
                <span>
                  <strong>语言选择</strong>
                  <small>
                    {transcriptLanguages.length === 0 ||
                    transcriptLanguages.length ===
                      TRANSCRIPT_LANGUAGE_OPTIONS.length
                      ? "自动识别中、日、英"
                      : `仅保留${TRANSCRIPT_LANGUAGE_OPTIONS.filter(
                          ({ value }) =>
                            transcriptLanguages.includes(value),
                        )
                          .map(({ label }) => label)
                          .join("、")}`}
                  </small>
                </span>
                <span aria-hidden="true">⌄</span>
              </summary>
              <fieldset disabled={!transcriptExtractionEnabled}>
                <legend className="sr-only">选择字幕语言</legend>
                {TRANSCRIPT_LANGUAGE_OPTIONS.map(({ value, label }) => (
                  <label key={value}>
                    <input
                      type="checkbox"
                      checked={transcriptLanguages.includes(value)}
                      onChange={() => toggleTranscriptLanguage(value)}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </fieldset>
              <p>全选或全不选时自动识别三种语言。</p>
            </details>
          </section>
        ) : null}
      </div>
    );
  }

  const workspaceStyle = {
    ...(sidebarWidth === null
      ? {}
      : { "--sidebar-width": `${sidebarWidth}px` }),
    ...(sourcePaneHeight === null
      ? {}
      : { "--source-pane-height": `${sourcePaneHeight}px` }),
  } as CSSProperties;
  const workspaceWidthBounds = sidebarWidthLimits();
  const paneHeightBounds = sourcePaneHeightLimits();

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

        <h1 className="topbar-title">让一段视频，变成一次可继续的对话。</h1>

        <div className="topbar-actions">
          <button
            className="sidebar-visibility-button"
            type="button"
            aria-label={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
            aria-controls="workspace-sidebar"
            aria-expanded={sidebarVisible}
            title={sidebarVisible ? "隐藏侧边栏" : "显示侧边栏"}
            onClick={() => setSidebarVisible((current) => !current)}
          >
            <span className="sidebar-visibility-icon" aria-hidden="true">
              <i />
            </span>
          </button>
          <UserSettingsMenu />
        </div>
      </header>

      <div
        className={`workspace ${sidebarVisible ? "" : "sidebar-hidden"}`}
        id="top"
        ref={workspaceRef}
        style={workspaceStyle}
      >
        <section
          className={`setup-column ${
            sourcePaneCollapsed ? "source-collapsed" : ""
          } ${historyPaneCollapsed ? "history-collapsed" : ""}`}
          id="workspace-sidebar"
          ref={setupColumnRef}
          aria-label="添加视频与历史记录"
        >
          <div
            className={`sidebar-pane source-pane ${
              sourcePaneCollapsed ? "collapsed" : ""
            }`}
          >
            <button
              className="pane-collapse-button source-collapse-button"
              type="button"
              aria-label={sourcePaneCollapsed ? "展开导入板块" : "隐藏导入板块"}
              aria-expanded={!sourcePaneCollapsed}
              onClick={toggleSourcePane}
            >
              <span aria-hidden="true">
                {sourcePaneCollapsed ? "▼" : "▲"}
              </span>
            </button>
            <div className="sidebar-pane-content">
              <div
                className={`source-card ${
                  phase === "ready" && videoPreview ? "showing-side-video" : ""
                }`}
              >
            <div className="mode-tabs" role="tablist" aria-label="选择视频来源">
              <button
                className={mode === "upload" ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={mode === "upload"}
                disabled={phase === "processing" || isFetchingVideo}
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
                disabled={phase === "processing" || isFetchingVideo}
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
                  disabled={phase === "processing"}
                  onChange={handleFileChange}
                  aria-label="选择文件"
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
                    <button
                      type="button"
                      disabled={phase === "processing"}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      选择文件
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
                          const width = event.currentTarget.videoWidth;
                          const height = event.currentTarget.videoHeight;
                          setSelectedVideo((current) =>
                            current
                              ? { ...current, duration, width, height }
                              : current,
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
                        {selectedVideo.width && selectedVideo.height
                          ? ` · ${selectedVideo.width}x${selectedVideo.height}`
                          : ""}
                      </span>
                    </div>
                    <button
                      className="replace-file"
                      type="button"
                      disabled={phase === "processing"}
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
                    disabled={phase === "processing" || isFetchingVideo}
                    onChange={(event) => {
                      setBilibiliInput(event.target.value);
                      clearVideoPreview();
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
                ) : null}

              </div>
            )}

            {notice ? (
              <div
                className={`inline-notice ${notice.tone}`}
                role={notice.tone === "error" ? "alert" : "status"}
              >
                <span aria-hidden="true">{notice.tone === "error" ? "!" : "✓"}</span>
                {notice.message}
              </div>
            ) : null}

            {mode === "bilibili" ? (
              <div className="source-action-row">
                <button
                  className="fetch-video-action"
                  type="button"
                  disabled={!canFetchVideo || phase === "processing" || isFetchingVideo}
                  onClick={() => void handleFetchVideo()}
                >
                  {isFetchingVideo ? (
                    <>
                      <span className="button-spinner" aria-hidden="true" />
                      正在获取
                    </>
                  ) : (
                    <>
                      {fetchVideoLabel}
                      <span aria-hidden="true">▶</span>
                    </>
                  )}
                </button>
                <button
                  className="primary-action source-action-primary"
                  type="button"
                  disabled={!pendingSource || phase === "processing" || isFetchingVideo}
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
                {renderAnalysisSettings()}
              </div>
            ) : !isRestoredLocalConversation ? (
              <div className="source-action-row upload-action-row">
                <button
                  className="primary-action source-action-primary"
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
                {renderAnalysisSettings()}
              </div>
            ) : null}

            {phase === "ready" && videoPreview ? (
              <div className="side-video-context" ref={sideVideoPreviewRef}>
                {renderVideoPreviewCard("side")}
              </div>
            ) : null}
          </div>
            </div>
            <button
              className="diagonal-resizer source-diagonal-resizer"
              type="button"
              aria-label="斜向调整导入板块大小"
              title="斜向调整导入板块大小"
              tabIndex={sourcePaneCollapsed || historyPaneCollapsed ? -1 : 0}
              onPointerDown={(event) => beginResize("diagonal-source", event)}
              onKeyDown={handleDiagonalResizeKeyDown}
              onDoubleClick={() => {
                setSidebarWidth(null);
                setSourcePaneHeight(null);
              }}
            />
          </div>

          <div
            className="pane-resizer"
            role="separator"
            aria-label="调整导入板块与记录板块的高度"
            aria-orientation="horizontal"
            aria-valuemin={paneHeightBounds.min}
            aria-valuemax={paneHeightBounds.max}
            aria-valuenow={
              sourcePaneHeight ??
              setupColumnRef.current?.firstElementChild?.getBoundingClientRect()
                .height ??
              paneHeightBounds.min
            }
            tabIndex={sourcePaneCollapsed || historyPaneCollapsed ? -1 : 0}
            onPointerDown={(event) => beginResize("rows", event)}
            onKeyDown={handlePaneResizeKeyDown}
            onDoubleClick={() => setSourcePaneHeight(null)}
          />

          <div
            className={`sidebar-pane history-pane ${
              historyPaneCollapsed ? "collapsed" : ""
            }`}
          >
            <div className="sidebar-pane-content">
              <aside className="conversation-library" aria-label="视频对话列表">
            <div className="conversation-library-header">
              <div>
                <span>历史记录</span>
                <h2>视频对话</h2>
              </div>
              <button
                className="conversation-new-button"
                type="button"
                onClick={resetWorkspace}
                disabled={phase === "processing"}
              >
                <span aria-hidden="true">＋</span>
                新建
              </button>
            </div>

            {conversationListError ? (
              <p className="conversation-library-error" role="status">
                {conversationListError}
              </p>
            ) : null}

            <div className="conversation-list">
              {isConversationListLoading ? (
                <div className="conversation-list-state">
                  <span className="button-spinner" aria-hidden="true" />
                  正在读取对话…
                </div>
              ) : conversationItems.length === 0 ? (
                <div className="conversation-list-state empty">
                  <strong>还没有视频对话</strong>
                  <span>完成一次总结后，会自动保存在这里。</span>
                </div>
              ) : (
                conversationItems.map((item) => (
                  <div
                    className={`conversation-list-item ${
                      item.id === activeConversationId ? "active" : ""
                    }`}
                    key={item.id}
                  >
                    {renamingConversationId === item.id ? (
                      <form
                        className="conversation-rename-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void saveConversationRename(item.id);
                        }}
                      >
                        <label className="sr-only" htmlFor={`rename-${item.id}`}>
                          重命名对话
                        </label>
                        <input
                          id={`rename-${item.id}`}
                          value={renameDraft}
                          maxLength={120}
                          autoFocus
                          disabled={busyConversationId === item.id}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              setRenamingConversationId(null);
                              setRenameDraft("");
                            }
                          }}
                        />
                        <button type="submit" disabled={busyConversationId === item.id}>
                          保存
                        </button>
                        <button
                          type="button"
                          disabled={busyConversationId === item.id}
                          onClick={() => {
                            setRenamingConversationId(null);
                            setRenameDraft("");
                          }}
                        >
                          取消
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          className="conversation-select-button"
                          type="button"
                          disabled={
                            phase === "processing" ||
                            busyConversationId === item.id ||
                            loadingConversationId === item.id
                          }
                          onClick={() => void handleSelectConversation(item.id)}
                        >
                          <span className="conversation-item-title">{item.title}</span>
                          <span className="conversation-item-meta">
                            <b>{sourceKindLabel(item.sourceKind)}</b>
                            <time dateTime={new Date(item.updatedAt).toISOString()}>
                              {formatConversationDate(item.updatedAt)}
                            </time>
                          </span>
                        </button>
                        <div className="conversation-item-actions">
                          <button
                            type="button"
                            aria-label={`重命名“${item.title}”`}
                            title="重命名"
                            disabled={phase === "processing" || busyConversationId === item.id}
                            onClick={() => beginRenameConversation(item)}
                          >
                            ✎
                          </button>
                          <button
                            className="delete"
                            type="button"
                            aria-label={`删除“${item.title}”`}
                            title="删除"
                            disabled={phase === "processing" || busyConversationId === item.id}
                            onClick={() => void handleDeleteConversation(item)}
                          >
                            ×
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </div>
              </aside>
            </div>
            <button
              className="diagonal-resizer history-diagonal-resizer"
              type="button"
              aria-label="斜向调整记录板块大小"
              title="斜向调整记录板块大小"
              tabIndex={sourcePaneCollapsed || historyPaneCollapsed ? -1 : 0}
              onPointerDown={(event) => beginResize("diagonal-history", event)}
              onKeyDown={handleDiagonalResizeKeyDown}
              onDoubleClick={() => {
                setSidebarWidth(null);
                setSourcePaneHeight(null);
              }}
            />
            <button
              className="pane-collapse-button history-collapse-button"
              type="button"
              aria-label={
                historyPaneCollapsed ? "展开记录板块" : "隐藏记录板块"
              }
              aria-expanded={!historyPaneCollapsed}
              onClick={toggleHistoryPane}
            >
              <span aria-hidden="true">
                {historyPaneCollapsed ? "▲" : "▼"}
              </span>
            </button>
          </div>
        </section>

        <div
          className="workspace-resizer"
          role="separator"
          aria-label="调整侧边栏与对话板块的宽度"
          aria-orientation="vertical"
          aria-valuemin={workspaceWidthBounds.min}
          aria-valuemax={workspaceWidthBounds.max}
          aria-valuenow={
            sidebarWidth ??
            setupColumnRef.current?.getBoundingClientRect().width ??
            workspaceWidthBounds.min
          }
          tabIndex={sidebarVisible ? 0 : -1}
          onPointerDown={(event) => beginResize("columns", event)}
          onKeyDown={handleWorkspaceResizeKeyDown}
          onDoubleClick={() => setSidebarWidth(null)}
        />

        <section className="conversation-panel" aria-labelledby="conversation-title">
          <div className="conversation-header">
            <div>
              <h2 id="conversation-title">
                {activeConversationTitle ?? shownSource?.title ?? "等待添加视频"}
              </h2>
              {shownSource?.kind !== "upload" ? (
                <p>
                  {shownSource?.subtitle ??
                    "总结生成后，可在这里围绕视频继续提问"}
                </p>
              ) : null}
            </div>
            <span className={`phase-badge ${phase}`}>
              {phase === "processing"
                  ? "处理中"
                : phase === "ready"
                  ? "对话"
                  : phase === "error"
                    ? "需重试"
                    : "未开始"}
            </span>
          </div>

          <div className="conversation-scroll" aria-live="polite">
            {videoPreview && phase !== "ready"
              ? renderVideoPreviewCard("conversation")
              : null}

            {(phase === "idle" || phase === "error") && !videoPreview ? (
              <div className="empty-state">
                <div className="empty-orbit" aria-hidden="true">
                  <span>✦</span>
                </div>
                <span className="empty-label">SUMMARY SPACE</span>
                <h3>视频内容，会在这里沉淀下来。</h3>
                <div className="empty-capabilities" aria-label="可生成的内容">
                  <span>内容概览</span>
                  <span>时间线</span>
                  <span>要点分析</span>
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
                  视频理解可能需要几分钟；处理完成前请保持当前页面打开。长时间无进展时可取消后重试。
                </div>
                <div className="processing-actions">
                  <button type="button" onClick={resetWorkspace}>
                    取消处理
                  </button>
                </div>
              </div>
            ) : null}

            {phase === "ready" && summary && activeSource ? (
              <div className="ready-view">
                <article className="summary-document">
                  <div className="summary-title-row">
                    <div>
                      <span className="section-label">AI 视频总结</span>
                      <h3>{summary.title}</h3>
                    </div>
                  </div>

                  <div className="summary-stats">
                    <span>
                      <strong>{timelineItems.length}</strong> 个时间点
                    </span>
                    <span>
                      <strong>{activeModel ?? "Qwen"}</strong> 分析引擎
                    </span>
                  </div>

                  {activeSource.description ? (
                    <section className="summary-section video-description-section">
                      <h4>视频简介</h4>
                      <div className="overview-copy">
                        {summaryParagraphs(activeSource.description).map(
                          (paragraph) => (
                            <p key={paragraph}>{paragraph}</p>
                          ),
                        )}
                      </div>
                    </section>
                  ) : null}

                  <section className="summary-section">
                    <h4>内容概览</h4>
                    <div className="overview-copy">
                      {overviewParagraphs.map((paragraph) => (
                        <p key={paragraph}>{paragraph}</p>
                      ))}
                    </div>
                  </section>

                  <section className="summary-section">
                    <h4>时间线</h4>
                    <div className="timeline-list">
                      {timelineItems.map((item) => (
                        <div className="timeline-row" key={item.key}>
                          <button
                            className="timeline-seek"
                            type="button"
                            disabled={
                              !videoPreview || timestampToSeconds(item.time) === null
                            }
                            onClick={() => seekToTimeline(item.time)}
                            aria-label={`跳转到 ${item.time}`}
                          >
                            <time>{item.time}</time>
                          </button>
                          <div>
                            <strong>{item.title}</strong>
                            <p>{item.detail}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>

                  {transcript ? (
                    <section className="summary-section transcript-section">
                      <div className="transcript-heading">
                        <h4>字幕</h4>
                        <span>FunASR</span>
                      </div>
                      {transcript.status === "ready" ? (
                        transcript.cues.length > 0 ? (
                          <div className="transcript-list">
                            {transcript.cues.map((cue, index) => (
                              <div
                                className="transcript-row"
                                key={`${cue.startSeconds}-${index}`}
                              >
                                <button
                                  type="button"
                                  disabled={!videoPreview}
                                  onClick={() => seekToSeconds(cue.startSeconds)}
                                  aria-label={`跳转到 ${formatPlaybackTimestamp(
                                    cue.startSeconds,
                                  )}`}
                                >
                                  {formatPlaybackTimestamp(cue.startSeconds)}
                                </button>
                                <p>{cue.text}</p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="transcript-copy">{transcript.text}</p>
                        )
                      ) : (
                        <p className="transcript-unavailable">
                          {transcript.error ?? "没有识别到可显示的字幕。"}
                        </p>
                      )}
                    </section>
                  ) : null}
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
                        <MarkdownMessage content={message.content} />
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
              <div className="conversation-tool-row" aria-label="对话工具">
                <button
                  type="button"
                  aria-pressed={deepThinkingEnabled}
                  onClick={() =>
                    updateChatSetting(
                      "deepThinking",
                      !deepThinkingEnabled,
                    )
                  }
                >
                  <span aria-hidden="true">✦</span>
                  深度思考
                </button>
                <button
                  type="button"
                  aria-pressed={webSearchEnabled}
                  onClick={() =>
                    updateChatSetting("webSearch", !webSearchEnabled)
                  }
                >
                  <span aria-hidden="true">◎</span>
                  联网搜索
                </button>
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
                    if (askAbortRef.current) {
                      stopReply();
                      return;
                    }
                    void askQuestion(question);
                  }
                }}
                placeholder={
                  phase === "ready"
                    ? "问问视频里的细节…"
                    : "总结生成后即可继续提问"
                }
                disabled={phase !== "ready"}
              />
              <button
                type="submit"
                className={isReplying ? "stop-generation" : undefined}
                disabled={phase !== "ready" || (!isReplying && !question.trim())}
                aria-label={isReplying ? "停止生成" : "发送问题"}
                title={isReplying ? "停止生成" : undefined}
              >
                {isReplying ? (
                  <span className="composer-stop-icon" aria-hidden="true" />
                ) : (
                  "↑"
                )}
              </button>
            </form>
            <p className="composer-caption">AI 结果可能有误，请结合原视频核对重要信息。</p>
          </div>
        </section>
      </div>
    </main>
  );
}
