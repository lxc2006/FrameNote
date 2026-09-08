import {
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components as MarkdownComponents,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import {
  extractBvid,
  formatDuration,
  formatFileSize,
  type VideoTranscript,
  type TranscriptLanguage,
  type VideoModelContext,
  type VideoSourceDescriptor,
  type VideoSummary,
} from "@/shared/media-types";
import {
  ModelClientError,
  analyzeVideo,
  askVideo,
} from "../../clients/model-client";
import {
  downloadBilibiliVideo,
  releaseBilibiliAnalysis,
} from "../../clients/bilibili-client";
import {
  preparePlatformVideoPreview,
  type PlatformVideoPreview,
} from "../../clients/platform-video-client";
import {
  prepareMediaAnalysis,
  releaseMediaAnalysis,
} from "../../clients/media-analysis-client";
import { extractOnlineTranscript } from "../../clients/transcription-client";
import { openLocalVideo, releaseLocalVideo, videoFilesApi } from "../../clients/video-files-client";
import { desktopBridge, unwrapDesktopResult } from "../../clients/desktop-bridge";
import type { VideoDownloadInput } from "@/shared/video-files";
import {
  advanceDisplayedProgress,
  estimatedStageProgress,
} from "../../clients/analysis-progress";
import AnalysisProgress from "../AnalysisProgress";
import {
  parseVideoTimeHref,
  prepareMarkdownContent,
} from "../../clients/markdown-content";
import {
  appendConversationMessages,
  createConversation,
  getConversation,
  truncateConversationMessages,
  updateConversationTranscript as saveConversationTranscript,
} from "../../clients/conversation-client";
import type {
  ConversationListItem,
  ConversationMessage,
  ConversationMessageInput,
} from "@/shared/conversation-types";
import type { ConversationUsageRecord } from "@/shared/model-usage";
import UserSettingsMenu, {
  DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
  parseUserPreferences,
  USER_PREFERENCES_CHANGE_EVENT,
  USER_PREFERENCES_STORAGE_KEY,
} from "../UserSettingsMenu";
import UsageGuide from "../UsageGuide";
import SourcePanel, {
  type InlineNotice,
  type InputMode,
  type SelectedVideo,
  type WorkbenchPhase,
} from "./SourcePanel";
import VideoPreviewCard, {
  type VideoPreviewModel,
} from "./VideoPreview";
import { useBatchedMessageUpdate } from "../../hooks/useBatchedMessageUpdate";
import { useClipboardCandidate } from "../../hooks/useClipboardCandidate";
import { useConversationHistory } from "../../hooks/useConversationHistory";
import { useVideoPlayer } from "../../hooks/useVideoPlayer";

type Phase = WorkbenchPhase;
type VideoPreview = VideoPreviewModel;

type BranchStatus = "waiting" | "running" | "complete" | "failed" | "skipped";
interface AnalysisBranch {
  status: BranchStatus;
  progress: number;
  completedChunks?: number;
  totalChunks?: number;
}
type AnalysisBranches = Record<"summary" | "transcript", AnalysisBranch>;
const initialBranches = (): AnalysisBranches => ({
  summary: { status: "waiting", progress: 0 },
  transcript: { status: "waiting", progress: 0 },
});

async function selectedVideoFile(video: SelectedVideo, signal: AbortSignal) {
  if (video.file) return video.file;
  if (video.size > MAX_MEDIA_ANALYSIS_BYTES) throw new Error("当前视频分析支持不超过 500 MB 的文件。");
  const response = await fetch(video.objectUrl, { signal });
  if (!response.ok) throw new Error(`找不到本地视频：${video.localPath}`);
  const blob = await response.blob();
  if (blob.size > MAX_MEDIA_ANALYSIS_BYTES) throw new Error("当前视频分析支持不超过 500 MB 的文件。");
  return new File([blob], video.name, { type: blob.type, lastModified: video.lastModified });
}

type ChatMessage = Pick<
  ConversationMessage,
  | "id"
  | "role"
  | "content"
  | "reasoningContent"
  | "reasoningDurationSeconds"
  | "webSources"
  | "webSearch"
  | "stopped"
  | "createdAt"
  | "usage"
> & {
  isStreaming?: boolean;
  streamLabel?: string;
};

function conversationMessageForStorage(
  message: ChatMessage,
): ConversationMessageInput {
  return {
    role: message.role,
    content: message.content,
    ...(message.reasoningContent
      ? { reasoningContent: message.reasoningContent }
      : {}),
    ...(message.reasoningDurationSeconds !== undefined
      ? { reasoningDurationSeconds: message.reasoningDurationSeconds }
      : {}),
    ...(message.webSources?.length ? { webSources: message.webSources } : {}),
    ...(message.webSearch ? { webSearch: message.webSearch } : {}),
    ...(message.stopped ? { stopped: true } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
  };
}

const acceptedExtensions = ["mp4", "mov", "webm", "mkv", "m4v"];
function unavailableOnlineTranscript(
  languages: TranscriptLanguage[],
  error: unknown,
): VideoTranscript {
  return {
    status: "unavailable",
    text: "",
    cues: [],
    language: languages.length > 0 ? languages.join(",") : "auto",
    error:
      error instanceof Error
        ? `在线字幕识别失败：${error.message}`
        : "在线字幕识别失败，视频总结仍会继续。",
  };
}
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
const MIN_CONVERSATION_WIDTH = 600;
const WORKSPACE_RESIZER_SIZE = 10;

interface StoredWorkspaceLayout {
  sidebarVisible?: boolean;
  sidebarWidth?: number | null;
}

interface WorkspaceMeasurements {
  workspaceWidth: number;
  sidebarWidth: number;
}

const DEFAULT_WORKSPACE_MEASUREMENTS: WorkspaceMeasurements = {
  workspaceWidth:
    MIN_SIDEBAR_WIDTH + MIN_CONVERSATION_WIDTH + WORKSPACE_RESIZER_SIZE,
  sidebarWidth: MIN_SIDEBAR_WIDTH,
};

function sidebarWidthLimitsFor(workspaceWidth: number) {
  return {
    min: MIN_SIDEBAR_WIDTH,
    max: Math.max(
      MIN_SIDEBAR_WIDTH,
      workspaceWidth - MIN_CONVERSATION_WIDTH - WORKSPACE_RESIZER_SIZE,
    ),
  };
}

function clampTo(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
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

function douyinShareUrl(value: string) {
  const candidate = value.match(/https:\/\/[^\s]+/i)?.[0] ?? value.trim();
  const cleaned = candidate.replace(/[，。！？；、）》】」』]+$/u, "");
  try {
    const url = new URL(cleaned);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (hostname !== "douyin.com" && !hostname.endsWith(".douyin.com"))
    ) {
      return null;
    }
    return url.href;
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
  if (kind === "douyin") return "抖音";
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

function formatUsageTokens(tokens: number) {
  return new Intl.NumberFormat("zh-CN").format(tokens);
}

function formatCompactUsageTokens(tokens: number) {
  return new Intl.NumberFormat("zh-CN", {
    notation: tokens >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(tokens);
}

function formatUsageTime(timestamp: number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatAnswerTime(timestamp: number) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][date.getMonth()];
  const year =
    date.getFullYear() === new Date().getFullYear()
      ? ""
      : `${date.getFullYear()} `;
  return `${year}${month} ${date.getDate()}, ${date.getHours()}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function currentTimestamp() {
  return Date.now();
}

function usageTotals(records: ConversationUsageRecord[]) {
  return records.reduce(
    (total, record) => ({
      totalTokens: total.totalTokens + record.totalTokens,
      searchCount: total.searchCount + record.searchCount,
    }),
    { totalTokens: 0, searchCount: 0 },
  );
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

function formatTimelineTimestamp(value: string) {
  const seconds = timestampToSeconds(value);

  return seconds === null
    ? value
    : formatPlaybackTimestamp(seconds);
}

function VideoTimeButton({
  seconds,
  label,
  onVideoTimeClick,
}: {
  seconds: number;
  label: string;
  onVideoTimeClick?: (seconds: number) => void;
}) {
  return (
    <button
      className="message-video-time"
      type="button"
      disabled={!onVideoTimeClick}
      onClick={() => onVideoTimeClick?.(seconds)}
      aria-label={`跳转到视频 ${label}`}
      title={onVideoTimeClick ? `跳转到视频 ${label}` : "视频预览尚未恢复"}
    >
      {label}
    </button>
  );
}

function safeMarkdownUrl(url: string) {
  if (parseVideoTimeHref(url) !== null) return url;
  const transformed = defaultUrlTransform(url);
  return /^https?:\/\//i.test(transformed) ? transformed : "";
}

const LONG_MESSAGE_CHARACTER_LIMIT = 8_000;
const LONG_MESSAGE_BLOCK_LIMIT = 30;
const markdownBlockProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkStringify);

function markdownBlockPreview(content: string) {
  const tree = markdownBlockProcessor.parse(content);
  if (tree.children.length <= LONG_MESSAGE_BLOCK_LIMIT) {
    return { content, truncated: false };
  }
  return {
    content: markdownBlockProcessor.stringify({
      ...tree,
      children: tree.children.slice(0, LONG_MESSAGE_BLOCK_LIMIT),
    }),
    truncated: true,
  };
}

function MarkdownMessage({
  content,
  onVideoTimeClick,
  isCompleted,
  isExpanded,
  onToggleExpanded,
}: {
  content: string;
  onVideoTimeClick?: (seconds: number) => void;
  isCompleted: boolean;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  const markdown = useMemo(() => prepareMarkdownContent(content), [content]);
  const preview = useMemo(
    () =>
      isCompleted && content.length > LONG_MESSAGE_CHARACTER_LIMIT
        ? markdownBlockPreview(markdown)
        : { content: markdown, truncated: false },
    [content.length, isCompleted, markdown],
  );
  const components = useMemo<MarkdownComponents>(
    () => ({
      a({ href, children }) {
        const seconds = parseVideoTimeHref(href);
        if (seconds !== null) {
          return (
            <VideoTimeButton
              seconds={seconds}
              label={String(children)}
              onVideoTimeClick={onVideoTimeClick}
            />
          );
        }
        if (!href || !/^https?:\/\//i.test(href)) {
          return <span>{children}</span>;
        }
        const label = String(children);
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {/^\d{1,2}$/.test(label) ? `[${label}]` : children}
          </a>
        );
      },
      img({ alt }) {
        return <span>{alt ?? ""}</span>;
      },
    }),
    [onVideoTimeClick],
  );

  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {preview.truncated && !isExpanded ? preview.content : markdown}
      </ReactMarkdown>
      {preview.truncated ? (
        <button
          className="message-expand-button"
          type="button"
          aria-expanded={isExpanded}
          onClick={onToggleExpanded}
        >
          {isExpanded ? "收起" : "展开全文"}
        </button>
      ) : null}
    </div>
  );
}

function ReasoningPanel({
  content,
  durationSeconds,
  isStreaming,
  hasAnswer,
}: {
  content: string;
  durationSeconds?: number;
  isStreaming?: boolean;
  hasAnswer: boolean;
}) {
  return (
    <details
      key={`${isStreaming ? "streaming" : "complete"}-${hasAnswer ? "answer" : "thought"}`}
      className="message-reasoning"
      open={isStreaming && !hasAnswer ? true : undefined}
    >
      <summary>
        <span aria-hidden="true">✦</span>
        {isStreaming && !hasAnswer
          ? "正在深度思考…"
          : `已深度思考 ${durationSeconds ?? 1} 秒`}
        <span className="message-disclosure" aria-hidden="true">⌄</span>
      </summary>
      <div>{content}</div>
    </details>
  );
}

function WebSourcesPanel({
  sources,
}: {
  sources: NonNullable<ChatMessage["webSources"]>;
}) {
  return (
    <details className="message-web-sources">
      <summary>
        已取得 {sources.length} 个网页证据
        <span className="message-disclosure" aria-hidden="true">⌄</span>
      </summary>
      <div className="message-web-source-list">
        {sources.map((source) => (
          <a
            key={`${source.index}-${source.url}`}
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span>[{source.index}]</span>
            {source.title}
          </a>
        ))}
      </div>
    </details>
  );
}

function WebSearchStatusPanel({
  search,
}: {
  search: NonNullable<ChatMessage["webSearch"]>;
}) {
  const title = search.requestIssued
    ? "已发起搜索，但未取得可读网页"
    : "联网搜索未发起";
  return (
    <details className="message-web-sources message-web-search-status">
      <summary>
        {title}
        <span className="message-disclosure" aria-hidden="true">⌄</span>
      </summary>
      <div className="message-web-search-details">
        {search.query ? <p>关键词：{search.query}</p> : null}
        <p>
          候选结果 {search.candidateCount} 个，正文提取失败 {search.extractionFailureCount} 个
        </p>
        {search.note ? <p>说明：{search.note}</p> : null}
        {search.failures.length ? (
          <p>失败原因：{search.failures.map((failure) => failure.message).slice(0, 3).join("；")}</p>
        ) : null}
      </div>
    </details>
  );
}

function previewResolutionLabel(result: { width?: number; height?: number }) {
  return result.width && result.height ? `${result.width}x${result.height}` : undefined;
}

async function downloadRemoteVideoFile(
  url: string,
  signal?: AbortSignal,
  filename?: string,
) {
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
  return new File([blob], filename || titleFromUrl(url), {
    type: blob.type || "video/mp4",
    lastModified: Date.now(),
  });
}

function readVideoMetadata(objectUrl: string, signal?: AbortSignal) {
  return new Promise<{ duration: number; width: number; height: number }>(
    (resolve, reject) => {
      const video = document.createElement("video");
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        video.onloadedmetadata = null;
        video.onerror = null;
        video.removeAttribute("src");
        video.load();
        callback();
      };
      const onAbort = () =>
        finish(() =>
          reject(new DOMException("视频读取已取消。", "AbortError")),
        );
      const timer = window.setTimeout(() => finish(() => reject(new Error("视频信息读取超时。"))), 15_000);
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
        : source.kind === "douyin"
          ? "读取抖音分享视频"
          : "下载 B站分析视频";
  return [
    firstStage,
    source.kind === "bilibili"
      ? "准备约 480p 分析视频"
      : source.kind === "douyin"
        ? "准备抖音分析视频"
        : "压缩为约 480p 分析视频",
    "按时长准备完整视频或关键帧",
    transcriptEnabled ? "字幕识别与视频总结" : "Qwen 理解画面与声音",
    "保存总结与对话",
  ];
}

export default function VideoWorkbench() {
  const [mode, setMode] = useState<InputMode>("upload");
  const [selectedVideo, setSelectedVideo] = useState<SelectedVideo | null>(null);
  const [bilibiliInput, setBilibiliInput] = useState("");
  const [douyinInput, setDouyinInput] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [summary, setSummary] = useState<VideoSummary | null>(null);
  const [activeSource, setActiveSource] = useState<VideoSourceDescriptor | null>(null);
  const [processingStages, setProcessingStages] = useState<string[]>([]);
  const [stageIndex, setStageIndex] = useState(-1);
  const [stageProgress, setStageProgress] = useState(0);
  const [analysisBranches, setAnalysisBranches] = useState<AnalysisBranches>(initialBranches);
  const [downloadRequestId, setDownloadRequestId] = useState<string | null>(null);
  const downloadRequestRef = useRef<string | null>(null);
  const fileSelectionTokenRef = useRef(0);
  const [displayedProgress, setDisplayedProgress] = useState(0);
  const [processingDurationSeconds, setProcessingDurationSeconds] =
    useState<number | null>(null);
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
  const [fullRecallEnabled, setFullRecallEnabled] = useState(false);
  const [isUsageMenuOpen, setIsUsageMenuOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [expandedMessageIds, setExpandedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [resendingMessageId, setResendingMessageId] = useState<string | null>(
    null,
  );
  const [isAnalysisSettingsOpen, setIsAnalysisSettingsOpen] = useState(false);
  const [isFetchingVideo, setIsFetchingVideo] = useState(false);
  const [isExtractingTranscript, setIsExtractingTranscript] = useState(false);
  const [transcriptExtractionProgress, setTranscriptExtractionProgress] =
    useState<number | null>(null);
  const [transcriptChunkProgress, setTranscriptChunkProgress] = useState<{
    completedChunks: number;
    totalChunks: number;
  } | null>(null);
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [workspaceLayoutReady, setWorkspaceLayoutReady] = useState(false);
  const [workspaceMeasurements, setWorkspaceMeasurements] =
    useState<WorkspaceMeasurements>(DEFAULT_WORKSPACE_MEASUREMENTS);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runTokenRef = useRef(0);
  const messageCounterRef = useRef(0);
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const fetchVideoAbortRef = useRef<AbortController | null>(null);
  const transcriptAbortRef = useRef<AbortController | null>(null);
  const transcriptProgressStartedAtRef = useRef(0);
  const askAbortRef = useRef<AbortController | null>(null);
  const pendingReplyRef = useRef<{
    controller: AbortController;
    userMessage: ChatMessage;
    assistantMessage: ChatMessage;
    conversationId: string | null;
    reasoningStartedAt?: number;
    reasoningLastAt?: number;
  } | null>(null);
  const conversationLoadAbortRef = useRef<AbortController | null>(null);
  const targetProgressRef = useRef(0);
  const sideVideoPreviewRef = useRef<HTMLDivElement>(null);
  const analysisSettingsRef = useRef<HTMLDivElement>(null);
  const usageMenuRef = useRef<HTMLDivElement>(null);
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const transcriptListRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const [messageListOffset, setMessageListOffset] = useState(0);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const setupColumnRef = useRef<HTMLElement>(null);
  const activeResizeCleanupRef = useRef<(() => void) | null>(null);
  const {
    playerRef: videoPlayerRef,
    isFullscreen: isVideoFullscreen,
    toggleFullscreen: toggleVideoFullscreen,
    handleClick: handleVideoClick,
    handleDoubleClick: handleVideoDoubleClick,
    syncAudio: syncPreviewAudio,
    seek: seekVideoPlayer,
    handleLoadedMetadata: applyPendingVideoSeek,
    reset: resetVideoPlayer,
  } = useVideoPlayer();
  const {
    items: conversationItems,
    isLoading: isConversationListLoading,
    error: conversationListError,
    setError: setConversationListError,
    loadingId: loadingConversationId,
    setLoadingId: setLoadingConversationId,
    busyId: busyConversationId,
    renamingId: renamingConversationId,
    setRenamingId: setRenamingConversationId,
    renameDraft,
    setRenameDraft,
    isOpen: isHistoryMenuOpen,
    setIsOpen: setIsHistoryMenuOpen,
    menuRef: historyMenuRef,
    buttonRef: historyButtonRef,
    upsert: upsertConversationItem,
    touch: touchConversationItem,
    beginRename: beginRenameConversation,
    saveRename: saveConversationRename,
    deleteItem: handleDeleteConversation,
  } = useConversationHistory({
    activeConversationId,
    onRestoreConversation: (id) => void handleSelectConversation(id),
    onActiveConversationDeleted: resetWorkspace,
  });
  const applyStreamMessage = useCallback((nextMessage: ChatMessage) => {
    setMessages((current) =>
      current.map((message) =>
        message.id === nextMessage.id ? nextMessage : message,
      ),
    );
  }, []);
  const {
    schedule: scheduleStreamMessageUpdate,
    cancel: cancelStreamMessageUpdate,
  } = useBatchedMessageUpdate(applyStreamMessage, 80);

  const bvid = useMemo(() => extractBvid(bilibiliInput), [bilibiliInput]);
  const shouldExtractTranscript = transcriptExtractionEnabled;
  const directVideoUrl = useMemo(
    () => publicVideoUrl(bilibiliInput),
    [bilibiliInput],
  );
  const douyinUrl = useMemo(() => douyinShareUrl(douyinInput), [douyinInput]);
  const overviewParagraphs = useMemo(
    () => (summary ? summaryParagraphs(summary.overview) : []),
    [summary],
  );
  const timelineItems = useMemo(
    () => (summary ? summaryTimeline(summary) : []),
    [summary],
  );
  const usageRecords = useMemo(
    () =>
      messages.flatMap((message) =>
        message.role === "assistant" && message.usage
          ? [{ messageId: message.id, usage: message.usage }]
          : [],
      ),
    [messages],
  );
  const conversationUsageTotals = useMemo(
    () => usageTotals(usageRecords.map(({ usage }) => usage)),
    [usageRecords],
  );
  const lastAssistantMessageId = useMemo(
    () =>
      messages.findLast((message) => message.role === "assistant")?.id ?? null,
    [messages],
  );
  const transcriptCues =
    transcript?.status === "ready" ? transcript.cues : [];
  const transcriptVirtualizer = useVirtualizer({
    count: transcriptCues.length,
    getScrollElement: () => transcriptListRef.current,
    estimateSize: () => 64,
    getItemKey: (index) =>
      `${transcriptCues[index]?.startSeconds ?? "cue"}-${index}`,
    overscan: 8,
    enabled: phase === "ready" && transcriptCues.length > 0,
  });
  const messageVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => conversationScrollRef.current,
    estimateSize: (index) =>
      messages[index]?.role === "assistant" ? 300 : 110,
    getItemKey: (index) => messages[index]?.id ?? index,
    overscan: 4,
    scrollMargin: messageListOffset,
    enabled: phase === "ready",
  });

  useLayoutEffect(() => {
    const scroller = conversationScrollRef.current;
    const list = messageListRef.current;
    if (!scroller || !list || phase !== "ready") return;
    const updateOffset = () => {
      setMessageListOffset(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    };
    updateOffset();
    const observer = new ResizeObserver(updateOffset);
    if (list.parentElement) observer.observe(list.parentElement);
    return () => observer.disconnect();
  }, [messages.length, phase, summary]);

  useEffect(() => {
    if (!isUsageMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !usageMenuRef.current?.contains(event.target)
      ) {
        setIsUsageMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [isUsageMenuOpen]);

  useEffect(() => {
    if (!isExtractingTranscript || transcriptChunkProgress) return;
    const durationSeconds =
      videoPreview?.durationSeconds ?? processingDurationSeconds;
    const timer = window.setInterval(() => {
      const estimate = estimatedStageProgress(
        "transcript",
        performance.now() - transcriptProgressStartedAtRef.current,
        durationSeconds,
        0.04,
      );
      setTranscriptExtractionProgress((current) =>
        Math.max(current ?? 0, estimate),
      );
    }, 400);
    return () => window.clearInterval(timer);
  }, [
    isExtractingTranscript,
    processingDurationSeconds,
    transcriptChunkProgress,
    videoPreview?.durationSeconds,
  ]);

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

  useClipboardCandidate((candidate) => {
      const preferences = parseUserPreferences(
        window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY) ?? "",
      );
      if (
        !preferences.autoDetectClipboardLinks ||
        phase === "processing" ||
        isFetchingVideo
      ) {
        return;
      }
      clearVideoPreview();
      if (candidate.kind === "douyin") {
        setMode("douyin");
        setDouyinInput(candidate.value);
        setBilibiliInput("");
        showNotice("已从剪贴板填入抖音分享链接。", "success");
      } else {
        setMode("bilibili");
        setBilibiliInput(candidate.value);
        setDouyinInput("");
        showNotice(
          candidate.kind === "remote"
            ? "已从剪贴板填入视频直链。"
            : "已从剪贴板填入 B站视频。",
          "success",
        );
      }
  });

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
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
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(CHAT_SETTINGS_STORAGE_KEY);
        if (!stored) return;
        const parsed = JSON.parse(stored) as {
          deepThinking?: unknown;
          webSearch?: unknown;
          fullRecall?: unknown;
        };
        if (typeof parsed.deepThinking === "boolean") {
          setDeepThinkingEnabled(parsed.deepThinking);
        }
        if (typeof parsed.webSearch === "boolean") {
          setWebSearchEnabled(parsed.webSearch);
        }
        if (typeof parsed.fullRecall === "boolean") {
          setFullRecallEnabled(parsed.fullRecall);
        }
      } catch {
        setDeepThinkingEnabled(false);
        setWebSearchEnabled(false);
        setFullRecallEnabled(false);
      }
    });
    return () => window.cancelAnimationFrame(frame);
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
    const frame = window.requestAnimationFrame(() => {
      try {
        const stored = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as StoredWorkspaceLayout;
          if (typeof parsed.sidebarVisible === "boolean") {
            setSidebarVisible(parsed.sidebarVisible);
          }
          if (typeof parsed.sidebarWidth === "number") {
            const workspaceWidth =
              workspaceRef.current?.getBoundingClientRect().width ??
              DEFAULT_WORKSPACE_MEASUREMENTS.workspaceWidth;
            const { min, max } = sidebarWidthLimitsFor(workspaceWidth);
            setSidebarWidth(clampTo(parsed.sidebarWidth, min, max));
          }
        }
      } catch {
        // 损坏的本地布局设置直接回退到默认布局。
      } finally {
        setWorkspaceLayoutReady(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!workspaceLayoutReady) return;
    const saveTimer = window.setTimeout(() => {
      try {
        const layout: StoredWorkspaceLayout = {
          sidebarVisible,
          sidebarWidth,
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
    sidebarVisible,
    sidebarWidth,
    workspaceLayoutReady,
  ]);

  useEffect(() => {
    let measureFrame: number | null = null;
    const measureLayout = () => {
      measureFrame = null;
      const workspaceWidth =
        workspaceRef.current?.getBoundingClientRect().width ??
        DEFAULT_WORKSPACE_MEASUREMENTS.workspaceWidth;
      const measuredSidebarWidth =
        setupColumnRef.current?.getBoundingClientRect().width ??
        DEFAULT_WORKSPACE_MEASUREMENTS.sidebarWidth;
      const widthLimits = sidebarWidthLimitsFor(workspaceWidth);

      setWorkspaceMeasurements((current) => {
        const next = {
          workspaceWidth,
          sidebarWidth: measuredSidebarWidth,
        };
        return current.workspaceWidth === next.workspaceWidth &&
          current.sidebarWidth === next.sidebarWidth
          ? current
          : next;
      });
      setSidebarWidth((current) =>
        current === null
          ? null
          : clampTo(current, widthLimits.min, widthLimits.max),
      );
    };
    const scheduleMeasurement = () => {
      if (measureFrame !== null) return;
      measureFrame = window.requestAnimationFrame(measureLayout);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasurement);
    if (workspaceRef.current) observer?.observe(workspaceRef.current);
    if (setupColumnRef.current) observer?.observe(setupColumnRef.current);
    window.addEventListener("resize", scheduleMeasurement);
    scheduleMeasurement();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasurement);
      if (measureFrame !== null) window.cancelAnimationFrame(measureFrame);
    };
  }, []);

  const pendingSource = useMemo<VideoSourceDescriptor | null>(() => {
    if (mode === "upload") {
      if (!selectedVideo) return null;

      const durationLabel = selectedVideo.duration
        ? formatDuration(selectedVideo.duration)
        : "等待读取时长";

      return {
        kind: "upload",
        title: titleFromFilename(selectedVideo.name),
        localPath: selectedVideo.localPath,
        subtitle: `${selectedVideo.name} · ${formatFileSize(
          selectedVideo.size,
        )} · ${durationLabel}`,
        durationLabel,
      };
    }

    if (mode === "douyin") {
      if (!douyinUrl) return null;
      return {
        kind: "douyin",
        title: "抖音视频",
        subtitle: "抖音公开分享视频 · 等待读取视频信息",
        sourceUrl: douyinUrl,
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
  }, [bvid, directVideoUrl, douyinUrl, mode, selectedVideo]);

  useEffect(() => {
    return () => {
      if (selectedVideo?.objectUrl) releaseLocalVideo(selectedVideo.objectUrl);
    };
  }, [selectedVideo?.objectUrl]);

  useEffect(() => {
    const cancelActiveWork = () => {
      runTokenRef.current += 1;
      analyzeAbortRef.current?.abort();
      transcriptAbortRef.current?.abort();
      fetchVideoAbortRef.current?.abort();
      askAbortRef.current?.abort();
      pendingReplyRef.current = null;
      conversationLoadAbortRef.current?.abort();
      activeResizeCleanupRef.current?.();
      cancelStreamMessageUpdate();
      if (downloadRequestRef.current) videoFilesApi().cancelDownload(downloadRequestRef.current);
      fileSelectionTokenRef.current += 1;
    };
    globalThis.addEventListener("pagehide", cancelActiveWork);
    return () => {
      globalThis.removeEventListener("pagehide", cancelActiveWork);
      cancelActiveWork();
    };
  }, [cancelStreamMessageUpdate]);

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
    setting: "deepThinking" | "webSearch" | "fullRecall",
    enabled: boolean,
  ) {
    const nextDeepThinking =
      setting === "deepThinking" ? enabled : deepThinkingEnabled;
    const nextWebSearch =
      setting === "webSearch" ? enabled : webSearchEnabled;
    const nextFullRecall =
      setting === "fullRecall" ? enabled : fullRecallEnabled;
    setDeepThinkingEnabled(nextDeepThinking);
    setWebSearchEnabled(nextWebSearch);
    setFullRecallEnabled(nextFullRecall);
    try {
      window.localStorage.setItem(
        CHAT_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          deepThinking: nextDeepThinking,
          webSearch: nextWebSearch,
          fullRecall: nextFullRecall,
        }),
      );
    } catch {
      // 无法保存时，开关在本次页面会话中仍然有效。
    }
  }

  function sidebarWidthLimits() {
    const workspaceWidth =
      workspaceRef.current?.getBoundingClientRect().width ??
      workspaceMeasurements.workspaceWidth;
    return sidebarWidthLimitsFor(workspaceWidth);
  }

  function clampSidebarWidth(value: number) {
    const { min, max } = sidebarWidthLimits();
    return clampTo(value, min, max);
  }

  function beginSidebarResize(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    activeResizeCleanupRef.current?.();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startSidebarWidth =
      setupColumnRef.current?.getBoundingClientRect().width ??
      sidebarWidth ??
      MIN_SIDEBAR_WIDTH;

    target.setPointerCapture?.(pointerId);
    document.documentElement.dataset.resizing = "columns";

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setSidebarWidth(
        clampSidebarWidth(startSidebarWidth + moveEvent.clientX - startX),
      );
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

  function clearVideoPreview() {
    resetVideoPlayer();
    setVideoPreview(null);
  }

  function cancelVideoDownload() {
    if (downloadRequestRef.current) videoFilesApi().cancelDownload(downloadRequestRef.current);
  }

  async function handleVideoDownload() {
    if (downloadRequestRef.current) {
      cancelVideoDownload();
      return;
    }
    if (!videoPreview) return;
    const runToken = runTokenRef.current;
    const requestId = crypto.randomUUID();
    try {
      let input: VideoDownloadInput;
      if (videoPreview.kind === "local") {
        if (!videoPreview.localPath) throw new Error("找不到本地视频路径。");
        input = { kind: "local", path: videoPreview.localPath };
      } else if (videoPreview.kind === "bilibili") {
        input = { kind: "bilibili", bvid: videoPreview.sourceLabel ?? "", title: videoPreview.title ?? videoPreview.filename };
      } else if (videoPreview.kind === "douyin") {
        const sourceUrl = videoPreview.sourceUrl ?? activeSource?.sourceUrl;
        if (!sourceUrl) throw new Error("找不到原抖音分享链接。");
        input = { kind: "douyin", sourceUrl, title: videoPreview.title ?? videoPreview.filename };
      } else {
        input = { kind: "remote", url: videoPreview.playbackUrl, title: videoPreview.title ?? videoPreview.filename };
      }
      downloadRequestRef.current = requestId;
      setDownloadRequestId(requestId);
      const result = unwrapDesktopResult(await videoFilesApi().download(requestId, input));
      if (runTokenRef.current !== runToken) return;
      if (!result.cancelled) showNotice(`视频已保存：${result.path}`, "success");
    } catch (error) {
      if (runTokenRef.current === runToken) showNotice(error instanceof Error ? error.message : "视频下载失败。");
    } finally {
      if (downloadRequestRef.current === requestId) {
        downloadRequestRef.current = null;
        setDownloadRequestId(null);
      }
    }
  }

  function renderVideoDownloadButton() {
    if (!videoPreview) return null;
    return (
      <button className="video-download-button" type="button" onClick={() => void handleVideoDownload()}
        title={downloadRequestId ? "取消当前下载" : videoPreview.kind === "local" ? "另存本地原视频" : "保存视频到所选位置"}>
        {downloadRequestId ? <span className="button-spinner" aria-hidden="true" /> : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" />
          </svg>
        )}
        {downloadRequestId ? "取消下载" : "下载视频"}
      </button>
    );
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
      filename: video.name,
      title: titleFromFilename(video.name),
      localPath: video.localPath,
      sizeLabel: formatFileSize(video.size),
      durationLabel: video.duration ? formatDuration(video.duration) : undefined,
      durationSeconds: video.duration,
      resolutionLabel:
        video.width && video.height
          ? `${video.width}x${video.height}`
          : undefined,
      sourceLabel: "本地上传",
    });
  }

  function showPlatformVideo(
    result: PlatformVideoPreview,
    fallbackDescription?: string,
  ) {
    setVideoPreview({
      kind: result.kind,
      playbackUrl: result.playbackUrl,
      audioPlaybackUrl: result.audioPlaybackUrl,
      filename: result.filename,
      title: result.title,
      description: result.description ?? fallbackDescription,
      sizeLabel: result.sizeBytes > 0 ? formatFileSize(result.sizeBytes) : undefined,
      durationLabel: formatDuration(result.durationSeconds),
      durationSeconds: result.durationSeconds,
      resolutionLabel: previewResolutionLabel(result),
      sourceLabel: result.sourceLabel,
      sourceUrl: result.sourceUrl,
    });
  }

  function selectMode(nextMode: InputMode) {
    if (phase === "processing" || isFetchingVideo) return;
    setMode(nextMode);
    const previewMatchesMode =
      (nextMode === "upload" && videoPreview?.kind === "local") ||
      (nextMode === "bilibili" &&
        (videoPreview?.kind === "bilibili" || videoPreview?.kind === "remote")) ||
      (nextMode === "douyin" && videoPreview?.kind === "douyin");
    if (videoPreview && !previewMatchesMode) {
      clearVideoPreview();
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

    resetWorkspace();
    const selectionToken = ++fileSelectionTokenRef.current;
    let objectUrl: string | undefined;
    try {
      const path = videoFilesApi().pathForFile(file);
      const local = await openLocalVideo(path);
      objectUrl = local.playbackUrl;
      if (selectionToken !== fileSelectionTokenRef.current) {
        releaseLocalVideo(objectUrl);
        return;
      }
      const nextVideo: SelectedVideo = { file, name: local.name, size: local.size, lastModified: local.lastModified, localPath: local.path, objectUrl };
      setSelectedVideo(nextVideo);
      showLocalVideo(nextVideo);
      setNotice(null);
      const metadata = await readVideoMetadata(objectUrl);
      if (selectionToken !== fileSelectionTokenRef.current) return;
      const hydratedVideo = { ...nextVideo, ...metadata };
      setSelectedVideo((current) =>
        current?.objectUrl === objectUrl ? hydratedVideo : current,
      );
      showLocalVideo(hydratedVideo);
    } catch (error) {
      if (selectionToken !== fileSelectionTokenRef.current) return;
      showNotice(
        objectUrl ? "播放器暂时无法读取这个视频，可尝试视频分析或下载原文件。" : error instanceof Error ? error.message : "无法读取本地视频信息。",
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

  async function prepareOnlinePlatformPreview(
    source: VideoSourceDescriptor,
    controller: AbortController,
    runToken: number,
    reportProgress = true,
  ) {
    const prepared = await preparePlatformVideoPreview(source, {
      signal: controller.signal,
      ...(reportProgress
        ? {
            onProgress: ({ stage, progress }: { stage: string; progress: number }) => {
              if (runTokenRef.current !== runToken) return;
              if (source.kind === "bilibili") {
                setStageIndex(1);
                setStageProgress(
                  stage === "preparing" ? Math.min(0.95, progress * 0.95) : 1,
                );
              } else {
                setStageIndex(stage === "preparing" ? 0 : 1);
                setStageProgress(stage === "preparing" ? 0.35 : progress);
              }
            },
          }
        : {}),
    });
    if (runTokenRef.current !== runToken) return null;

    showPlatformVideo(prepared, source.description);
    return prepared;
  }

  async function loadBilibiliConversationPreview(
    source: VideoSourceDescriptor,
    restoredBvid: string,
    runToken: number,
    reason: "restore" | "analysis-start",
  ) {
    const restoring = reason === "restore";
    const startedWithAnalysis = reason === "analysis-start";
    fetchVideoAbortRef.current?.abort();
    const controller = new AbortController();
    fetchVideoAbortRef.current = controller;
    setIsFetchingVideo(true);
    if (!startedWithAnalysis) {
      setProcessingStages(["校验 B 站视频地址", "解析最高 1080p CDN 预览"]);
      setStageIndex(0);
      setStageProgress(0.15);
      showNotice("总结和对话已恢复，正在自动恢复视频预览……", "success");
    }

    try {
      const prepared = await prepareOnlinePlatformPreview(
        { ...source, bvid: restoredBvid },
        controller,
        runToken,
        !startedWithAnalysis,
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
        bvid: prepared.platformId,
        sourceUrl:
          source.sourceUrl ?? prepared.sourceUrl,
        title: prepared.title,
        description: prepared.description ?? source.description,
        durationLabel: formatDuration(prepared.durationSeconds),
        subtitle: `${prepared.platformId} · ${formatFileSize(
          prepared.sizeBytes,
        )} · ${formatDuration(prepared.durationSeconds)}`,
      });
      if (!startedWithAnalysis) {
        setStageIndex(2);
        setStageProgress(1);
        showNotice("总结、对话和视频预览已恢复。", "success");
      }
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
          ? `${
              restoring ? "总结和对话已恢复" : "视频总结仍在继续"
            }，但视频预览自动获取失败：${error.message}`
          : `${
              restoring ? "总结和对话已恢复" : "视频总结仍在继续"
            }，但视频预览自动获取失败。`,
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

  async function loadDouyinConversationPreview(
    source: VideoSourceDescriptor,
    runToken: number,
    reason: "restore" | "analysis-start",
  ) {
    const startedWithAnalysis = reason === "analysis-start";
    fetchVideoAbortRef.current?.abort();
    const controller = new AbortController();
    fetchVideoAbortRef.current = controller;
    setIsFetchingVideo(true);
    if (!startedWithAnalysis) {
      setProcessingStages(["校验抖音分享链接", "解析抖音视频预览"]);
      setStageIndex(0);
      setStageProgress(0.15);
      showNotice("总结和对话已恢复，正在自动恢复抖音视频预览……", "success");
    }

    try {
      const prepared = await prepareOnlinePlatformPreview(
        source,
        controller,
        runToken,
        !startedWithAnalysis,
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
        sourceUrl: prepared.sourceUrl,
        title: prepared.title,
        description: prepared.description ?? source.description,
        durationLabel: formatDuration(prepared.durationSeconds),
        subtitle: `抖音 · ${
          prepared.sizeBytes > 0 ? `${formatFileSize(prepared.sizeBytes)} · ` : ""
        }${formatDuration(prepared.durationSeconds)}`,
      });
      if (!startedWithAnalysis) {
        setStageIndex(2);
        setStageProgress(1);
        showNotice("总结、对话和抖音视频预览已恢复。", "success");
      }
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
          ? `总结和对话已恢复，但抖音视频预览自动获取失败：${error.message}`
          : "总结和对话已恢复，但抖音视频预览自动获取失败。",
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
      showNotice(
        mode === "douyin"
          ? "请粘贴有效的抖音分享链接后再获取视频。"
          : "请输入 B站链接、BV 号或 HTTPS 视频直链后再获取视频。",
      );
      return;
    }
    if (phase === "processing" || isFetchingVideo) return;

    fileSelectionTokenRef.current += 1;
    cancelVideoDownload();
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    fetchVideoAbortRef.current?.abort();
    analyzeAbortRef.current?.abort();
    transcriptAbortRef.current?.abort();
    transcriptAbortRef.current = null;
    setIsExtractingTranscript(false);
    setTranscriptExtractionProgress(null);
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
        : pendingSource.kind === "douyin"
          ? activeSource.sourceUrl === pendingSource.sourceUrl
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

    if (pendingSource.kind === "douyin" && pendingSource.sourceUrl) {
      const stages = ["校验抖音分享链接", "解析抖音视频预览"];
      setIsFetchingVideo(true);
      if (!preservesConversation) setPhase("processing");
      setProcessingStages(stages);
      setStageIndex(0);
      setStageProgress(0.15);
      if (!preservesConversation) clearVideoPreview();

      try {
        const prepared = await prepareOnlinePlatformPreview(
          pendingSource,
          controller,
          runToken,
        );
        if (!prepared || runTokenRef.current !== runToken) return;
        setActiveSource({
          ...(preservesConversation && activeSource ? activeSource : pendingSource),
          sourceUrl: prepared.sourceUrl,
          title: prepared.title,
          description: prepared.description ?? pendingSource.description,
          durationLabel: formatDuration(prepared.durationSeconds),
          subtitle: `抖音 · ${
            prepared.sizeBytes > 0 ? `${formatFileSize(prepared.sizeBytes)} · ` : ""
          }${formatDuration(prepared.durationSeconds)}`,
        });
        setStageIndex(stages.length);
        setStageProgress(1);
        setPhase(preservesConversation ? "ready" : "idle");
        showNotice(
          preservesConversation
            ? "总结、对话和抖音视频预览已恢复。"
            : "抖音视频预览已准备好。",
          "success",
        );
      } catch (error) {
        if (runTokenRef.current !== runToken) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setPhase(preservesConversation ? "ready" : "error");
        showNotice(
          error instanceof Error ? error.message : "获取抖音视频失败，请检查链接后重试。",
        );
      } finally {
        if (fetchVideoAbortRef.current === controller) {
          fetchVideoAbortRef.current = null;
        }
        if (runTokenRef.current === runToken) setIsFetchingVideo(false);
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

    const stages = ["校验 B 站视频地址", "解析最高 1080p CDN 预览"];
    setIsFetchingVideo(true);
    if (!preservesConversation) setPhase("processing");
    setProcessingStages(stages);
    setStageIndex(0);
    setStageProgress(0.15);
    if (!preservesConversation) clearVideoPreview();

    try {
      const prepared = await prepareOnlinePlatformPreview(
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
        subtitle: `${prepared.platformId} · ${formatFileSize(
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

  async function handleExtractTranscript() {
    if (
      isExtractingTranscript ||
      phase !== "ready" ||
      !summary ||
      !activeSource ||
      !activeConversationId ||
      !videoPreview
    ) {
      return;
    }

    transcriptAbortRef.current?.abort();
    const controller = new AbortController();
    transcriptAbortRef.current = controller;
    transcriptProgressStartedAtRef.current = performance.now();
    setIsExtractingTranscript(true);
    setTranscriptExtractionProgress(0.04);
    setTranscriptChunkProgress(null);
    showNotice("正在准备音轨并使用 Qwen Audio 在线识别字幕……", "success");

    let bilibiliJobId: string | null = null;
    let mediaJobId: string | null = null;
    let completed = false;
    try {
      if (activeSource.kind === "bilibili") {
        const restoredBvid =
          activeSource.bvid ?? extractBvid(activeSource.sourceUrl ?? "");
        if (!restoredBvid) throw new Error("无法识别原视频的 BV 号。");
        const prepared = await downloadBilibiliVideo(restoredBvid, {
          signal: controller.signal,
          directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
        });
        bilibiliJobId = prepared.jobId;
      } else if (activeSource.kind === "douyin") {
        if (!activeSource.sourceUrl) {
          throw new Error("原抖音分享链接不可用，无法提取字幕。");
        }
        const preview = await preparePlatformVideoPreview(activeSource, {
          signal: controller.signal,
        });
        if (transcriptAbortRef.current !== controller) return;
        showPlatformVideo(preview, activeSource.description);
        const file = await downloadRemoteVideoFile(
          preview.playbackUrl,
          controller.signal,
          preview.filename,
        );
        const prepared = await prepareMediaAnalysis(file, {
          sourceKind: "douyin",
          sourceUrl: activeSource.sourceUrl,
          directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
          signal: controller.signal,
        });
        mediaJobId = prepared.jobId;
      } else {
        let file: File;
        if (activeSource.kind === "upload") {
          if (!selectedVideo) {
            throw new Error("找不到本地视频，无法提取字幕。");
          }
          file = await selectedVideoFile(selectedVideo, controller.signal);
        } else {
          if (!activeSource.sourceUrl) {
            throw new Error("原视频直链不可用，无法提取字幕。");
          }
          file = await downloadRemoteVideoFile(
            activeSource.sourceUrl,
            controller.signal,
          );
        }
        const prepared = await prepareMediaAnalysis(file, {
          sourceKind: activeSource.kind,
          ...(activeSource.kind === "url" && activeSource.sourceUrl
            ? { sourceUrl: activeSource.sourceUrl }
            : {}),
          directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
          signal: controller.signal,
        });
        mediaJobId = prepared.jobId;
      }
      setTranscriptExtractionProgress((current) =>
        Math.max(current ?? 0, 0.16),
      );

      const nextTranscript = await extractOnlineTranscript(
        bilibiliJobId ?? (mediaJobId as string),
        bilibiliJobId ? "bilibili" : "media",
        transcriptLanguages,
        controller.signal,
        (chunkProgress) => {
          if (transcriptAbortRef.current !== controller) return;
          setTranscriptChunkProgress(chunkProgress);
          setTranscriptExtractionProgress(
            chunkProgress.totalChunks > 0
              ? chunkProgress.completedChunks / chunkProgress.totalChunks
              : 0,
          );
        },
      );

      if (transcriptAbortRef.current !== controller) return;
      setTranscriptExtractionProgress((current) =>
        Math.max(current ?? 0, 0.96),
      );
      const saved = await saveConversationTranscript(
        activeConversationId,
        nextTranscript,
      );
      if (transcriptAbortRef.current !== controller) return;
      setTranscript(saved);
      touchConversationItem(activeConversationId);
      completed = true;
      setTranscriptExtractionProgress(1);
      window.setTimeout(() => {
        setTranscriptExtractionProgress((current) =>
          current === 1 ? null : current,
        );
      }, 650);
      showNotice(
        saved.status === "ready"
          ? "字幕已重新提取并覆盖原记录。"
          : saved.error ?? "字幕暂不可用。",
        saved.status === "ready" ? "success" : "error",
      );
    } catch (error) {
      if (
        transcriptAbortRef.current !== controller ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      showNotice(
        error instanceof Error ? error.message : "字幕提取失败，请稍后重试。",
      );
    } finally {
      if (bilibiliJobId) void releaseBilibiliAnalysis(bilibiliJobId);
      if (mediaJobId) void releaseMediaAnalysis(mediaJobId);
      if (transcriptAbortRef.current === controller) {
        transcriptAbortRef.current = null;
        setIsExtractingTranscript(false);
        if (!completed) setTranscriptExtractionProgress(null);
        if (!completed) setTranscriptChunkProgress(null);
      }
    }
  }

  async function handleAnalyze() {
    if (isFetchingVideo) return;
    if (!pendingSource) {
      showNotice(
        mode === "upload"
          ? "请先选择一个视频文件。"
          : mode === "douyin"
            ? "请粘贴有效的抖音分享链接。"
            : "请输入有效的 B 站视频链接或 BV 号。",
      );
      return;
    }

    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    analyzeAbortRef.current?.abort();
    transcriptAbortRef.current?.abort();
    transcriptAbortRef.current = null;
    setIsExtractingTranscript(false);
    setTranscriptExtractionProgress(null);
    stopReply();
    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    const stages = stagesFor(pendingSource, shouldExtractTranscript);

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
    setAnalysisBranches(initialBranches());
    setDisplayedProgress(0);
    targetProgressRef.current = 0;
    setProcessingDurationSeconds(
      pendingSource.kind === "upload" ? selectedVideo?.duration ?? null : null,
    );
    if (pendingSource.kind === "url" && pendingSource.sourceUrl) {
      showRemoteVideo(pendingSource.sourceUrl);
    } else if (pendingSource.kind === "upload") {
      if (selectedVideo) showLocalVideo(selectedVideo);
    } else if (pendingSource.bvid && !videoPreview) {
      void loadBilibiliConversationPreview(
        pendingSource,
        pendingSource.bvid,
        runToken,
        "analysis-start",
      );
    }

    let bilibiliAnalysisJobId: string | null = null;
    let mediaAnalysisJobId: string | null = null;
    let analysisTranscript: VideoTranscript | null = null;
    try {
      let context: VideoModelContext;
      let analysisSource = pendingSource;
      if (pendingSource.kind === "upload") {
        if (!selectedVideo) {
            throw new Error("找不到需要分析的本地视频。");
        }
        const prepared = await prepareMediaAnalysis(await selectedVideoFile(selectedVideo, controller.signal), {
          sourceKind: "upload",
          directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
          signal: controller.signal,
          onProgress: (progress) => {
            if (runTokenRef.current !== runToken) return;
            reportAnalysisPreparationProgress(progress);
          },
        });
        mediaAnalysisJobId = prepared.jobId;
        setProcessingDurationSeconds(prepared.durationSeconds);
        context = prepared.context;
        analysisSource = {
          ...pendingSource,
          title: titleFromFilename(selectedVideo.name),
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
        setProcessingDurationSeconds(downloaded.durationSeconds);
        if (runTokenRef.current !== runToken) return;

        analysisSource = {
          ...pendingSource,
          title: downloaded.title,
          description: downloaded.description ?? pendingSource.description,
          durationLabel: formatDuration(downloaded.durationSeconds),
          subtitle: `${downloaded.bvid} · ${formatFileSize(
            downloaded.sizeBytes,
          )} · ${formatDuration(downloaded.durationSeconds)}`,
        };
        setActiveSource(analysisSource);
        setStageIndex(2);
        setStageProgress(1);
        context = {
          ...downloaded.context,
          durationSeconds: downloaded.durationSeconds,
        };
      } else if (pendingSource.kind === "douyin") {
        if (!pendingSource.sourceUrl) {
          throw new Error("没有可解析的抖音分享链接。");
        }
        setStageIndex(0);
        setStageProgress(0.1);
        const preview = await prepareOnlinePlatformPreview(
          pendingSource,
          controller,
          runToken,
        );
        if (!preview || runTokenRef.current !== runToken) return;
        setProcessingDurationSeconds(preview.durationSeconds);
        const remoteFile = await downloadRemoteVideoFile(
          preview.playbackUrl,
          controller.signal,
          preview.filename,
        );
        setStageProgress(0.45);
        const prepared = await prepareMediaAnalysis(remoteFile, {
          sourceKind: "douyin",
          sourceUrl: preview.sourceUrl,
          directSummaryMaxSeconds: qwenDirectSummaryMaxSeconds,
          signal: controller.signal,
          onProgress: (progress) => {
            if (runTokenRef.current !== runToken) return;
            reportAnalysisPreparationProgress(progress);
          },
        });
        mediaAnalysisJobId = prepared.jobId;
        setProcessingDurationSeconds(prepared.durationSeconds);
        context = prepared.context;
        analysisSource = {
          ...pendingSource,
          sourceUrl: preview.sourceUrl,
          title: preview.title || pendingSource.title,
          description: preview.description ?? pendingSource.description,
          durationLabel: formatDuration(prepared.durationSeconds),
          subtitle: `抖音 · ${
            preview.sizeBytes > 0 ? `${formatFileSize(preview.sizeBytes)} · ` : ""
          }${formatDuration(prepared.durationSeconds)}`,
        };
        setActiveSource(analysisSource);
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
        setProcessingDurationSeconds(prepared.durationSeconds);
        context = prepared.context;
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
      controller.signal.throwIfAborted();
      setStageIndex(3);
      setAnalysisBranches({
        summary: { status: "running", progress: 0.15 },
        transcript: { status: shouldExtractTranscript ? "running" : "skipped", progress: shouldExtractTranscript ? 0.1 : 1 },
      });
      const finishBranch = (branch: keyof AnalysisBranches, status: BranchStatus) => {
        if (runTokenRef.current !== runToken || controller.signal.aborted) return;
        setAnalysisBranches((current) => ({
          ...current,
          [branch]: { ...current[branch], status, progress: 1 },
        }));
      };
      // Start both requests together. Wait for both to settle before releasing their shared media job.
      const summaryTask = analyzeVideo({ source: analysisSource, context }, controller.signal).then(
        (value) => { finishBranch("summary", "complete"); return value; },
        (error: unknown) => { finishBranch("summary", "failed"); throw error; },
      );
      const transcriptTask = shouldExtractTranscript
        ? extractOnlineTranscript(
            bilibiliAnalysisJobId ?? (mediaAnalysisJobId as string),
            bilibiliAnalysisJobId ? "bilibili" : "media",
            transcriptLanguages,
            controller.signal,
            (chunkProgress) => {
              if (runTokenRef.current !== runToken || controller.signal.aborted) return;
              setAnalysisBranches((current) => ({
                ...current,
                transcript: {
                  ...current.transcript,
                  completedChunks: chunkProgress.completedChunks,
                  totalChunks: chunkProgress.totalChunks,
                  progress:
                    chunkProgress.totalChunks > 0
                      ? chunkProgress.completedChunks / chunkProgress.totalChunks
                      : 0,
                },
              }));
            },
          ).then((value) => {
            finishBranch("transcript", value.status === "ready" ? "complete" : "failed");
            return value;
          }).catch((error: unknown) => {
            if (controller.signal.aborted) throw error;
            finishBranch("transcript", "failed");
            return unavailableOnlineTranscript(transcriptLanguages, error);
          })
        : Promise.resolve(null);
      const [summaryOutcome, transcriptOutcome] = await Promise.allSettled([summaryTask, transcriptTask]);
      if (runTokenRef.current !== runToken || controller.signal.aborted) return;
      analysisTranscript = transcriptOutcome.status === "fulfilled" ? transcriptOutcome.value : unavailableOnlineTranscript(transcriptLanguages, transcriptOutcome.reason);
      setTranscript(analysisTranscript);
      if (summaryOutcome.status === "rejected") throw summaryOutcome.reason;
      const result = summaryOutcome.value;

      setStageIndex(stages.length - 1);
      setStageProgress(0.2);
      setSummary(result.summary);
      setActiveModel(result.model);
      const initialMessage: ChatMessage = {
        id: nextMessageId("assistant"),
        role: "assistant",
        content: SUMMARY_READY_MESSAGE,
        createdAt: result.usage.createdAt,
        usage: result.usage,
      };
      setMessages([initialMessage]);

      try {
        const saved = await createConversation({
          source: analysisSource,
          summary: result.summary,
          activeModel: result.model,
          messages: [conversationMessageForStorage(initialMessage)],
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
    cancelVideoDownload();
    fileSelectionTokenRef.current += 1;
    runTokenRef.current += 1;
    analyzeAbortRef.current?.abort();
    analyzeAbortRef.current = null;
    transcriptAbortRef.current?.abort();
    transcriptAbortRef.current = null;
    setIsExtractingTranscript(false);
    setTranscriptExtractionProgress(null);
    fetchVideoAbortRef.current?.abort();
    fetchVideoAbortRef.current = null;
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    pendingReplyRef.current = null;
    cancelStreamMessageUpdate();
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
    setAnalysisBranches(initialBranches());
    setDisplayedProgress(0);
    targetProgressRef.current = 0;
    setProcessingDurationSeconds(null);
    setIsFetchingVideo(false);
    clearVideoPreview();
    setMessages([]);
    setActiveConversationId(null);
    setLoadingConversationId(null);
    setRenamingConversationId(null);
    setSelectedVideo(null);
    setBilibiliInput("");
    setDouyinInput("");
    setMode("upload");
    setQuestion("");
    setIsReplying(false);
    setIsUsageMenuOpen(false);
    setCopiedMessageId(null);
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

    fileSelectionTokenRef.current += 1;
    cancelVideoDownload();
    const runToken = runTokenRef.current + 1;
    runTokenRef.current = runToken;
    analyzeAbortRef.current?.abort();
    analyzeAbortRef.current = null;
    transcriptAbortRef.current?.abort();
    transcriptAbortRef.current = null;
    setIsExtractingTranscript(false);
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
      setIsUsageMenuOpen(false);
      setCopiedMessageId(null);
      setMessages(
        conversation.messages.map(
          ({
            id: messageId,
            role,
            content,
            reasoningContent,
            reasoningDurationSeconds,
            webSources,
            webSearch,
            stopped,
            createdAt,
            usage,
          }) => ({
            id: messageId,
            role,
            content,
            createdAt,
            ...(reasoningContent ? { reasoningContent } : {}),
            ...(reasoningDurationSeconds !== undefined
              ? { reasoningDurationSeconds }
              : {}),
            ...(webSources?.length ? { webSources } : {}),
            ...(webSearch ? { webSearch } : {}),
            ...(stopped ? { stopped: true } : {}),
            ...(usage ? { usage } : {}),
          }),
        ),
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
        setDouyinInput("");
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
      } else if (conversation.source.kind === "douyin" && conversation.source.sourceUrl) {
        setMode("douyin");
        setBilibiliInput("");
        setDouyinInput(conversation.source.sourceUrl);
        clearVideoPreview();
        void loadDouyinConversationPreview(
          conversation.source,
          runToken,
          "restore",
        );
      } else if (conversation.source.kind === "url" && conversation.source.sourceUrl) {
        setMode("bilibili");
        setBilibiliInput(conversation.source.sourceUrl);
        setDouyinInput("");
        showRemoteVideo(conversation.source.sourceUrl);
        setNotice(null);
      } else {
        setMode("upload");
        setBilibiliInput("");
        setDouyinInput("");
        clearVideoPreview();
        setNotice(null);
        try {
          if (!conversation.source.localPath) throw new Error("这条旧记录没有保存本地视频路径，无法自动找到原视频。");
          const local = await openLocalVideo(conversation.source.localPath);
          if (controller.signal.aborted || runTokenRef.current !== runToken) {
            releaseLocalVideo(local.playbackUrl);
            return;
          }
          const video: SelectedVideo = { name: local.name, size: local.size, lastModified: local.lastModified, localPath: local.path, objectUrl: local.playbackUrl };
          setSelectedVideo(video);
          showLocalVideo(video);
          const metadata = await readVideoMetadata(video.objectUrl, controller.signal);
          if (controller.signal.aborted || runTokenRef.current !== runToken) return;
          setSelectedVideo({ ...video, ...metadata });
          showLocalVideo({ ...video, ...metadata });
        } catch (error) {
          if (controller.signal.aborted || runTokenRef.current !== runToken) return;
          showNotice(error instanceof Error ? error.message : "找不到本地视频。");
        }
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

  async function askQuestion(
    rawQuestion: string,
    options: {
      history?: ChatMessage[];
      replaceMessages?: ChatMessage[];
    } = {},
  ) {
    const trimmed = rawQuestion.trim();
    if (!trimmed || !summary || !activeSource || isReplying || askAbortRef.current) return;

    const controller = new AbortController();
    cancelStreamMessageUpdate();
    askAbortRef.current = controller;
    const sentAt = currentTimestamp();

    const userMessage: ChatMessage = {
      id: nextMessageId("user"),
      role: "user",
      content: trimmed,
      createdAt: sentAt,
    };
    const assistantMessage: ChatMessage = {
      id: nextMessageId("assistant"),
      role: "assistant",
      content: "",
      createdAt: sentAt + 1,
      isStreaming: true,
      streamLabel: "正在准备回答",
    };
    pendingReplyRef.current = {
      controller,
      userMessage,
      assistantMessage,
      conversationId: activeConversationId,
    };
    setMessages((current) => [
      ...(options.replaceMessages ?? current),
      userMessage,
      assistantMessage,
    ]);
    setQuestion("");
    setIsReplying(true);

    try {
      const result = await askVideo(
        {
          question: trimmed,
          ...(activeConversationId
            ? { conversationId: activeConversationId }
            : { source: activeSource, summary }),
          history: (options.history ?? messages)
            .slice(-10)
            .map(({ role, content }) => ({ role, content })),
          reasoningMode: deepThinkingEnabled ? "pro" : "flash",
          webSearchEnabled,
          fullRecallEnabled,
          ...(webSearchEnabled
            ? {
                searchContext: {
                  locale: navigator.language,
                  timeZone:
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                },
              }
            : {}),
        },
        {
          onEvent: (event) => {
            const pending = pendingReplyRef.current;
            if (
              askAbortRef.current !== controller ||
              pending?.controller !== controller
            ) {
              return;
            }
            if (event.type === "phase") {
              pending.assistantMessage = {
                ...pending.assistantMessage,
                streamLabel: event.label,
              };
            } else if (event.type === "reasoning_delta") {
              const receivedAt = Date.now();
              pending.reasoningStartedAt ??= receivedAt;
              pending.reasoningLastAt = receivedAt;
              pending.assistantMessage = {
                ...pending.assistantMessage,
                reasoningContent:
                  (pending.assistantMessage.reasoningContent ?? "") +
                  event.delta,
                streamLabel: "正在深度思考",
              };
            } else if (event.type === "answer_delta") {
              if (pending.reasoningStartedAt !== undefined) {
                pending.reasoningLastAt = Date.now();
              }
              pending.assistantMessage = {
                ...pending.assistantMessage,
                content: pending.assistantMessage.content + event.delta,
                streamLabel: "正在生成回答",
              };
            } else {
              return;
            }
            scheduleStreamMessageUpdate(pending.assistantMessage);
          },
        },
        controller.signal,
      );
      if (askAbortRef.current !== controller) return;
      const pending = pendingReplyRef.current;
      if (pending?.controller !== controller) return;
      const completedAssistant: ChatMessage = {
        ...pending.assistantMessage,
        content: result.answer,
        createdAt: result.usage.createdAt,
        usage: result.usage,
        isStreaming: false,
        streamLabel: undefined,
        ...(result.reasoningContent
          ? { reasoningContent: result.reasoningContent }
          : {}),
        ...(result.reasoningDurationSeconds !== undefined
          ? {
              reasoningDurationSeconds:
                result.reasoningDurationSeconds,
            }
          : {}),
        ...(result.webSources?.length
          ? { webSources: result.webSources }
          : {}),
        ...(result.webSearch ? { webSearch: result.webSearch } : {}),
      };
      pending.assistantMessage = completedAssistant;
      cancelStreamMessageUpdate();
      setMessages((current) =>
        current.map((message) =>
          message.id === completedAssistant.id ? completedAssistant : message,
        ),
      );

      if (pending.conversationId) {
        const conversationId = pending.conversationId;
        try {
          const savedMessages = await appendConversationMessages(
            conversationId,
            [
              { role: userMessage.role, content: userMessage.content },
              conversationMessageForStorage(completedAssistant),
            ],
          );
          const savedUser = savedMessages[0];
          const savedAssistant = savedMessages[1];
          setMessages((current) =>
            current.map((message) => {
              if (message.id === userMessage.id && savedUser) {
                return { ...message, id: savedUser.id };
              }
              if (message.id === completedAssistant.id && savedAssistant) {
                return { ...message, id: savedAssistant.id };
              }
              return message;
            }),
          );
          touchConversationItem(conversationId);
        } catch (error) {
          setConversationListError(
            error instanceof Error
              ? `回答已生成，但未保存：${error.message}`
              : "回答已生成，但未能保存到对话历史。",
          );
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (askAbortRef.current !== controller) return;
      const pending = pendingReplyRef.current;
      if (pending?.controller !== controller) return;
      const failedAssistant: ChatMessage = {
        ...pending.assistantMessage,
        content:
          error instanceof Error
            ? `回答失败：${error.message}`
            : "回答失败，请稍后重试。",
        isStreaming: false,
        streamLabel: undefined,
      };
      pending.assistantMessage = failedAssistant;
      cancelStreamMessageUpdate();
      setMessages((current) =>
        current.map((message) =>
          message.id === failedAssistant.id ? failedAssistant : message,
        ),
      );
    } finally {
      if (askAbortRef.current === controller) {
        askAbortRef.current = null;
        pendingReplyRef.current = null;
        setIsReplying(false);
      }
    }
  }

  async function copyMessage(message: ChatMessage) {
    try {
      const desktop = desktopBridge();
      if (!desktop) throw new Error("桌面剪贴板接口不可用。");
      unwrapDesktopResult(await desktop.clipboard.writeText(message.content));
      setCopiedMessageId(message.id);
      window.setTimeout(() => {
        setCopiedMessageId((current) =>
          current === message.id ? null : current,
        );
      }, 1_500);
    } catch (error) {
      showNotice(
        error instanceof Error ? `复制失败：${error.message}` : "复制失败。",
      );
    }
  }

  async function resendAssistantAnswer(messageIndex: number) {
    if (isReplying || resendingMessageId) return;
    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index];
      if (candidate.role === "user" && candidate.content.trim()) {
        const retainedMessages = messages.slice(0, index);
        setResendingMessageId(messages[messageIndex]?.id ?? candidate.id);
        try {
          if (activeConversationId) {
            await truncateConversationMessages(
              activeConversationId,
              candidate.id,
            );
            touchConversationItem(activeConversationId);
          }
          await askQuestion(candidate.content, {
            history: retainedMessages,
            replaceMessages: retainedMessages,
          });
        } catch (error) {
          setConversationListError(
            error instanceof Error
              ? `无法重新发送：${error.message}`
              : "无法重新发送这条问题。",
          );
        } finally {
          setResendingMessageId(null);
        }
        return;
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
    cancelStreamMessageUpdate();
    controller.abort();
    setIsReplying(false);

    if (pendingReply) {
      const duration =
        pendingReply.reasoningStartedAt === undefined
          ? pendingReply.assistantMessage.reasoningDurationSeconds
          : Math.max(
              1,
              Math.round(
                ((pendingReply.reasoningLastAt ??
                  pendingReply.reasoningStartedAt) -
                  pendingReply.reasoningStartedAt) /
                  1_000,
              ),
            );
      const stoppedAssistant: ChatMessage = {
        ...pendingReply.assistantMessage,
        content:
          pendingReply.assistantMessage.content.trim() || "已停止生成。",
        ...(duration !== undefined
          ? { reasoningDurationSeconds: duration }
          : {}),
        stopped: true,
        isStreaming: false,
        streamLabel: undefined,
      };
      setMessages((current) =>
        current.map((message) =>
          message.id === stoppedAssistant.id ? stoppedAssistant : message,
        ),
      );

      if (!pendingReply.conversationId) return;
      const { conversationId, userMessage } = pendingReply;
      void appendConversationMessages(conversationId, [
        { role: userMessage.role, content: userMessage.content },
        conversationMessageForStorage(stoppedAssistant),
      ])
        .then((savedMessages) => {
          const savedUser = savedMessages[0];
          const savedAssistant = savedMessages[1];
          setMessages((current) =>
            current.map((message) => {
              if (message.id === userMessage.id && savedUser) {
                return { ...message, id: savedUser.id };
              }
              if (message.id === stoppedAssistant.id && savedAssistant) {
                return { ...message, id: savedAssistant.id };
              }
              return message;
            }),
          );
          touchConversationItem(conversationId);
        })
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

  const branchProgress = analysisBranches.transcript.status === "skipped"
    ? analysisBranches.summary.progress
    : (analysisBranches.summary.progress + analysisBranches.transcript.progress) / 2;
  const targetProgress =
    processingStages.length > 0
      ? ((stageIndex + Math.max(0, Math.min(1, stageIndex === 3 ? branchProgress : stageProgress))) /
          processingStages.length) *
        100
      : 0;
  useEffect(() => {
    if (phase !== "processing" || stageIndex !== 3) return;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      setAnalysisBranches((current) => {
        const advance = (key: keyof AnalysisBranches): AnalysisBranch => current[key].status !== "running" || (key === "transcript" && current[key].totalChunks !== undefined)
          ? current[key]
          : { ...current[key], progress: Math.max(current[key].progress,
              estimatedStageProgress(key === "summary" ? "qwen" : "transcript", performance.now() - startedAt, processingDurationSeconds, key === "summary" ? 0.15 : 0.1)) };
        return { summary: advance("summary"), transcript: advance("transcript") };
      });
    }, 400);
    return () => window.clearInterval(timer);
  }, [stageIndex, phase, processingDurationSeconds]);

  useEffect(() => {
    targetProgressRef.current = targetProgress;
  }, [targetProgress]);

  useEffect(() => {
    if (phase !== "processing") return;
    const timer = window.setInterval(() => {
      setDisplayedProgress((current) =>
        advanceDisplayedProgress(current, targetProgressRef.current),
      );
    }, 200);
    return () => window.clearInterval(timer);
  }, [phase]);

  const progress = Math.round(displayedProgress);

  const shownSource = activeSource ?? pendingSource;
  const activeConversationTitle = activeConversationId
    ? conversationItems.find((item) => item.id === activeConversationId)?.title
    : null;
  const canFetchVideo =
    mode !== "upload" && pendingSource !== null && pendingSource.kind !== "upload";
  const fetchVideoLabel =
    mode === "bilibili" && directVideoUrl ? "预览视频" : "获取视频";

  function seekToTimeline(time: string) {
    const seconds = timestampToSeconds(time);
    if (seconds === null || !videoPreview) return;
    seekToSeconds(seconds);
  }

  function seekToSeconds(seconds: number) {
    if (!videoPreview) return;
    if (!seekVideoPlayer(seconds)) return;
    sideVideoPreviewRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
  }

  function renderVideoPreviewCard(placement: "conversation" | "side") {
    if (!videoPreview) return null;
    return (
      <VideoPreviewCard
        preview={videoPreview}
        placement={placement}
        playerRef={videoPlayerRef}
        isFullscreen={isVideoFullscreen}
        isExtractingTranscript={isExtractingTranscript}
        transcriptExtractionProgress={transcriptExtractionProgress}
        transcriptChunkProgress={transcriptChunkProgress}
        canExtractTranscript={Boolean(
          phase === "ready" && summary && activeConversationId,
        )}
        downloadAction={renderVideoDownloadButton()}
        descriptionParagraphs={summaryParagraphs(
          videoPreview.description ?? "",
        )}
        onChooseFile={() => fileInputRef.current?.click()}
        onExtractTranscript={() => void handleExtractTranscript()}
        onToggleFullscreen={toggleVideoFullscreen}
        onVideoClick={handleVideoClick}
        onVideoDoubleClick={handleVideoDoubleClick}
        onSyncAudio={syncPreviewAudio}
        onVideoError={() =>
          showNotice(
            videoPreview.kind === "local"
              ? "本地视频无法播放，请确认文件仍在原路径且编码受支持。"
              : "视频暂时无法播放，请重新获取视频。",
          )
        }
        onLoadedMetadata={(player) => {
          const duration = player.duration;
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
          applyPendingVideoSeek(player);
        }}
      />
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
                <small>Qwen-Audio-3.0-ASR-Flash 在线识别</small>
              </span>
              <input
                type="checkbox"
                checked={shouldExtractTranscript}
                onChange={(event) =>
                  updateTranscriptExtraction(event.target.checked)
                }
              />
              <i aria-hidden="true" />
            </label>
            <details
              className="transcript-language-settings"
              aria-disabled={!shouldExtractTranscript}
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
              <fieldset disabled={!shouldExtractTranscript}>
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

  function renderHistoryMenu() {
    return (
      <div className="history-menu" ref={historyMenuRef}>
        <button
          ref={historyButtonRef}
          className="history-button"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={isHistoryMenuOpen}
          aria-controls="conversation-history-popover"
          onClick={() => setIsHistoryMenuOpen((current) => !current)}
        >
          <span className="history-button-icon" aria-hidden="true">
            ◷
          </span>
          历史记录
        </button>

        {isHistoryMenuOpen ? (
          <section
            id="conversation-history-popover"
            className="settings-popover history-popover"
            role="dialog"
            aria-modal="false"
            aria-labelledby="conversation-history-title"
          >
            <div className="settings-popover-header history-popover-header">
              <div>
                <span>历史记录</span>
                <h2 id="conversation-history-title">视频对话</h2>
              </div>
              <div className="history-popover-actions">
                <button
                  type="button"
                  className="settings-close-button"
                  aria-label="关闭历史记录"
                  onClick={() => {
                    setIsHistoryMenuOpen(false);
                    historyButtonRef.current?.focus();
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            {conversationListError ? (
              <p className="history-popover-error" role="status">
                {conversationListError}
              </p>
            ) : null}

            <div className="conversation-list history-popover-list">
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
                              event.stopPropagation();
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
                          onClick={() => {
                            setIsHistoryMenuOpen(false);
                            void handleSelectConversation(item.id);
                          }}
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
                            disabled={
                              phase === "processing" || busyConversationId === item.id
                            }
                            onClick={() => beginRenameConversation(item)}
                          >
                            ✎
                          </button>
                          <button
                            className="delete"
                            type="button"
                            aria-label={`删除“${item.title}”`}
                            title="删除"
                            disabled={
                              phase === "processing" || busyConversationId === item.id
                            }
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
          </section>
        ) : null}
      </div>
    );
  }

  const workspaceStyle = {
    ...(sidebarWidth === null
      ? {}
      : { "--sidebar-width": `${sidebarWidth}px` }),
  } as CSSProperties;
  const workspaceWidthBounds = sidebarWidthLimitsFor(
    workspaceMeasurements.workspaceWidth,
  );
  const measuredSidebarWidth = clampTo(
    workspaceMeasurements.sidebarWidth,
    workspaceWidthBounds.min,
    workspaceWidthBounds.max,
  );

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="topbar-brand-actions">
          <a className="brand" href="#top" aria-label="帧记首页">
            <span className="brand-mark" aria-hidden="true">
              帧
            </span>
            <span className="brand-copy">
              <strong>帧记</strong>
              <small>FrameNote</small>
            </span>
          </a>
          <button
            className="conversation-new-button topbar-new-button"
            type="button"
            onClick={() => {
              setIsHistoryMenuOpen(false);
              resetWorkspace();
            }}
            disabled={phase === "processing"}
          >
            <span aria-hidden="true">＋</span>
            新建
          </button>
          {renderHistoryMenu()}
        </div>

        <div className="topbar-actions">
          <UsageGuide />
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
          className="setup-column"
          id="workspace-sidebar"
          ref={setupColumnRef}
          aria-label="添加视频"
        >
          <SourcePanel
            mode={mode}
            phase={phase}
            selectedVideo={selectedVideo}
            bilibiliInput={bilibiliInput}
            bvid={bvid}
            directVideoUrl={directVideoUrl}
            douyinInput={douyinInput}
            douyinUrl={douyinUrl}
            notice={notice}
            isDragging={isDragging}
            isFetchingVideo={isFetchingVideo}
            canFetchVideo={canFetchVideo}
            canAnalyze={Boolean(pendingSource)}
            fetchVideoLabel={fetchVideoLabel}
            showingSideVideo={phase === "ready" && Boolean(videoPreview)}
            fileInputRef={fileInputRef}
            sideVideoPreviewRef={sideVideoPreviewRef}
            analysisSettings={renderAnalysisSettings()}
            sideVideo={renderVideoPreviewCard("side")}
            onModeChange={selectMode}
            onFileChange={handleFileChange}
            onDraggingChange={setIsDragging}
            onDrop={handleDrop}
            onSelectedVideoMetadata={(objectUrl, metadata) =>
              setSelectedVideo((current) =>
                current?.objectUrl === objectUrl
                  ? { ...current, ...metadata }
                  : current,
              )
            }
            onBilibiliInputChange={(value) => {
              setBilibiliInput(value);
              clearVideoPreview();
              setNotice(null);
            }}
            onDouyinInputChange={(value) => {
              setDouyinInput(value);
              clearVideoPreview();
              setNotice(null);
            }}
            onFetchVideo={() => void handleFetchVideo()}
            onAnalyze={() => void handleAnalyze()}
          />
        </section>

        <div
          className="workspace-resizer"
          role="separator"
          aria-label="调整侧边栏与对话板块的宽度"
          aria-orientation="vertical"
          aria-valuemin={workspaceWidthBounds.min}
          aria-valuemax={workspaceWidthBounds.max}
          aria-valuenow={sidebarWidth ?? measuredSidebarWidth}
          tabIndex={sidebarVisible ? 0 : -1}
          onPointerDown={beginSidebarResize}
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
            <div className="conversation-header-actions">
              {usageRecords.length > 0 ? (
                <div className="conversation-usage" ref={usageMenuRef}>
                  <button
                    className="conversation-usage-summary"
                    type="button"
                    aria-expanded={isUsageMenuOpen}
                    onClick={() => setIsUsageMenuOpen((current) => !current)}
                    title={`${formatUsageTokens(
                      conversationUsageTotals.totalTokens,
                    )} tokens，搜索 ${conversationUsageTotals.searchCount} 次`}
                  >
                    <span>
                      总{" "}
                      {formatCompactUsageTokens(
                        conversationUsageTotals.totalTokens,
                      )}{" "}
                      tokens · 搜索 {conversationUsageTotals.searchCount} 次
                    </span>
                    <i aria-hidden="true">⌄</i>
                  </button>
                  {isUsageMenuOpen ? (
                    <div className="conversation-usage-popover">
                      <div className="conversation-usage-heading">
                        <strong>Token 用量</strong>
                        <span>以 API 服务商返回值为准</span>
                      </div>
                      <div className="conversation-usage-list">
                        {usageRecords.map(({ messageId, usage }, index) => (
                          <div
                            className="conversation-usage-row"
                            key={`${messageId}-${usage.createdAt}`}
                          >
                            <span>
                              {usage.kind === "summary"
                                ? "视频总结"
                                : `问答 ${
                                    usageRecords
                                      .slice(0, index + 1)
                                      .filter(
                                        (record) =>
                                          record.usage.kind === "answer",
                                      ).length
                                  }`}
                            </span>
                            <span>
                              {formatUsageTokens(usage.totalTokens)} tokens ·{" "}
                              搜索 {usage.searchCount} 次 ·{" "}
                              {formatUsageTime(usage.createdAt)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {phase !== "ready" ? (
  <span className={`phase-badge ${phase}`}>
    {phase === "processing"
      ? "处理中"
      : phase === "error"
        ? "需重试"
        : "未开始"}
  </span>
) : null}
              {phase !== "ready" ? renderVideoDownloadButton() : null}
            </div>
          </div>

          <div
            className="conversation-scroll"
            ref={conversationScrollRef}
            aria-live="polite"
          >
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
                    <strong title="Qwen 与字幕阶段为基于视频时长的保守估算">
                      {progress}%
                    </strong>
                  </div>
                  <div className="progress-track" aria-hidden="true">
                    <span style={{ width: `${displayedProgress}%` }} />
                  </div>
                </div>

                <AnalysisProgress stages={processingStages} stageIndex={stageIndex} branches={analysisBranches} />

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
                            aria-label={`跳转到 ${formatTimelineTimestamp(item.time)}`}
                          >
                            <time>{formatTimelineTimestamp(item.time)}</time>
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
                        <span>Qwen Audio</span>
                      </div>
                      {transcript.status === "ready" ? (
                        transcript.cues.length > 0 ? (
                          <div
                            className="transcript-list virtualized"
                            ref={transcriptListRef}
                          >
                            <div
                              className="transcript-virtual-space"
                              style={{
                                height: `${transcriptVirtualizer.getTotalSize()}px`,
                              }}
                            >
                            {transcriptVirtualizer.getVirtualItems().map((virtualRow) => {
                              const index = virtualRow.index;
                              const cue = transcriptCues[index];
                              if (!cue) return null;
                              return (
                              <div
                                className={`transcript-virtual-row${index > 0 ? " has-divider" : ""}`}
                                data-index={index}
                                ref={transcriptVirtualizer.measureElement}
                                key={`${cue.startSeconds}-${index}`}
                                style={{
                                  transform: `translateY(${virtualRow.start}px)`,
                                }}
                              >
                              <div className="transcript-row">
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
                              </div>
                              );
                            })}
                            </div>
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

                <div
                  className="message-list virtualized"
                  ref={messageListRef}
                  style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
                >
                  {messageVirtualizer.getVirtualItems().map((virtualRow) => {
                    const messageIndex = virtualRow.index;
                    const message = messages[messageIndex];
                    if (!message) return null;
                    return (
                    <div
                      className="message-virtual-row"
                      data-index={messageIndex}
                      ref={messageVirtualizer.measureElement}
                      key={message.id}
                      style={{
                        transform: `translateY(${virtualRow.start - messageListOffset}px)`,
                      }}
                    >
                    <div
                      className={`message ${message.role}${
                        message.id === lastAssistantMessageId
                          ? " is-latest-assistant"
                          : ""
                      }${
                        message.id === hoveredMessageId
                          ? " is-actions-visible"
                          : ""
                      }`}
                      onPointerEnter={() => setHoveredMessageId(message.id)}
                      onPointerLeave={() =>
                        setHoveredMessageId((current) =>
                          current === message.id ? null : current,
                        )
                      }
                      onPointerCancel={() =>
                        setHoveredMessageId((current) =>
                          current === message.id ? null : current,
                        )
                      }
                    >
                      <div className="message-body">
                        {message.role === "assistant" &&
                        message.reasoningContent ? (
                          <ReasoningPanel
                            content={message.reasoningContent}
                            durationSeconds={message.reasoningDurationSeconds}
                            isStreaming={message.isStreaming}
                            hasAnswer={Boolean(message.content)}
                          />
                        ) : null}
                        <div
                          className={
                            message.role === "assistant"
                              ? "message-answer-card"
                              : "message-user-answer"
                          }
                        >
                          {message.content ? (
                            <MarkdownMessage
                              content={message.content}
                              isCompleted={!message.isStreaming}
                              isExpanded={expandedMessageIds.has(message.id)}
                              onToggleExpanded={() => {
                                setExpandedMessageIds((current) => {
                                  const next = new Set(current);
                                  if (next.has(message.id)) next.delete(message.id);
                                  else next.add(message.id);
                                  return next;
                                });
                              }}
                              onVideoTimeClick={
                                message.role === "assistant" && videoPreview
                                  ? seekToSeconds
                                  : undefined
                              }
                            />
                          ) : message.isStreaming ? (
                            <span
                              className="stream-status"
                              aria-label={message.streamLabel ?? "正在生成回答"}
                            >
                              <span>{message.streamLabel ?? "正在生成回答"}</span>
                              <i />
                              <i />
                              <i />
                            </span>
                          ) : null}
                          {message.role === "assistant" &&
                          message.webSources?.length ? (
                            <WebSourcesPanel sources={message.webSources} />
                          ) : message.role === "assistant" &&
                            message.webSearch ? (
                            <WebSearchStatusPanel search={message.webSearch} />
                          ) : null}
                          {message.stopped &&
                          message.content !== "已停止生成。" ? (
                            <span className="message-stopped">已停止生成</span>
                          ) : null}
                          {message.role === "assistant" &&
                          !message.isStreaming ? (
                            <div className="message-answer-footer">
                              <div className="message-answer-actions">
                                <button
                                  type="button"
                                  onClick={() => void copyMessage(message)}
                                  disabled={!message.content}
                                  aria-label={
                                    copiedMessageId === message.id
                                      ? "已复制回答"
                                      : "复制回答"
                                  }
                                  title={
                                    copiedMessageId === message.id
                                      ? "已复制"
                                      : "复制"
                                  }
                                >
                                  {copiedMessageId === message.id ? (
                                    <span aria-hidden="true">✓</span>
                                  ) : (
                                    <svg
                                      viewBox="0 0 24 24"
                                      aria-hidden="true"
                                    >
                                      <rect
                                        x="8"
                                        y="8"
                                        width="11"
                                        height="11"
                                        rx="2"
                                      />
                                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                                    </svg>
                                  )}
                                </button>
                                {messages
                                  .slice(0, messageIndex)
                                  .some(
                                    (candidate) =>
                                      candidate.role === "user",
                                  ) ? (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void resendAssistantAnswer(messageIndex);
                                    }}
                                    disabled={
                                      isReplying ||
                                      Boolean(resendingMessageId)
                                    }
                                    aria-label="重新发送上一条问题"
                                    title="重发"
                                  >
                                    <svg
                                      viewBox="0 0 24 24"
                                      aria-hidden="true"
                                    >
                                      <path d="M4 10V5m0 0h5M4 5l4 4a7 7 0 1 1-1.2 8.8" />
                                    </svg>
                                  </button>
                                ) : null}
                              </div>
                              <time dateTime={new Date(message.createdAt).toISOString()}>
                                {formatAnswerTime(message.createdAt)}
                              </time>
                            </div>
                          ) : null}
                          {message.role === "user" ? (
                            <div className="message-answer-footer">
                              <div className="message-answer-actions">
                                <button
                                  type="button"
                                  onClick={() => void copyMessage(message)}
                                  disabled={!message.content}
                                  aria-label={
                                    copiedMessageId === message.id
                                      ? "已复制消息"
                                      : "复制消息"
                                  }
                                  title={
                                    copiedMessageId === message.id
                                      ? "已复制"
                                      : "复制"
                                  }
                                >
                                  {copiedMessageId === message.id ? (
                                    <span aria-hidden="true">✓</span>
                                  ) : (
                                    <svg
                                      viewBox="0 0 24 24"
                                      aria-hidden="true"
                                    >
                                      <rect
                                        x="8"
                                        y="8"
                                        width="11"
                                        height="11"
                                        rx="2"
                                      />
                                      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    </div>
                    );
                  })}
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
                <button
                  type="button"
                  aria-pressed={fullRecallEnabled}
                  onClick={() =>
                    updateChatSetting("fullRecall", !fullRecallEnabled)
                  }
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5z" />
                    <path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5z" />
                  </svg>
                  完整回顾
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
            <p className="composer-caption">内容由AI生成，请仔细甄别。</p>
          </div>
        </section>
      </div>
    </main>
  );
}
