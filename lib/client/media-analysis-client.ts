import type {
  BilibiliAnalysis,
  BilibiliArtifact,
  BilibiliJobError,
  BilibiliJobPhase,
  BilibiliJobStatus,
} from "../bilibili-api";
import type {
  SourceKind,
  VideoModelContext,
  VideoTranscript,
} from "../video-engine";

const POLL_INTERVAL_MS = 1_000;
const MAX_JOB_WAIT_MS = 22 * 60 * 1_000;
const MIN_KEYFRAMES = 3;

interface MediaJobSource {
  kind: "upload" | "url";
  filename?: string;
  sourceUrl?: string;
  title?: string;
  durationSeconds?: number;
}

interface MediaJobSnapshot {
  jobId: string;
  status: BilibiliJobStatus;
  phase: BilibiliJobPhase;
  progress: number;
  source: MediaJobSource;
  artifact?: BilibiliArtifact;
  analysis?: BilibiliAnalysis;
  error?: BilibiliJobError;
}

export interface MediaAnalysisProgress {
  stage: "uploading" | "processing" | "downloading";
  progress: number;
  phase?: BilibiliJobPhase;
}

export interface MediaAnalysisResult {
  jobId: string;
  context: VideoModelContext;
  transcript?: VideoTranscript;
  title: string;
  durationSeconds: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  analysisMode: "direct" | "keyframes";
}

interface MediaAnalysisOptions {
  sourceKind: Extract<SourceKind, "upload" | "url">;
  sourceUrl?: string;
  directSummaryMaxSeconds: number;
  signal?: AbortSignal;
  onProgress?: (progress: MediaAnalysisProgress) => void;
}

export class MediaAnalysisClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "MEDIA_ANALYSIS_FAILED", retryable = false) {
    super(message);
    this.name = "MediaAnalysisClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function prepareMediaAnalysis(
  file: File,
  options: MediaAnalysisOptions,
): Promise<MediaAnalysisResult> {
  throwIfAborted(options.signal);
  const form = new FormData();
  form.set("file", file, file.name);
  form.set("sourceKind", options.sourceKind);
  form.set(
    "directSummaryMaxSeconds",
    String(options.directSummaryMaxSeconds),
  );
  if (options.sourceKind === "url" && options.sourceUrl) {
    form.set("sourceUrl", options.sourceUrl);
  }

  let jobId: string | undefined;
  let keepJob = false;
  const deadline = Date.now() + MAX_JOB_WAIT_MS;
  options.onProgress?.({ stage: "uploading", progress: 0 });
  try {
    let snapshot = await requestJob("/api/media/jobs", {
      method: "POST",
      body: form,
      signal: options.signal,
    });
    jobId = snapshot.jobId;
    options.onProgress?.({ stage: "uploading", progress: 1 });
    reportProgress(snapshot, options.onProgress);

    while (
      (snapshot.status === "queued" || snapshot.status === "running") &&
      !snapshot.error
    ) {
      if (Date.now() >= deadline) {
        throw new MediaAnalysisClientError(
          "视频处理超过 22 分钟仍未完成。",
          "MEDIA_JOB_TIMEOUT",
          true,
        );
      }
      await abortableDelay(POLL_INTERVAL_MS, options.signal);
      snapshot = await requestJob(`/api/media/jobs/${jobId}`, {
        signal: options.signal,
      });
      reportProgress(snapshot, options.onProgress);
    }

    if (
      snapshot.status !== "succeeded" ||
      !snapshot.artifact ||
      !snapshot.analysis
    ) {
      throw snapshotError(snapshot, "视频分析素材准备失败。");
    }
    if (snapshot.source.kind !== options.sourceKind) {
      throw new MediaAnalysisClientError(
        "媒体服务返回的视频来源不匹配。",
        "INVALID_MEDIA_RESPONSE",
        true,
      );
    }
    const durationSeconds = requireDuration(snapshot);
    const context = await downloadAnalysisEvidence(
      snapshot.analysis,
      snapshot.jobId,
      durationSeconds,
      options,
    );
    keepJob = true;
    return {
      jobId: snapshot.jobId,
      context,
      transcript: transcriptFromAnalysis(snapshot.analysis),
      title: snapshot.source.title?.trim() || file.name,
      durationSeconds,
      sizeBytes: snapshot.artifact.sizeBytes,
      width: snapshot.artifact.width,
      height: snapshot.artifact.height,
      analysisMode: snapshot.analysis.mode,
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      throw new DOMException("视频分析已取消。", "AbortError");
    }
    if (error instanceof MediaAnalysisClientError) throw error;
    throw new MediaAnalysisClientError(
      error instanceof Error ? error.message : "视频分析素材准备失败。",
      "MEDIA_ANALYSIS_FAILED",
      true,
    );
  } finally {
    if (jobId && !keepJob) void releaseMediaAnalysis(jobId);
  }
}

