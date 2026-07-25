"use client";

import {
  type ReactNode,
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
  type PersistedVideoDescriptor,
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
  LOCAL_VIDEO_PREPROCESSING_LIMITS,
  extractVideoEvidence,
  type VideoPreprocessingResult,
  type VideoPreprocessingStage,
} from "@/lib/client/video-preprocessor";
import {
  MAX_BILIBILI_BROWSER_BYTES,
  downloadBilibiliVideo,
  isReusableBilibiliDownload,
  type BilibiliDownloadResult,
} from "@/lib/client/bilibili-client";
import {
  appendConversationMessages,
  conversationVideoUrl,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  renameConversation,
  storeConversationVideo,
} from "@/lib/client/conversation-client";
import type {
  ConversationListItem,
  ConversationMessage,
} from "@/lib/conversation";
import UserSettingsMenu from "@/app/UserSettingsMenu";

type InputMode = "upload" | "bilibili";
type Phase = "idle" | "processing" | "ready" | "error";

interface SelectedVideo {
  file: File;
  objectUrl: string;
  duration?: number;
}

interface VideoPreview {
  kind: "downloaded" | "local" | "remote" | "stored";
  playbackUrl: string;
  filename: string;
  title?: string;
  description: string;
  sizeLabel?: string;
  durationLabel?: string;
  qualityLabel?: string;
  sourceLabel?: string;
}

interface InlineNotice {
  message: string;
  tone: "error" | "success";
}

type ChatMessage = Pick<ConversationMessage, "id" | "role" | "content">;

const acceptedExtensions = ["mp4", "mov", "webm", "mkv", "m4v"];
const preprocessingStageIndexes: Record<VideoPreprocessingStage, number> = {
  "loading-engine": 1,
  "extracting-audio": 2,
  "extracting-frames": 3,
};

const suggestions = ["这个视频的核心观点是什么？", "按时间线梳理章节", "给我三个行动建议"];
const SUMMARY_READY_MESSAGE = "总结生成完毕，我还可以继续和你讨论相关内容 : )";

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

