import type {
  BilibiliApiErrorBody,
  BilibiliArtifact,
  BilibiliJobSnapshot,
} from "../bilibili-api";
import {
  BILIBILI_ANALYSIS_DOWNLOAD_VARIANT,
  DEFAULT_BILIBILI_DOWNLOAD_VARIANT,
} from "../bilibili-api";
import type {
  TranscriptLanguage,
  VideoModelContext,
  VideoTranscript,
} from "../video-engine";

const POLL_INTERVAL_MS = 1_000;
// 服务端下载超时为 20 分钟；额外两分钟留给排队、轮询和媒体传输。
const MAX_JOB_WAIT_MS = 22 * 60 * 1_000;
export const MAX_BILIBILI_ANALYSIS_BYTES = 500 * 1024 * 1024;
const MAX_VIDEO_DURATION_SECONDS = 60 * 60;
const MIN_KEYFRAMES = 3;

type BilibiliDownloadStage = "preparing" | "downloading";

interface BilibiliDownloadProgress {
  stage: BilibiliDownloadStage;
  progress: number;
  phase?: BilibiliJobSnapshot["phase"];
}

export interface BilibiliDownloadResult {
  context: VideoModelContext;
  transcript?: VideoTranscript;
  analysisMode?: "direct" | "keyframes";
  jobId: string;
  bvid: string;
  title: string;
  description?: string;
  durationSeconds: number;
  sizeBytes: number;
  width?: number;
  height?: number;
}

export interface BilibiliPreparedDownloadResult {
  playbackUrl: string;
  downloadUrl: string;
  filename: string;
  bvid: string;
  title: string;
  description?: string;
  durationSeconds: number;
  sizeBytes: number;
  width?: number;
  height?: number;
}

interface BilibiliDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BilibiliDownloadProgress) => void;
  directSummaryMaxSeconds?: number;
}

export class BilibiliClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "BILIBILI_DOWNLOAD_FAILED", retryable = false) {
    super(message);
    this.name = "BilibiliClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function prepareBilibiliVideoDownload(
  bvid: string,
  options: BilibiliDownloadOptions = {},
): Promise<BilibiliPreparedDownloadResult> {
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "preparing", progress: 0, phase: "queued" });

  let jobId: string | undefined;
  let keepArtifact = false;
  const deadline = Date.now() + MAX_JOB_WAIT_MS;
  try {
    let snapshot = await requestJob("/api/bilibili/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bvid,
        variant: DEFAULT_BILIBILI_DOWNLOAD_VARIANT,
      }),
      signal: options.signal,
    });
    jobId = snapshot.jobId;
    reportServerProgress(snapshot, options.onProgress);

    while (
      (snapshot.status === "queued" || snapshot.status === "running") &&
      !snapshot.error
    ) {
      if (Date.now() >= deadline) {
        throw new BilibiliClientError(
          "最高画质下载任务超过 22 分钟仍未完成，已自动取消。",
          "BILIBILI_JOB_TIMEOUT",
          true,
        );
      }
      await abortableDelay(POLL_INTERVAL_MS, options.signal);
      snapshot = await requestJob(`/api/bilibili/jobs/${jobId}`, {
        signal: options.signal,
      });
      reportServerProgress(snapshot, options.onProgress);
    }

    if (snapshot.status !== "succeeded" || !snapshot.artifact) {
      throw snapshotError(snapshot, "最高画质视频下载失败。");
    }

    const durationSeconds = requireDuration(snapshot);
    validateArtifact(snapshot.artifact, durationSeconds);
    keepArtifact = true;
    options.onProgress?.({ stage: "downloading", progress: 1, phase: "ready" });

    return {
      playbackUrl: snapshot.artifact.playbackUrl,
      downloadUrl: snapshot.artifact.downloadUrl,
      filename: snapshot.artifact.filename,
      bvid: snapshot.source.bvid,
      title: sourceTitle(snapshot),
      description: snapshot.source.description,
      durationSeconds,
      sizeBytes: snapshot.artifact.sizeBytes,
      width: snapshot.artifact.width,
      height: snapshot.artifact.height,
    };
  } catch (error) {
    throw normalizeDownloadError(error, options.signal);
  } finally {
    // 成功后由签名 URL 和服务端 TTL 管理成品；立即删除会让浏览器下载失效。
    if (jobId && !keepArtifact) void cleanupJob(jobId);
  }
}