export async function extractMediaTranscript(
  jobId: string,
  signal?: AbortSignal,
): Promise<VideoTranscript> {
  throwIfAborted(signal);
  const deadline = Date.now() + MAX_JOB_WAIT_MS;
  let snapshot = await requestJob(
    `/api/media/jobs/${jobId}/transcript`,
    { method: "POST", signal },
  );
  while (snapshot.analysis?.transcript.status === "pending") {
    if (Date.now() >= deadline) {
      throw new MediaAnalysisClientError(
        "FunASR 字幕提取超过 22 分钟仍未完成。",
        "TRANSCRIPT_TIMEOUT",
        true,
      );
    }
    await abortableDelay(POLL_INTERVAL_MS, signal);
    snapshot = await requestJob(`/api/media/jobs/${jobId}`, { signal });
  }
  if (snapshot.status !== "succeeded" || !snapshot.analysis) {
    throw snapshotError(snapshot, "FunASR 字幕提取失败。");
  }
  const transcript = transcriptFromAnalysis(snapshot.analysis);
  if (!transcript) {
    throw new MediaAnalysisClientError(
      "媒体服务没有返回完整字幕状态。",
      "INVALID_TRANSCRIPT_RESPONSE",
      true,
    );
  }
  return transcript;
}

export async function releaseMediaAnalysis(jobId: string) {
  try {
    await fetch(`/api/media/jobs/${jobId}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
      keepalive: true,
    });
  } catch {
    // 媒体服务仍会按 TTL 清理临时分析视频。
  }
}

async function downloadAnalysisEvidence(
  analysis: BilibiliAnalysis,
  jobId: string,
  durationSeconds: number,
  options: MediaAnalysisOptions,
): Promise<VideoModelContext> {
  if (analysis.mode === "direct") {
    if (analysis.frames.length !== 0) {
      throw new MediaAnalysisClientError(
        "直接视频任务返回了多余的关键帧。",
        "INVALID_ANALYSIS_EVIDENCE",
        true,
      );
    }
    return {
      mediaJobId: jobId,
      fps: 1,
      durationSeconds,
    };
  }
  if (!analysis.audio || analysis.frames.length < MIN_KEYFRAMES) {
    throw new MediaAnalysisClientError(
      "关键帧分析任务缺少音轨或有效画面。",
      "INVALID_ANALYSIS_EVIDENCE",
      true,
    );
  }
  const audioUrl = await fetchAsDataUrl(
    analysis.audio.url,
    analysis.audio.mimeType,
    analysis.audio.sizeBytes,
    options.signal,
  );
  const frames = analysis.frames.slice(0, 64);
  const frameUrls: string[] = [];
  for (let index = 0; index < frames.length; index += 6) {
    throwIfAborted(options.signal);
    const batch = frames.slice(index, index + 6);
    frameUrls.push(
      ...(await Promise.all(
        batch.map((frame) =>
          fetchAsDataUrl(
            frame.url,
            "image/jpeg",
            frame.sizeBytes,
            options.signal,
          ),
        ),
      )),
    );
    options.onProgress?.({
      stage: "downloading",
      progress: (index + batch.length) / frames.length,
      phase: "analyzing",
    });
  }
  return {
    frameUrls,
    frameTimestamps: frames.map((frame) => frame.timestampSeconds),
    audioUrl,
    audioFormat: "mp3",
    durationSeconds,
  };
}

async function fetchAsDataUrl(
  url: string,
  mimeType: string,
  expectedBytes: number,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    headers: { accept: mimeType },
  });
  if (!response.ok) {
    throw new MediaAnalysisClientError(
      `分析素材读取失败（HTTP ${response.status}）。`,
      "ANALYSIS_ASSET_FAILED",
      response.status >= 500,
    );
  }
  const blob = await response.blob();
  if (
    blob.size <= 0 ||
    blob.size > Math.max(expectedBytes * 1.1, expectedBytes + 64 * 1024)
  ) {
    throw new MediaAnalysisClientError(
      "媒体服务返回的分析素材大小无效。",
      "INVALID_ANALYSIS_ASSET",
      true,
    );
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("浏览器无法读取分析素材。"));
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("浏览器无法编码分析素材。"));
    reader.readAsDataURL(blob);
  });
}

async function requestJob(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new MediaAnalysisClientError(
      "无法连接媒体处理服务。",
      "MEDIA_NETWORK_ERROR",
      true,
    );
  }
  const body = (await response.json().catch(() => null)) as
    | MediaJobSnapshot
    | { error?: BilibiliJobError }
    | null;
  if (!response.ok) {
    const error = body?.error;
    const fallback = mediaRequestFallback(response.status);
    throw new MediaAnalysisClientError(
      error?.message ?? fallback.message,
      error?.code ?? fallback.code,
      error?.retryable ?? response.status >= 500,
    );
  }
  if (!isMediaJobSnapshot(body)) {
    throw new MediaAnalysisClientError(
      "媒体处理服务返回了无效任务状态。",
      "INVALID_MEDIA_RESPONSE",
      true,
    );
  }
  return body;
}

function mediaRequestFallback(status: number) {
  if (status === 413) {
    return {
      code: "MEDIA_REQUEST_TOO_LARGE",
      message:
        "视频上传在到达媒体处理服务前被网站入口拒绝（HTTP 413）。请重启本地开发服务后重试；公网部署还需遵守托管平台的上传限制。",
    };
  }
  return {
    code: "MEDIA_REQUEST_FAILED",
    message: `媒体处理服务返回 HTTP ${status}。`,
  };
}

function isMediaJobSnapshot(value: unknown): value is MediaJobSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const source = record.source;
  return (
    typeof record.jobId === "string" &&
    typeof record.status === "string" &&
    typeof record.phase === "string" &&
    typeof record.progress === "number" &&
    Boolean(source) &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    ["upload", "url"].includes(
      String((source as Record<string, unknown>).kind),
    )
  );
}

function transcriptFromAnalysis(
  analysis: BilibiliAnalysis,
): VideoTranscript | undefined {
  if (analysis.transcript.status === "pending") return undefined;
  return {
    status: analysis.transcript.status,
    text: analysis.transcript.text,
    cues: analysis.transcript.cues.map((cue) => ({ ...cue })),
    ...(analysis.transcript.language
      ? { language: analysis.transcript.language }
      : {}),
    ...(analysis.transcript.error ? { error: analysis.transcript.error } : {}),
  };
}

function reportProgress(
  snapshot: MediaJobSnapshot,
  onProgress?: MediaAnalysisOptions["onProgress"],
) {
  onProgress?.({
    stage: "processing",
    progress: Math.max(0, Math.min(1, snapshot.progress)),
    phase: snapshot.phase,
  });
}

function snapshotError(snapshot: MediaJobSnapshot, fallback: string) {
  return new MediaAnalysisClientError(
    snapshot.error?.message ?? fallback,
    snapshot.error?.code ?? `MEDIA_${snapshot.status.toUpperCase()}`,
    snapshot.error?.retryable ?? snapshot.status === "failed",
  );
}

function requireDuration(snapshot: MediaJobSnapshot) {
  const duration = snapshot.source.durationSeconds;
  if (!duration || !Number.isFinite(duration)) {
    throw new MediaAnalysisClientError(
      "媒体服务没有返回有效时长。",
      "INVALID_MEDIA_METADATA",
      true,
    );
  }
  return duration;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = globalThis.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException("视频分析已取消。", "AbortError"));
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("视频分析已取消。", "AbortError");
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
