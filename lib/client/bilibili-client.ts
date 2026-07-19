import type {
  BilibiliApiErrorBody,
  BilibiliArtifact,
  BilibiliJobSnapshot,
  BilibiliVideoQuality,
} from "../bilibili-api";
import { DEFAULT_BILIBILI_VIDEO_QUALITY } from "../bilibili-api";
import { LOCAL_VIDEO_PREPROCESSING_LIMITS } from "./video-preprocessor";

const POLL_INTERVAL_MS = 1_000;
// 服务端下载超时为 20 分钟；额外两分钟留给排队、轮询和媒体传输。
const MAX_JOB_WAIT_MS = 22 * 60 * 1_000;
export const MAX_BILIBILI_BROWSER_BYTES = 150 * 1024 * 1024;

export type BilibiliDownloadStage = "preparing" | "downloading";

export interface BilibiliDownloadProgress {
  stage: BilibiliDownloadStage;
  progress: number;
  phase?: BilibiliJobSnapshot["phase"];
}

export interface BilibiliDownloadResult {
  file: File;
  bvid: string;
  title: string;
  durationSeconds: number;
  sizeBytes: number;
  requestedHeight: BilibiliVideoQuality;
  height?: number;
}

export interface BilibiliDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BilibiliDownloadProgress) => void;
  maxHeight?: BilibiliVideoQuality;
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

export async function downloadBilibiliVideo(
  bvid: string,
  options: BilibiliDownloadOptions = {},
): Promise<BilibiliDownloadResult> {
  throwIfAborted(options.signal);
  options.onProgress?.({ stage: "preparing", progress: 0, phase: "queued" });

  let jobId: string | undefined;
  const deadline = Date.now() + MAX_JOB_WAIT_MS;
  const maxHeight = options.maxHeight ?? DEFAULT_BILIBILI_VIDEO_QUALITY;
  try {
    let snapshot = await requestJob(
      "/api/bilibili/jobs",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bvid, maxHeight }),
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
      const fallback = snapshot.status === "cancelled"
        ? "B站视频下载已取消。"
        : snapshot.status === "expired"
          ? "B站视频下载结果已过期，请重新开始。"
          : "B站视频下载失败。";
      throw new BilibiliClientError(
        snapshot.error?.message ?? fallback,
        snapshot.error?.code ?? `BILIBILI_${snapshot.status.toUpperCase()}`,
        snapshot.error?.retryable ?? snapshot.status === "failed",
      );
    }

    const durationSeconds = snapshot.source.durationSeconds;
    if (!durationSeconds || !Number.isFinite(durationSeconds)) {
      throw new BilibiliClientError(
        "媒体服务没有返回有效视频时长。",
        "INVALID_MEDIA_METADATA",
        true,
      );
    }
    validateArtifact(snapshot.artifact, durationSeconds);
    const file = await downloadArtifact(snapshot.artifact, options, deadline);

    return {
      file,
      bvid: snapshot.source.bvid,
      title: snapshot.source.title?.trim() || `B站视频 ${snapshot.source.bvid}`,
      durationSeconds,
      sizeBytes: file.size,
      requestedHeight: maxHeight,
      height: snapshot.artifact.height,
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      throw new DOMException("B站视频下载已取消。", "AbortError");
    }
    if (error instanceof BilibiliClientError) throw error;
    throw new BilibiliClientError(
      error instanceof Error ? error.message : "B站视频下载失败。",
      "BILIBILI_DOWNLOAD_FAILED",
      true,
    );
  } finally {
    if (jobId) void cleanupJob(jobId);
  }
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