export async function downloadBilibiliVideo(
  bvid: string,
  options: BilibiliDownloadOptions = {},
): Promise<BilibiliDownloadResult> {
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "preparing", progress: 0, phase: "queued" });

  let jobId: string | undefined;
  let keepJob = false;
  const deadline = Date.now() + MAX_JOB_WAIT_MS;
  try {
    let snapshot = await requestJob(
      "/api/bilibili/jobs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bvid,
          variant: BILIBILI_ANALYSIS_DOWNLOAD_VARIANT,
          ...(options.directSummaryMaxSeconds
            ? {
                directSummaryMaxSeconds:
                  options.directSummaryMaxSeconds,
              }
            : {}),
        }),
        signal: options.signal,
      },
    );
    jobId = snapshot.jobId;
    reportServerProgress(snapshot, options.onProgress);

    while (
      (snapshot.status === "queued" || snapshot.status === "running") &&
      !snapshot.error
    ) {
      if (Date.now() >= deadline) {
        throw new BilibiliClientError(
          "B站下载任务超过 22 分钟仍未完成，已自动取消。",
          "BILIBILI_JOB_TIMEOUT",
          true,
        );
      }
      await abortableDelay(POLL_INTERVAL_MS, options.signal);
      snapshot = await requestJob(`/api/bilibili/jobs/${jobId}`, {
        signal: options.signal,
      });
      reportServerProgress(snapshot, options.onProgress);
    }

    if (snapshot.status !== "succeeded" || !snapshot.artifact) {
      throw snapshotError(snapshot, "B站视频下载失败。");
    }

    const durationSeconds = requireDuration(snapshot);
    validateArtifact(
      snapshot.artifact,
      durationSeconds,
      MAX_BILIBILI_ANALYSIS_BYTES,
    );
    if (!snapshot.analysis) {
      throw new BilibiliClientError(
        "媒体服务没有返回视频分析证据。",
        "INVALID_ANALYSIS_EVIDENCE",
        true,
      );
    }
    const evidence = await downloadAnalysisEvidence(
      snapshot.analysis,
      snapshot.jobId,
      durationSeconds,
      options,
    );
    keepJob = true;

    return {
      context: evidence.context,
      ...(evidence.transcript ? { transcript: evidence.transcript } : {}),
      analysisMode: snapshot.analysis.mode,
      jobId: snapshot.jobId,
      bvid: snapshot.source.bvid,
      title: sourceTitle(snapshot),
      description: snapshot.source.description,
      durationSeconds,
      sizeBytes: snapshot.artifact.sizeBytes,
      width: snapshot.artifact.width,
      height: snapshot.artifact.height,
    };
  } catch (error) {
    throw normalizeDownloadError(error, options.signal);
  } finally {
    if (jobId && !keepJob) void cleanupJob(jobId);
  }
}

export function releaseBilibiliAnalysis(jobId: string) {
  return cleanupJob(jobId);
}

export async function extractBilibiliTranscript(
  jobId: string,
  languages: TranscriptLanguage[],
  signal?: AbortSignal,
): Promise<VideoTranscript> {
  throwIfAborted(signal);
  const deadline = Date.now() + MAX_JOB_WAIT_MS;
  let snapshot = await requestJob(
    `/api/bilibili/jobs/${jobId}/transcript`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ languages }),
      signal,
    },
  );

  while (snapshot.analysis?.transcript.status === "pending") {
    if (Date.now() >= deadline) {
      throw new BilibiliClientError(
        "FunASR 字幕提取超过 22 分钟仍未完成。",
        "TRANSCRIPT_TIMEOUT",
        true,
      );
    }
    await abortableDelay(POLL_INTERVAL_MS, signal);
    snapshot = await requestJob(`/api/bilibili/jobs/${jobId}`, { signal });
  }

  if (snapshot.status !== "succeeded" || !snapshot.analysis) {
    throw snapshotError(snapshot, "FunASR 字幕提取失败。");
  }
  const transcript = transcriptFromAnalysis(snapshot.analysis);
  if (!transcript) {
    throw new BilibiliClientError(
      "媒体服务没有返回完整的 FunASR 字幕状态。",
      "INVALID_TRANSCRIPT_RESPONSE",
      true,
    );
  }
  return transcript;
}

