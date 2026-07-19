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
  type SummaryAudioStatus,
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
} from "@/lib/client/bilibili-client";
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
import UserSettingsMenu from "@/app/UserSettingsMenu";

type InputMode = "upload" | "bilibili";
type Phase = "idle" | "processing" | "ready" | "error";

interface SelectedVideo {
  file: File;
  objectUrl: string;
  duration?: number;
}

interface VideoPreview {
  kind: "downloaded" | "remote";
  playbackUrl: string;
  downloadUrl: string;
  filename: string;
}

type ChatMessage = Pick<ConversationMessage, "id" | "role" | "content">;

const acceptedExtensions = ["mp4", "mov", "webm", "mkv", "m4v"];
const preprocessingStageIndexes: Record<VideoPreprocessingStage, number> = {
  "loading-engine": 1,
  "extracting-audio": 2,
  "extracting-frames": 3,
};

const suggestions = ["这个视频的核心观点是什么？", "按时间线梳理章节", "给我三个行动建议"];

const audioStatusLabels: Record<SummaryAudioStatus, string> = {
  analyzed: "已分析音轨",
  silent: "音轨无可辨声音",
  unavailable: "音轨不可用",
};

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

function stagesFor(source: VideoSourceDescriptor) {
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
    "下载并合并公开视频",
    "提取音轨与关键帧",
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
  const [notice, setNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [isReplying, setIsReplying] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
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
  const askAbortRef = useRef<AbortController | null>(null);
  const conversationLoadAbortRef = useRef<AbortController | null>(null);
  const downloadedVideoUrlRef = useRef<string | null>(null);

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
      askAbortRef.current?.abort();
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

  function upsertConversationItem(item: ConversationListItem) {
    setConversationItems((current) =>
      [item, ...current.filter((conversation) => conversation.id !== item.id)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
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
      downloadUrl: url,
      filename: titleFromUrl(url),
    });
    setVideoPreviewFailed(false);
  }

  function showDownloadedVideo(file: File) {
    releaseDownloadedVideoUrl();
    const objectUrl = URL.createObjectURL(file);
    downloadedVideoUrlRef.current = objectUrl;
    setVideoPreview({
      kind: "downloaded",
      playbackUrl: objectUrl,
      downloadUrl: objectUrl,
      filename: file.name || "bilibili-video.mp4",
    });
    setVideoPreviewFailed(false);
  }

  function selectMode(nextMode: InputMode) {
    if (phase === "processing") return;
    setMode(nextMode);
    setNotice(null);
  }

  function acceptFile(file: File) {
    if (phase === "processing") return;
    const extension = fileExtension(file.name);

    if (!acceptedExtensions.includes(extension)) {
      setNotice("暂不支持这个文件格式，请选择 MP4、MOV、WebM、MKV 或 M4V 视频。");
      return;
    }

    if (file.size > LOCAL_VIDEO_PREPROCESSING_LIMITS.maxSourceBytes) {
      setNotice(
        `浏览器本地处理暂时支持不超过 ${Math.round(
          LOCAL_VIDEO_PREPROCESSING_LIMITS.maxSourceBytes / 1024 / 1024,
        )} MB 的视频；更大文件请使用 HTTPS 视频直链。`,
      );
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setSelectedVideo({ file, objectUrl });
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

  async function handleAnalyze() {
    if (!pendingSource) {
      setNotice(
        mode === "upload"
          ? "请先选择一个视频文件。"
          : "请输入有效的 B 站视频链接或 BV 号。",
      );
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
    setActiveConversationId(null);
    setActiveSource(pendingSource);
    setProcessingStages(stages);
    setStageIndex(0);
    setStageProgress(0.2);
    setPreprocessingResult(null);
    if (pendingSource.kind === "url" && pendingSource.sourceUrl) {
      showRemoteVideo(pendingSource.sourceUrl);
    } else {
      clearVideoPreview();
    }

    try {
      let context: VideoModelContext;
      let analysisSource = pendingSource;
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
        const downloaded = await downloadBilibiliVideo(pendingSource.bvid, {
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
        if (runTokenRef.current !== runToken) return;

        showDownloadedVideo(downloaded.file);

        analysisSource = {
          ...pendingSource,
          title: downloaded.title,
          durationLabel: formatDuration(downloaded.durationSeconds),
          subtitle: `${downloaded.bvid} · ${formatFileSize(
            downloaded.sizeBytes,
          )} · ${formatDuration(downloaded.durationSeconds)}`,
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
        content:
          analysisSource.kind === "url"
            ? "Qwen 已同时读取视频直链中的画面与内嵌音轨并生成结构化总结。接下来由 DeepSeek V4 Pro 回答核心观点、声音变化、章节结构或行动建议。"
            : context.audioUrl
              ? "Qwen 已融合抽取的音轨、关键帧与时间索引并生成结构化总结。接下来由 DeepSeek V4 Pro 回答核心观点、声音变化、章节结构或行动建议。"
              : "Qwen 已使用关键帧生成结构化总结；该素材没有可用音轨，因此不会推测音乐或环境声。接下来可由 DeepSeek V4 Pro 继续追问。",
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
      askAbortRef.current?.abort();
      askAbortRef.current = null;
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
      setSelectedVideo(null);
      setQuestion("");
      setIsReplying(false);
      upsertConversationItem(conversation);

      if (conversation.source.kind === "url" && conversation.source.sourceUrl) {
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
        setNotice("总结和对话已恢复；如需预览或下载，请重新获取这个 B站视频。");
      } else {
        setMode("upload");
        setBilibiliInput("");
        clearVideoPreview();
        setNotice("总结和对话已恢复；本地原视频不会存入 D1，预览时请重新选择文件。");
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
          .then(() => {
            setConversationItems((current) =>
              current
                .map((item) =>
                  item.id === conversationId
                    ? { ...item, updatedAt: Date.now() }
                    : item,
                )
                .sort((left, right) => right.updatedAt - left.updatedAt),
            );
          })
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
      ? Math.round(
          ((stageIndex + Math.max(0, Math.min(1, stageProgress))) /
            processingStages.length) *
            100,
        )
      : 0;

  const shownSource = activeSource ?? pendingSource;
  const activeConversationTitle = activeConversationId
    ? conversationItems.find((item) => item.id === activeConversationId)?.title
    : null;

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
          <div className="source-card">
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
                    disabled={phase === "processing"}
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
                  <p className="field-help">
                    视频直链可直接调用 Qwen；B站仅处理你有权分析的公开 UGC，当前上限 {Math.round(
                      MAX_BILIBILI_BROWSER_BYTES / 1024 / 1024,
                    )} MB。
                  </p>
                )}

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
            {videoPreview ? (
              <section className="video-preview-card" aria-label="视频预览与下载">
                <div className="video-preview-player">
                  <video
                    src={videoPreview.playbackUrl}
                    controls
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={() => setVideoPreviewFailed(false)}
                    onError={() => setVideoPreviewFailed(true)}
                  >
                    当前浏览器无法播放这个视频。
                  </video>
                </div>
                <div className="video-preview-details">
                  <span className="video-ready-label">
                    {videoPreview.kind === "downloaded" ? "视频已下载并合并" : "HTTPS 视频直链已就绪"}
                  </span>
                  <strong>{videoPreview.filename}</strong>
                  <p>
                    {videoPreviewFailed
                      ? "浏览器无法直接预览，但仍可以尝试打开或保存视频。"
                      : videoPreview.kind === "downloaded"
                        ? "总结仍在处理时也可以立即播放；临时视频会保留到当前任务结束。"
                        : "播放器直接读取源站视频；是否能保存由源站响应设置决定。"}
                  </p>
                  <div className="video-preview-actions">
                    <a
                      className="video-download-action"
                      href={videoPreview.downloadUrl}
                      download={videoPreview.filename}
                      target={videoPreview.kind === "remote" ? "_blank" : undefined}
                      rel={videoPreview.kind === "remote" ? "noreferrer" : undefined}
                    >
                      {videoPreview.kind === "downloaded" ? "下载视频" : "打开/下载原视频"}
                    </a>
                    {videoPreview.kind === "remote" ? (
                      <a
                        className="video-source-action"
                        href={videoPreview.playbackUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开源地址 ↗
                      </a>
                    ) : null}
                  </div>
                </div>
              </section>
            ) : null}

            {phase === "idle" || phase === "error" ? (
              <div className="empty-state">
                <div className="empty-orbit" aria-hidden="true">
                  <span>✦</span>
                </div>
                <span className="empty-label">SUMMARY SPACE</span>
                <h3>视频内容，会在这里沉淀下来。</h3>
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
                    <span className="summary-mode">结构化</span>
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

                  {summary.audioAnalysis ? (
                    <section className="summary-section">
                      <h4>声音与音乐</h4>
                      <div
                        className={`audio-analysis audio-analysis-${summary.audioAnalysis.status}`}
                      >
                        <div className="audio-analysis-heading">
                          <span>{audioStatusLabels[summary.audioAnalysis.status]}</span>
                        </div>
                        <p className="audio-analysis-summary">
                          {summary.audioAnalysis.summary}
                        </p>

                        {summary.audioAnalysis.status === "analyzed" ? (
                          <dl className="audio-detail-list">
                            {summary.audioAnalysis.speech ? (
                              <div>
                                <dt>讲话 / 人声</dt>
                                <dd>{summary.audioAnalysis.speech}</dd>
                              </div>
                            ) : null}
                            {summary.audioAnalysis.music ? (
                              <div>
                                <dt>音乐</dt>
                                <dd>{summary.audioAnalysis.music}</dd>
                              </div>
                            ) : null}
                            {summary.audioAnalysis.soundscape ? (
                              <div>
                                <dt>环境声</dt>
                                <dd>{summary.audioAnalysis.soundscape}</dd>
                              </div>
                            ) : null}
                          </dl>
                        ) : null}

                        {summary.audioAnalysis.temporalChanges.length > 0 ? (
                          <div className="audio-change-list">
                            <strong>声音变化</strong>
                            {summary.audioAnalysis.temporalChanges.map((change) => (
                              <div
                                className="audio-change-row"
                                key={`${change.time}-${change.description}`}
                              >
                                <time>{change.time}</time>
                                <p>{change.description}</p>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        {summary.audioAnalysis.uncertainty ? (
                          <p className="audio-uncertainty">
                            不确定性：{summary.audioAnalysis.uncertainty}
                          </p>
                        ) : null}
                      </div>
                    </section>
                  ) : null}

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