function validateArtifact(artifact: BilibiliArtifact, durationSeconds: number) {
  if (
    durationSeconds > LOCAL_VIDEO_PREPROCESSING_LIMITS.maxDurationSeconds
  ) {
    throw new BilibiliClientError(
      `当前版本支持不超过 ${Math.round(
        LOCAL_VIDEO_PREPROCESSING_LIMITS.maxDurationSeconds / 60,
      )} 分钟的 B站视频。`,
      "VIDEO_TOO_LONG",
      false,
    );
  }
  if (
    !Number.isFinite(artifact.sizeBytes) ||
    artifact.sizeBytes <= 0 ||
    artifact.sizeBytes > MAX_BILIBILI_BROWSER_BYTES
  ) {
    throw new BilibiliClientError(
      `当前版本支持不超过 ${Math.round(
        MAX_BILIBILI_BROWSER_BYTES / 1024 / 1024,
      )} MB 的 B站视频；更大素材后续将改由服务端直接预处理。`,
      "VIDEO_TOO_LARGE",
      false,
    );
  }

  let downloadURL: URL;
  try {
    downloadURL = new URL(artifact.downloadUrl);
  } catch {
    throw new BilibiliClientError(
      "媒体服务返回的下载地址无效。",
      "INVALID_DOWNLOAD_URL",
      true,
    );
  }
  if (downloadURL.protocol !== "https:" && downloadURL.protocol !== "http:") {
    throw new BilibiliClientError(
      "媒体服务返回的下载地址协议不受支持。",
      "INVALID_DOWNLOAD_URL",
      true,
    );
  }
  if (globalThis.location?.protocol === "https:" && downloadURL.protocol !== "https:") {
    throw new BilibiliClientError(
      "当前页面使用 HTTPS，媒体服务也必须提供 HTTPS 下载地址。",
      "INSECURE_MEDIA_SERVICE",
      false,
    );
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

async function downloadArtifact(
  artifact: BilibiliArtifact,
  options: BilibiliDownloadOptions,
  deadline: number,
) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new BilibiliClientError(
      "B站视频下载超过 22 分钟仍未完成，已自动取消。",
      "BILIBILI_JOB_TIMEOUT",
      true,
    );
  }

  const timeoutSignal = AbortSignal.timeout(remainingMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await downloadArtifactWithSignal(artifact, { ...options, signal });
  } catch (error) {
    if (!options.signal?.aborted && timeoutSignal.aborted) {
      throw new BilibiliClientError(
        "B站视频下载超过 22 分钟仍未完成，已自动取消。",
        "BILIBILI_JOB_TIMEOUT",
        true,
      );
    }
    throw error;
  }
}

async function downloadArtifactWithSignal(
  artifact: BilibiliArtifact,
  options: BilibiliDownloadOptions,
) {
  options.onProgress?.({ stage: "downloading", progress: 0, phase: "ready" });
  let response: Response;
  try {
    response = await fetch(artifact.downloadUrl, {
      method: "GET",
      headers: { accept: "video/*,application/octet-stream" },
      signal: options.signal,
      credentials: "omit",
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new BilibiliClientError(
      "无法读取媒体服务生成的视频，请检查媒体服务 CORS 与网络配置。",
      "MEDIA_DOWNLOAD_NETWORK_ERROR",
      true,
    );
  }
  if (!response.ok || !response.body) {
    throw new BilibiliClientError(
      `媒体文件下载失败（HTTP ${response.status}）。`,
      "MEDIA_DOWNLOAD_FAILED",
      response.status >= 500,
    );
  }

  const responseMimeType = response.headers.get("content-type")?.split(";")[0] ?? "";
  if (
    responseMimeType &&
    !/^video\//i.test(responseMimeType) &&
    responseMimeType !== "application/octet-stream"
  ) {
    await response.body.cancel();
    throw new BilibiliClientError(
      "媒体服务没有返回视频文件。",
      "INVALID_MEDIA_TYPE",
      true,
    );
  }

  const headerLength = Number(response.headers.get("content-length"));
  const expectedBytes = Number.isFinite(headerLength) && headerLength > 0
    ? headerLength
    : artifact.sizeBytes;
  if (expectedBytes > MAX_BILIBILI_BROWSER_BYTES) {
    await response.body.cancel();
    throw new BilibiliClientError(
      "下载视频超过浏览器处理上限。",
      "VIDEO_TOO_LARGE",
      false,
    );
  }

  const reader = response.body.getReader();
  const parts: ArrayBuffer[] = [];
  let receivedBytes = 0;
  while (true) {
    throwIfAborted(options.signal);
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_BILIBILI_BROWSER_BYTES) {
      await reader.cancel();
      throw new BilibiliClientError(
        "下载视频超过浏览器处理上限。",
        "VIDEO_TOO_LARGE",
        false,
      );
    }
    parts.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    options.onProgress?.({
      stage: "downloading",
      progress: clamp(receivedBytes / Math.max(1, expectedBytes), 0, 1),
      phase: "ready",
    });
  }

  if (receivedBytes <= 0) {
    throw new BilibiliClientError("媒体服务返回了空视频。", "EMPTY_MEDIA", true);
  }
  if (artifact.sizeBytes && receivedBytes !== artifact.sizeBytes) {
    throw new BilibiliClientError(
      "视频下载不完整，请重新尝试。",
      "INCOMPLETE_MEDIA",
      true,
    );
  }

  options.onProgress?.({ stage: "downloading", progress: 1, phase: "ready" });
  const mimeType = responseMimeType ||
    artifact.mimeType ||
    "video/mp4";
  return new File(parts, artifact.filename || "bilibili-video.mp4", {
    type: mimeType,
    lastModified: Date.now(),
  });
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