async function downloadAnalysisEvidence(
  analysis: NonNullable<BilibiliJobSnapshot["analysis"]>,
  jobId: string,
  durationSeconds: number,
  options: BilibiliDownloadOptions,
) {
  if (analysis.mode === "direct") {
    if (analysis.frames.length !== 0) {
      throw new BilibiliClientError(
        "直接视频分析任务返回了不应存在的关键帧。",
        "INVALID_ANALYSIS_EVIDENCE",
        true,
      );
    }
    return {
      context: {
        mediaJobId: jobId,
        fps: 1,
        durationSeconds,
      },
      transcript: transcriptFromAnalysis(analysis),
    };
  }

  if (!analysis.audio) {
    throw new BilibiliClientError(
      "关键帧分析任务没有返回音轨。",
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
  const frameUrls: string[] = [];
  const frames = analysis.frames.slice(0, 64);
  if (frames.length < MIN_KEYFRAMES) {
    throw new BilibiliClientError(
      "媒体服务没有返回足够的关键帧。",
      "INSUFFICIENT_KEYFRAMES",
      true,
    );
  }
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
      progress: Math.min(0.98, (index + batch.length) / Math.max(1, frames.length)),
      phase: "analyzing",
    });
  }
  return {
    context: {
      frameUrls,
      frameTimestamps: frames.map((frame) => frame.timestampSeconds),
      audioUrl,
      audioFormat: "mp3" as const,
      durationSeconds,
    },
    transcript: transcriptFromAnalysis(analysis),
  };
}

function transcriptFromAnalysis(
  analysis: NonNullable<BilibiliJobSnapshot["analysis"]>,
): VideoTranscript | undefined {
  if (analysis.transcript.status === "pending") return undefined;
  return {
    status: analysis.transcript.status,
    text: analysis.transcript.text,
    cues: analysis.transcript.cues.map((cue) => ({
      startSeconds: cue.startSeconds,
      endSeconds: cue.endSeconds,
      text: cue.text,
    })),
    ...(analysis.transcript.language
      ? { language: analysis.transcript.language }
      : {}),
    ...(analysis.transcript.error ? { error: analysis.transcript.error } : {}),
  };
}

async function fetchAsDataUrl(
  url: string,
  expectedMimeType: string,
  expectedBytes: number,
  signal?: AbortSignal,
) {
  const response = await fetch(url, {
    method: "GET",
    signal,
    credentials: "omit",
    headers: { accept: expectedMimeType },
  });
  if (!response.ok) {
    throw new BilibiliClientError(
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
    throw new BilibiliClientError(
      "媒体服务返回的分析素材大小无效。",
      "INVALID_ANALYSIS_ASSET",
      true,
    );
  }
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(
        new BilibiliClientError(
          "浏览器无法编码分析素材。",
          "ANALYSIS_ENCODING_FAILED",
          true,
        ),
      );
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(
          new BilibiliClientError(
            "浏览器无法编码分析素材。",
            "ANALYSIS_ENCODING_FAILED",
            true,
          ),
        );
        return;
      }
      resolve(reader.result);
    };
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
    throw new BilibiliClientError(
      "无法连接 B站下载服务，请检查网络后重试。",
      "BILIBILI_NETWORK_ERROR",
      true,
    );
  }

  const body = (await response.json().catch(() => null)) as
    | BilibiliJobSnapshot
    | BilibiliApiErrorBody
    | null;
  if (!response.ok) {
    const upstream = body && "error" in body ? body.error : undefined;
    throw new BilibiliClientError(
      upstream?.message ?? `B站下载服务返回 HTTP ${response.status}。`,
      upstream?.code ?? "BILIBILI_REQUEST_FAILED",
      upstream?.retryable ?? response.status >= 500,
    );
  }
  // Job snapshots and API error responses both have a top-level `error` field.
  // On a successful HTTP response, validate the job shape instead of treating a
  // failed job's error details as an API-level error.
  if (!isJobSnapshot(body)) {
    throw new BilibiliClientError(
      "B站下载服务返回了无效任务状态。",
      "INVALID_MEDIA_RESPONSE",
      true,
    );
  }
  return body;
}

function reportServerProgress(
  snapshot: BilibiliJobSnapshot,
  onProgress?: BilibiliDownloadOptions["onProgress"],
) {
  onProgress?.({
    stage: "preparing",
    progress: clamp(snapshot.progress, 0, 1),
    phase: snapshot.phase,
  });
}

function snapshotError(snapshot: BilibiliJobSnapshot, fallbackMessage: string) {
  const fallback = snapshot.status === "cancelled"
    ? "B站视频下载已取消。"
    : snapshot.status === "expired"
      ? "B站视频下载结果已过期，请重新开始。"
      : fallbackMessage;
  return new BilibiliClientError(
    snapshot.error?.message ?? fallback,
    snapshot.error?.code ?? `BILIBILI_${snapshot.status.toUpperCase()}`,
    snapshot.error?.retryable ?? snapshot.status === "failed",
  );
}