function videoMimeType(file: File) {
  if (/^video\//i.test(file.type)) return file.type.split(";")[0];
  const extension = fileExtension(file.name);
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  if (extension === "mkv") return "video/x-matroska";
  return "video/mp4";
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

function renderInlineMarkdown(value: string, keyPrefix: string): ReactNode[] {
  return value.split(/(\*\*[^*\n]+\*\*)/g).filter(Boolean).map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={`${keyPrefix}-strong-${index}`}>{part.slice(2, -2)}</strong>
    ) : (
      <span key={`${keyPrefix}-text-${index}`}>{part}</span>
    ),
  );
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

function bilibiliPreviewQualityLabel(result: BilibiliDownloadResult) {
  const dimensions = result.width && result.height
    ? `实际 ${result.width}×${result.height}`
    : "实际分辨率未知";
  return `${dimensions} · 最高兼容清晰度`;
}

function stagesFor(
  source: VideoSourceDescriptor,
  reusesBilibiliVideo = false,
) {
  if (source.kind === "upload") {
    return [
      "校验视频文件",
      "加载本地媒体引擎",
      "抽取并压缩音轨",
      "提取代表性关键帧",
      "Qwen 融合音轨与画面",
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

  return [
    "校验 B 站视频地址",
    reusesBilibiliVideo ? "复用已获取的视频" : "下载并合并公开视频",
    "压缩画面并提取音轨与关键帧",
    "Qwen 融合声音与画面",
    "生成结构化总结",
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
  const [preprocessingResult, setPreprocessingResult] =
    useState<VideoPreprocessingResult | null>(null);
  const [notice, setNotice] = useState<InlineNotice | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [previewBilibiliVideo, setPreviewBilibiliVideo] =
    useState<BilibiliDownloadResult | null>(null);
  const [isFetchingVideo, setIsFetchingVideo] = useState(false);
  const [videoPreview, setVideoPreview] = useState<VideoPreview | null>(null);
  const [videoPreviewFailed, setVideoPreviewFailed] = useState(false);
  const [conversationItems, setConversationItems] = useState<ConversationListItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [isConversationListLoading, setIsConversationListLoading] = useState(true);
  const [conversationListError, setConversationListError] = useState<string | null>(null);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [renamingConversationId, setRenamingConversationId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
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
  const downloadedVideoUrlRef = useRef<string | null>(null);
  const videoPlayerRef = useRef<HTMLVideoElement>(null);
  const sideVideoPreviewRef = useRef<HTMLDivElement>(null);
  const pendingSeekSecondsRef = useRef<number | null>(null);

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
      subtitle: "公开 UGC · 等待读取视频信息",
      bvid,
      sourceUrl: `https://www.bilibili.com/video/${bvid}`,
      downloadFirst: true,
    };
  }, [bvid, directVideoUrl, mode, selectedVideo]);

  useEffect(() => {
    return () => {
      if (selectedVideo?.objectUrl) URL.revokeObjectURL(selectedVideo.objectUrl);
    };
  }, [selectedVideo?.objectUrl]);

  useEffect(() => {
    return () => {
      if (downloadedVideoUrlRef.current) {
        URL.revokeObjectURL(downloadedVideoUrlRef.current);
        downloadedVideoUrlRef.current = null;
      }
    };
  }, []);

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

  function releaseDownloadedVideoUrl() {
    if (!downloadedVideoUrlRef.current) return;
    URL.revokeObjectURL(downloadedVideoUrlRef.current);
    downloadedVideoUrlRef.current = null;
  }

  function clearVideoPreview() {
    releaseDownloadedVideoUrl();
    setVideoPreview(null);
    setVideoPreviewFailed(false);
  }

  function showRemoteVideo(url: string) {
    releaseDownloadedVideoUrl();
    setVideoPreview({
      kind: "remote",
      playbackUrl: url,
      filename: titleFromUrl(url),
      title: titleFromUrl(url),
      description: "播放器直接读取 HTTPS 视频直链；是否能保存由源站响应设置决定。",
      sourceLabel: "HTTPS 视频直链",
    });
    setVideoPreviewFailed(false);
  }

  function showLocalVideo(video: SelectedVideo) {
    releaseDownloadedVideoUrl();
    setVideoPreview({
      kind: "local",
      playbackUrl: video.objectUrl,
      filename: video.file.name,
      title: titleFromFilename(video.file.name),
      description: "本地原视频已用于本次分析；总结保存后会同步保存到当前视频对话。",
      sizeLabel: formatFileSize(video.file.size),
      durationLabel: video.duration ? formatDuration(video.duration) : undefined,
      sourceLabel: "本地上传",
    });
    setVideoPreviewFailed(false);
  }

  function showStoredVideo(
    conversationId: string,
    video: PersistedVideoDescriptor,
  ) {
    releaseDownloadedVideoUrl();
    const url = conversationVideoUrl(conversationId);
    setVideoPreview({
      kind: "stored",
      playbackUrl: url,
      filename: video.filename,
      title: video.title,
      description: video.description,
      sizeLabel: formatFileSize(video.sizeBytes),
      durationLabel: video.durationLabel,
      qualityLabel: video.qualityLabel,
      sourceLabel: video.sourceLabel,
    });
    setVideoPreviewFailed(false);
  }

  function showDownloadedVideo(result: BilibiliDownloadResult) {
    releaseDownloadedVideoUrl();
    const objectUrl = URL.createObjectURL(result.file);
    downloadedVideoUrlRef.current = objectUrl;
    setVideoPreview({
      kind: "downloaded",
      playbackUrl: objectUrl,
      filename: result.file.name || "bilibili-video.mp4",
      title: result.title,
      description: "视频已下载并合并，可直接预览；AI 总结会复用此视频，并在分析前压缩画面、音轨与关键帧。",
      sizeLabel: formatFileSize(result.sizeBytes),
      durationLabel: formatDuration(result.durationSeconds),
      qualityLabel: bilibiliPreviewQualityLabel(result),
      sourceLabel: result.bvid,
    });
    setVideoPreviewFailed(false);
  }

  function clearDownloadedBilibiliState() {
    setPreviewBilibiliVideo(null);
    if (videoPreview?.kind === "downloaded") {
      clearVideoPreview();
    }
  }

  function selectMode(nextMode: InputMode) {
    if (phase === "processing") return;
    setMode(nextMode);
    if (nextMode === "upload") {
      setPreviewBilibiliVideo(null);
      if (videoPreview?.kind === "downloaded") clearVideoPreview();
    }
    setNotice(null);
  }

  function acceptFile(file: File) {
    if (phase === "processing") return;
    const extension = fileExtension(file.name);

    if (!acceptedExtensions.includes(extension)) {
      showNotice("暂不支持这个文件格式，请选择 MP4、MOV、WebM、MKV 或 M4V 视频。");
      return;
    }

    if (file.size > LOCAL_VIDEO_PREPROCESSING_LIMITS.maxSourceBytes) {
      showNotice(
        `浏览器本地处理暂时支持不超过 ${Math.round(
          LOCAL_VIDEO_PREPROCESSING_LIMITS.maxSourceBytes / 1024 / 1024,
        )} MB 的视频；更大文件请使用 HTTPS 视频直链。`,
      );
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSelectedVideo({ file, objectUrl });
    setPreviewBilibiliVideo(null);
    setPreprocessingResult(null);
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

  async function fetchBilibiliDownload(
    source: VideoSourceDescriptor,
    controller: AbortController,
    runToken: number,
    options: { showPreview?: boolean } = {},
  ) {
    if (!source.bvid) {
      throw new Error("没有可下载的 BV 号。");
    }
    const cached = previewBilibiliVideo;
    if (isReusableBilibiliDownload(cached, source.bvid)) {
      if (options.showPreview && cached) showDownloadedVideo(cached);
      return cached as BilibiliDownloadResult;
    }

    const downloaded = await downloadBilibiliVideo(source.bvid, {
      variant: "preview",
      signal: controller.signal,
      onProgress: ({ stage, progress }) => {
        if (runTokenRef.current !== runToken) return;
        setStageIndex(1);
        setStageProgress(
          stage === "preparing"
            ? Math.min(0.78, progress * 0.78)
            : 0.78 + progress * 0.22,
        );
      },
    });
    if (runTokenRef.current !== runToken) return null;

    setPreviewBilibiliVideo(downloaded);
    if (options.showPreview) showDownloadedVideo(downloaded);
    return downloaded;
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
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    const controller = new AbortController();
    fetchVideoAbortRef.current = controller;

    setNotice(null);
    setSummary(null);
    setActiveModel(null);
    setMessages([]);
    setActiveConversationId(null);
    setPreprocessingResult(null);
    setActiveSource(pendingSource);

    if (pendingSource.kind === "url" && pendingSource.sourceUrl) {
      showRemoteVideo(pendingSource.sourceUrl);
      setPhase("idle");
      showNotice(
        "视频直链已准备好，可预览；点击生成 AI 总结后再开始分析。",
        "success",
      );
      if (fetchVideoAbortRef.current === controller) fetchVideoAbortRef.current = null;
      return;
    }

    const stages = ["校验 B 站视频地址", "下载并合并公开视频"];
    setIsFetchingVideo(true);
    setPhase("processing");
    setProcessingStages(stages);
    setStageIndex(0);
    setStageProgress(0.15);

    try {
      const downloaded = await fetchBilibiliDownload(
        pendingSource,
        controller,
        runToken,
        { showPreview: true },
      );
      if (!downloaded || runTokenRef.current !== runToken) return;
      setActiveSource({
        ...pendingSource,
        title: downloaded.title,
        durationLabel: formatDuration(downloaded.durationSeconds),
        subtitle: `${downloaded.bvid} · ${formatFileSize(
          downloaded.sizeBytes,
        )} · ${formatDuration(downloaded.durationSeconds)} · ${bilibiliPreviewQualityLabel(
          downloaded,
        )}`,
      });
      setStageIndex(stages.length);
      setStageProgress(1);
      setPhase("idle");
      showNotice(
        "视频已获取，可预览或下载；点击生成 AI 总结后再开始分析。",
        "success",
      );
    } catch (error) {
      if (runTokenRef.current !== runToken) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPhase("error");
      showNotice(
        error instanceof Error ? error.message : "获取视频失败，请检查链接后重试。",
      );
    } finally {
      if (fetchVideoAbortRef.current === controller) fetchVideoAbortRef.current = null;
      if (runTokenRef.current === runToken) setIsFetchingVideo(false);
    }
  }

  async function handleAnalyze() {
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
    fetchVideoAbortRef.current?.abort();
    fetchVideoAbortRef.current = null;
    setIsFetchingVideo(false);
    askAbortRef.current?.abort();
    askAbortRef.current = null;
    pendingReplyRef.current = null;
    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    const reusableBilibiliVideo =
      pendingSource.kind === "bilibili" &&
      isReusableBilibiliDownload(previewBilibiliVideo, pendingSource.bvid)
        ? previewBilibiliVideo
        : null;
    const stages = stagesFor(pendingSource, Boolean(reusableBilibiliVideo));

    setNotice(null);
    setPhase("processing");
    setSummary(null);
    setActiveModel(null);
    setMessages([]);
    setActiveConversationId(null);
    setActiveSource(pendingSource);
    setProcessingStages(stages);
    setStageIndex(0);
    setStageProgress(0.2);
    setPreprocessingResult(null);
    if (pendingSource.kind === "url" && pendingSource.sourceUrl) {
      showRemoteVideo(pendingSource.sourceUrl);
    } else if (pendingSource.kind === "upload") {
      if (selectedVideo) showLocalVideo(selectedVideo);
    }

    try {
      let context: VideoModelContext;
      let analysisSource = pendingSource;
      let analyzedBilibiliVideo: BilibiliDownloadResult | null = null;
      if (pendingSource.kind === "upload") {
        if (!selectedVideo?.duration) {
          throw new Error("尚未读取到视频时长，请稍后重试。");
        }
        const extracted = await extractVideoEvidence(selectedVideo.file, {
          durationSeconds: selectedVideo.duration,
          signal: controller.signal,
          onProgress: ({ stage, progress }) => {
            if (runTokenRef.current !== runToken) return;
            setStageIndex(preprocessingStageIndexes[stage]);
            setStageProgress(progress);
          },
        });
        context = extracted.context;
        setPreprocessingResult(extracted);
      } else if (pendingSource.kind === "bilibili") {
        if (!pendingSource.bvid) {
          throw new Error("没有可下载的 BV 号。");
        }
        setStageIndex(1);
        setStageProgress(0);
        if (reusableBilibiliVideo) {
          setStageProgress(1);
        }
        const downloaded = reusableBilibiliVideo ?? await fetchBilibiliDownload(
          pendingSource,
          controller,
          runToken,
        );
        if (!downloaded) return;
        if (runTokenRef.current !== runToken) return;
        analyzedBilibiliVideo = downloaded;

        analysisSource = {
          ...pendingSource,
          title: downloaded.title,
          durationLabel: formatDuration(downloaded.durationSeconds),
          subtitle: `${downloaded.bvid} · ${formatFileSize(
            downloaded.sizeBytes,
          )} · ${formatDuration(downloaded.durationSeconds)} · ${bilibiliPreviewQualityLabel(
            downloaded,
          )} · 分析时压缩画面`,
        };
        setActiveSource(analysisSource);
        setStageIndex(2);
        setStageProgress(0);
        const extracted = await extractVideoEvidence(downloaded.file, {
          durationSeconds: downloaded.durationSeconds,
          requireAudio: true,
          signal: controller.signal,
          onProgress: ({ stage, progress }) => {
            if (runTokenRef.current !== runToken) return;
            setStageIndex(2);
            if (stage === "loading-engine") {
              setStageProgress(progress * 0.1);
            } else if (stage === "extracting-audio") {
              setStageProgress(0.1 + progress * 0.45);
            } else {
              setStageProgress(0.55 + progress * 0.45);
            }
          },
        });
        context = extracted.context;
        setPreprocessingResult(extracted);
      } else {
        const videoUrl = pendingSource.sourceUrl;
        if (!videoUrl) throw new Error("没有可提交给模型的视频输入。");
        setStageIndex(1);
        setStageProgress(1);
        setStageIndex(2);
        setStageProgress(1);
        context = { videoUrl, fps: 0.5 };
      }
      if (runTokenRef.current !== runToken) return;
      setStageIndex(stages.length - 2);
      setStageProgress(0.15);
      const result = await analyzeVideo(
        {
          source: analysisSource,
          context,
        },
        controller.signal,
      );
      if (runTokenRef.current !== runToken) return;

      setStageIndex(stages.length - 1);
      setStageProgress(1);
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
        });
        if (runTokenRef.current !== runToken) return;
        setActiveConversationId(saved.id);
        upsertConversationItem(saved);
        setConversationListError(null);

        const bilibiliVideo =
          analysisSource.kind === "bilibili"
            ? previewBilibiliVideo ?? analyzedBilibiliVideo
            : null;
        const videoFile =
          analysisSource.kind === "upload"
            ? selectedVideo?.file ?? null
            : bilibiliVideo?.file ?? null;
        if (videoFile) {
          if (bilibiliVideo && !videoPreview) showDownloadedVideo(bilibiliVideo);
          const persistedVideo: PersistedVideoDescriptor = {
            filename: videoFile.name || "video.mp4",
            mimeType: videoMimeType(videoFile),
            sizeBytes: videoFile.size,
            title: analysisSource.title,
            description:
              analysisSource.kind === "bilibili"
                ? "该视频已随对话保存，可直接预览、下载，并可通过总结时间点跳转。"
                : "本地原视频已随对话保存，可直接预览、下载，并可通过总结时间点跳转。",
            durationLabel:
              bilibiliVideo
                ? formatDuration(bilibiliVideo.durationSeconds)
                : selectedVideo?.duration
                  ? formatDuration(selectedVideo.duration)
                  : analysisSource.durationLabel,
            qualityLabel: bilibiliVideo
              ? bilibiliPreviewQualityLabel(bilibiliVideo)
              : undefined,
            sourceLabel: bilibiliVideo?.bvid ?? "本地上传",
          };
          try {
            const storedSource = await storeConversationVideo(
              saved.id,
              videoFile,
              persistedVideo,
              controller.signal,
            );
            if (runTokenRef.current !== runToken) return;
            setActiveSource(storedSource);
          } catch (videoSaveError) {
            if (runTokenRef.current !== runToken) return;
            setConversationListError(
              videoSaveError instanceof Error
                ? `总结已保存，但视频持久化失败：${videoSaveError.message}`
                : "总结已保存，但视频持久化失败。",
            );
          }
        }
      } catch (saveError) {
        if (runTokenRef.current !== runToken) return;
        setConversationListError(
          saveError instanceof Error
            ? `总结已生成，但保存对话失败：${saveError.message}`
            : "总结已生成，但保存对话失败。",
        );
      }
      if (runTokenRef.current !== runToken) return;
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
    setActiveModel(null);
    setActiveSource(null);
    setProcessingStages([]);
    setStageIndex(-1);
    setStageProgress(0);
    setPreprocessingResult(null);
    setPreviewBilibiliVideo(null);
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
    if (phase === "processing" || busyConversationId || loadingConversationId === id) {
      return;
    }

    conversationLoadAbortRef.current?.abort();
    const controller = new AbortController();
    conversationLoadAbortRef.current = controller;
    setLoadingConversationId(id);
    setConversationListError(null);

    try {
      const conversation = await getConversation(id, controller.signal);
      if (conversationLoadAbortRef.current !== controller) return;

      runTokenRef.current += 1;
      analyzeAbortRef.current?.abort();
      analyzeAbortRef.current = null;
      fetchVideoAbortRef.current?.abort();
      fetchVideoAbortRef.current = null;
      askAbortRef.current?.abort();
      askAbortRef.current = null;
      pendingReplyRef.current = null;
      setIsFetchingVideo(false);
      setPhase("ready");
      setSummary(conversation.summary);
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
      setPreprocessingResult(null);
      setPreviewBilibiliVideo(null);
      setSelectedVideo(null);
      setQuestion("");
      setIsReplying(false);
      upsertConversationItem(conversation);

      if (conversation.source.persistedVideo) {
        setMode(conversation.source.kind === "upload" ? "upload" : "bilibili");
        setBilibiliInput(
          conversation.source.bvid ?? conversation.source.sourceUrl ?? "",
        );
        showStoredVideo(conversation.id, conversation.source.persistedVideo);
        setNotice(null);
      } else if (conversation.source.kind === "url" && conversation.source.sourceUrl) {
        setMode("bilibili");
        setBilibiliInput(conversation.source.sourceUrl);
        showRemoteVideo(conversation.source.sourceUrl);
        setNotice(null);
      } else if (conversation.source.kind === "bilibili") {
        setMode("bilibili");
        setBilibiliInput(
          conversation.source.bvid ?? conversation.source.sourceUrl ?? "",
        );
        clearVideoPreview();
        showNotice(
          "总结和对话已恢复；这个旧对话没有保存视频，如需预览请重新获取。",
          "success",
        );
      } else {
        setMode("upload");
        setBilibiliInput("");
        clearVideoPreview();
        showNotice(
          "总结和对话已恢复；这个旧对话没有保存本地原视频。",
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

  function seekToTimeline(time: string) {
    const seconds = timestampToSeconds(time);
    const player = videoPlayerRef.current;
    if (seconds === null || !player || !videoPreview) return;
    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
      player.currentTime = Math.min(seconds, Number.isFinite(player.duration)
        ? Math.max(0, player.duration - 0.05)
        : seconds);
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
        <span className="video-ready-label">
          {videoPreview.kind === "stored"
            ? "视频已随对话保存"
            : videoPreview.kind === "downloaded"
              ? "视频已下载并合并"
              : videoPreview.kind === "local"
                ? "本地视频已就绪"
                : "HTTPS 视频直链已就绪"}
        </span>
        <strong>{videoPreview.title ?? videoPreview.filename}</strong>
        <div className="video-preview-meta" aria-label="视频信息">
          {videoPreview.sourceLabel ? <span>{videoPreview.sourceLabel}</span> : null}
          {videoPreview.qualityLabel ? <span>{videoPreview.qualityLabel}</span> : null}
          {videoPreview.sizeLabel ? <span>{videoPreview.sizeLabel}</span> : null}
          {videoPreview.durationLabel ? <span>{videoPreview.durationLabel}</span> : null}
        </div>
        <p>
          {videoPreviewFailed
            ? "浏览器无法直接预览，可以尝试打开视频源地址。"
            : videoPreview.description}
        </p>
        {videoPreview.kind === "remote" ? (
          <div className="video-preview-actions">
            <a
              className="video-source-action"
              href={videoPreview.playbackUrl}
              target="_blank"
              rel="noreferrer"
            >
              打开源地址 ↗
            </a>
          </div>
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
            setVideoPreviewFailed(false);
            const pendingSeconds = pendingSeekSecondsRef.current;
            if (pendingSeconds !== null) {
              event.currentTarget.currentTime = Math.min(
                pendingSeconds,
                Math.max(0, event.currentTarget.duration - 0.05),
              );
              pendingSeekSecondsRef.current = null;
              void event.currentTarget.play().catch(() => undefined);
            }
          }}
          onError={() => setVideoPreviewFailed(true)}
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
      </section>
    );
  }

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
          <UserSettingsMenu />
        </div>
      </header>

      <div className="workspace" id="top">
        <section className="setup-column" aria-label="添加并分析视频">
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
                disabled={phase === "processing"}
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
                disabled={phase === "processing"}
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
                    <p>
                      MP4、MOV、WebM、MKV、M4V · 浏览器本地抽取音轨与关键帧 · ≤ {Math.round(
                        LOCAL_VIDEO_PREPROCESSING_LIMITS.maxSourceBytes / 1024 / 1024,
                      )} MB
                    </p>
                    <button
                      type="button"
                      disabled={phase === "processing"}
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
                      clearDownloadedBilibiliState();
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
                  <p className="field-help">
                    视频直链可直接调用 Qwen；B站仅处理你有权分析的公开 UGC，当前上限 {Math.round(
                      MAX_BILIBILI_BROWSER_BYTES / 1024 / 1024,
                    )} MB。
                  </p>
                )}

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
                      <span aria-hidden="true">↧</span>
                    </>
                  )}
                </button>
                <button
                  className="primary-action source-action-primary"
                  type="button"
                  disabled={!pendingSource || phase === "processing" || isFetchingVideo}
                  onClick={() => void handleAnalyze()}
                >
                  {phase === "processing" && !isFetchingVideo ? (
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
            ) : (
              <button
                className="primary-action"
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
            )}

            {phase === "ready" && videoPreview ? (
              <div className="side-video-context" ref={sideVideoPreviewRef}>
                {renderVideoPreviewCard("side")}
              </div>
            ) : null}
          </div>

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
        </section>

        <section className="conversation-panel" aria-labelledby="conversation-title">
          <div className="conversation-header">
            <div>
              <span className="panel-kicker">视频总结对话</span>
              <h2 id="conversation-title">
                {activeConversationTitle ?? shownSource?.title ?? "等待添加视频"}
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
                  </div>

                  <div className="summary-stats">
                    {preprocessingResult ? (
                      <span>
                        <strong>{preprocessingResult.frameCount}</strong> 张关键帧
                      </span>
                    ) : null}
                    {preprocessingResult ? (
                      <span>
                        <strong>
                          {preprocessingResult.audioBytes > 0
                            ? formatFileSize(preprocessingResult.audioBytes)
                            : "未提取"}
                        </strong>{" "}
                        音轨
                      </span>
                    ) : null}
                    <span>
                      <strong>{timelineItems.length}</strong> 个时间点
                    </span>
                    <span>
                      <strong>{activeModel ?? "Qwen"}</strong> 分析引擎
                    </span>
                  </div>

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
                    if (askAbortRef.current) {
                      stopReply();
                      return;
                    }
                    void askQuestion(question);
                  }
                }}
                placeholder={
                  phase === "ready"
                    ? isReplying
                      ? "可以继续输入；停止当前回答后即可发送"
                      : "问问视频里的细节…"
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