function requireDuration(snapshot: BilibiliJobSnapshot) {
  const durationSeconds = snapshot.source.durationSeconds;
  if (!durationSeconds || !Number.isFinite(durationSeconds)) {
    throw new BilibiliClientError(
      "媒体服务没有返回有效视频时长。",
      "INVALID_MEDIA_METADATA",
      true,
    );
  }
  return durationSeconds;
}

function sourceTitle(snapshot: BilibiliJobSnapshot) {
  return snapshot.source.title?.trim() || `B站视频 ${snapshot.source.bvid}`;
}

function normalizeDownloadError(error: unknown, signal?: AbortSignal): Error {
  if (isAbortError(error) || signal?.aborted) {
    return new DOMException("B站视频下载已取消。", "AbortError");
  }
  if (error instanceof BilibiliClientError) return error;
  return new BilibiliClientError(
    error instanceof Error ? error.message : "B站视频下载失败。",
    "BILIBILI_DOWNLOAD_FAILED",
    true,
  );
}

function validateArtifact(
  artifact: BilibiliArtifact,
  durationSeconds: number,
  maxBytes?: number,
) {
  if (
    durationSeconds > MAX_VIDEO_DURATION_SECONDS
  ) {
    throw new BilibiliClientError(
      `当前版本支持不超过 ${Math.round(
        MAX_VIDEO_DURATION_SECONDS / 60,
      )} 分钟的 B站视频。`,
      "VIDEO_TOO_LONG",
      false,
    );
  }
  if (
    !Number.isFinite(artifact.sizeBytes) ||
    artifact.sizeBytes <= 0 ||
    (maxBytes !== undefined && artifact.sizeBytes > maxBytes)
  ) {
    throw new BilibiliClientError(
      maxBytes === undefined
        ? "媒体服务返回了无效的视频大小。"
        : `当前版本支持不超过 ${Math.round(
            maxBytes / 1024 / 1024,
          )} MB 的 B站分析素材。`,
      "VIDEO_TOO_LARGE",
      false,
    );
  }

  for (const rawUrl of [artifact.playbackUrl, artifact.downloadUrl]) {
    let mediaUrl: URL;
    try {
      mediaUrl = new URL(rawUrl);
    } catch {
      throw new BilibiliClientError(
        "媒体服务返回的播放或下载地址无效。",
        "INVALID_DOWNLOAD_URL",
        true,
      );
    }
    if (mediaUrl.protocol !== "https:" && mediaUrl.protocol !== "http:") {
      throw new BilibiliClientError(
        "媒体服务返回的媒体地址协议不受支持。",
        "INVALID_DOWNLOAD_URL",
        true,
      );
    }
    if (globalThis.location?.protocol === "https:" && mediaUrl.protocol !== "https:") {
      throw new BilibiliClientError(
        "当前页面使用 HTTPS，媒体服务也必须提供 HTTPS 播放和下载地址。",
        "INSECURE_MEDIA_SERVICE",
        false,
      );
    }
  }
  const expiresAt = Date.parse(artifact.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new BilibiliClientError(
      "媒体下载地址已经过期，请重新开始。",
      "MEDIA_URL_EXPIRED",
      true,
    );
  }
  if (!/^video\//i.test(artifact.mimeType) || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
    throw new BilibiliClientError(
      "媒体服务返回的文件元数据无效。",
      "INVALID_MEDIA_METADATA",
      true,
    );
  }
}

async function cleanupJob(jobId: string) {
  try {
    await fetch(`/api/bilibili/jobs/${jobId}`, {
      method: "DELETE",
      headers: { accept: "application/json" },
      keepalive: true,
    });
  } catch {
    // 媒体服务还有 TTL 清理；浏览器离开页面时无需阻塞。
  }
}

function isJobSnapshot(value: unknown): value is BilibiliJobSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  const source = snapshot.source;
  return (
    typeof snapshot.jobId === "string" &&
    typeof snapshot.status === "string" &&
    typeof snapshot.phase === "string" &&
    typeof snapshot.progress === "number" &&
    Boolean(source) &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    typeof (source as Record<string, unknown>).bvid === "string" &&
    (snapshot.error === undefined || isJobError(snapshot.error))
  );
}

function isJobError(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const error = value as Record<string, unknown>;
  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean"
  );
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("B站视频下载已取消。", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("B站视频下载已取消。", "AbortError");
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
