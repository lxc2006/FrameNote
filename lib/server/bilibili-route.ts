import type {
  BilibiliApiErrorBody,
  BilibiliDownloadVariant,
  BilibiliJobSnapshot,
  CreateBilibiliJobRequest,
} from "../bilibili-api";
import { DEFAULT_BILIBILI_DOWNLOAD_VARIANT } from "../bilibili-api";
import {
  BilibiliConfigurationError,
  getBilibiliServiceConfig,
} from "./bilibili-config";

const MAX_CONTROL_BODY_BYTES = 8 * 1024;
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_STATUSES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
const JOB_PHASES = new Set([
  "queued",
  "resolving",
  "downloading",
  "merging",
  "analyzing",
  "ready",
]);
const SUPPORTED_DOWNLOAD_VARIANTS = new Set<BilibiliDownloadVariant>([
  "preview",
  "analysis",
]);

export class BilibiliInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BilibiliInputError";
  }
}

export async function readCreateBilibiliJobRequest(
  request: Request,
): Promise<CreateBilibiliJobRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new BilibiliInputError("请求必须使用 application/json。");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CONTROL_BODY_BYTES) {
    throw new BilibiliInputError("B站下载请求体过大。");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_CONTROL_BODY_BYTES) {
    throw new BilibiliInputError("B站下载请求体过大。");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BilibiliInputError("请求体不是有效 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BilibiliInputError("请求体必须是对象。");
  }

  const bvid = (value as Record<string, unknown>).bvid;
  if (typeof bvid !== "string" || !BVID_PATTERN.test(bvid.trim())) {
    throw new BilibiliInputError("bvid 必须是有效的 BV 号。");
  }

  const variantValue = (value as Record<string, unknown>).variant;
  const variant =
    variantValue === undefined
      ? DEFAULT_BILIBILI_DOWNLOAD_VARIANT
      : variantValue;
  if (
    typeof variant !== "string" ||
    !SUPPORTED_DOWNLOAD_VARIANTS.has(variant as BilibiliDownloadVariant)
  ) {
    throw new BilibiliInputError("variant 只支持 preview 或 analysis。");
  }
  const directSummaryMaxSecondsValue = (
    value as Record<string, unknown>
  ).directSummaryMaxSeconds;
  const directSummaryMaxSeconds =
    directSummaryMaxSecondsValue === undefined
      ? 0
      : directSummaryMaxSecondsValue;
  if (
    typeof directSummaryMaxSeconds !== "number" ||
    !Number.isInteger(directSummaryMaxSeconds) ||
    directSummaryMaxSeconds < 0 ||
    directSummaryMaxSeconds > 900
  ) {
    throw new BilibiliInputError(
      "directSummaryMaxSeconds 必须是 0 到 900 之间的整数。",
    );
  }
  if (variant === "preview" && directSummaryMaxSeconds !== 0) {
    throw new BilibiliInputError(
      "preview 任务不能设置直接总结时长。",
    );
  }

  return {
    bvid: `BV${bvid.trim().slice(2)}`,
    variant: variant as CreateBilibiliJobRequest["variant"],
    ...(directSummaryMaxSeconds > 0
      ? { directSummaryMaxSeconds }
      : {}),
  };
}

export function validateBilibiliJobId(value: string) {
  if (!JOB_ID_PATTERN.test(value)) {
    throw new BilibiliInputError("B站下载任务 ID 无效。");
  }
  return value.toLowerCase();
}

export async function requestBilibiliService(
  path: string,
  init: RequestInit,
  timeoutOverrideMs?: number,
): Promise<Response> {
  const config = getBilibiliServiceConfig();
  if (!config.baseURL) {
    throw new BilibiliConfigurationError(
      "B站媒体服务尚未配置。请先启动 media_service/app.py，并填写 BILIBILI_MEDIA_SERVICE_URL。",
    );
  }

  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (config.token) headers.set("authorization", `Bearer ${config.token}`);

  const timeoutSignal = AbortSignal.timeout(timeoutOverrideMs ?? config.timeoutMs);
  const signals = init.signal ? [init.signal, timeoutSignal] : [timeoutSignal];
  const requestInit = {
    ...init,
    headers,
    signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    ...(init.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
  };

  try {
    return await fetch(`${config.baseURL}${path}`, {
      ...requestInit,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (timeoutSignal.aborted) {
      throw new BilibiliServiceUnavailableError(
        "B站媒体服务响应超时，请稍后重试。",
      );
    }
    throw new BilibiliServiceUnavailableError(
      "无法连接 B站媒体服务，请确认 Python 服务已经启动。",
    );
  }
}

export async function proxyMediaJson(response: Response) {
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const upstream = parseUpstreamError(body);
    return bilibiliErrorResponse(
      normalizeUpstreamStatus(response.status),
      upstream.code,
      upstream.message,
      upstream.retryable,
    );
  }
  if (!isMediaJobSnapshot(body)) {
    return bilibiliErrorResponse(
      502,
      "INVALID_MEDIA_RESPONSE",
      "媒体服务返回了无效任务状态。",
      true,
    );
  }
  return noStoreJson(body, { status: response.status });
}

export async function proxyBilibiliJson(response: Response) {
  const raw = await response.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const upstream = parseUpstreamError(body);
    return bilibiliErrorResponse(
      normalizeUpstreamStatus(response.status),
      upstream.code,
      upstream.message,
      upstream.retryable,
    );
  }

  if (!isJobSnapshot(body)) {
    return bilibiliErrorResponse(
      502,
      "INVALID_MEDIA_RESPONSE",
      "B站媒体服务返回了无效任务状态。",
      true,
    );
  }
  return noStoreJson(body, { status: response.status });
}

export function bilibiliRouteErrorResponse(error: unknown) {
  if (error instanceof BilibiliConfigurationError) {
    return bilibiliErrorResponse(503, "MEDIA_SERVICE_NOT_CONFIGURED", error.message, false);
  }
  if (error instanceof BilibiliInputError) {
    return bilibiliErrorResponse(400, "INVALID_BILIBILI_INPUT", error.message, false);
  }
  if (error instanceof BilibiliServiceUnavailableError) {
    return bilibiliErrorResponse(503, "MEDIA_SERVICE_UNAVAILABLE", error.message, true);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return bilibiliErrorResponse(499, "REQUEST_CANCELLED", "请求已取消。", false);
  }

  console.error("Unexpected Bilibili route error", error);
  return bilibiliErrorResponse(
    500,
    "BILIBILI_INTERNAL_ERROR",
    "B站下载服务发生内部错误。",
    true,
  );
}

class BilibiliServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BilibiliServiceUnavailableError";
  }
}

function parseUpstreamError(value: unknown) {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const errorValue = record.error ?? record.detail;
    if (errorValue && typeof errorValue === "object") {
      const error = errorValue as Record<string, unknown>;
      return {
        code: typeof error.code === "string" ? error.code : "MEDIA_SERVICE_FAILED",
        message:
          typeof error.message === "string"
            ? error.message
            : "B站媒体服务未能完成请求。",
        retryable: typeof error.retryable === "boolean" ? error.retryable : true,
      };
    }
    if (typeof errorValue === "string") {
      return {
        code: "MEDIA_SERVICE_FAILED",
        message: errorValue,
        retryable: true,
      };
    }
  }
  return {
    code: "MEDIA_SERVICE_FAILED",
    message: "B站媒体服务未能完成请求。",
    retryable: true,
  };
}

function isJobSnapshot(value: unknown): value is BilibiliJobSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.jobId !== "string" ||
    !JOB_ID_PATTERN.test(record.jobId) ||
    typeof record.status !== "string" ||
    !JOB_STATUSES.has(record.status) ||
    typeof record.phase !== "string" ||
    !JOB_PHASES.has(record.phase) ||
    typeof record.progress !== "number" ||
    !Number.isFinite(record.progress) ||
    record.progress < 0 ||
    record.progress > 1
  ) {
    return false;
  }

  if (!record.source || typeof record.source !== "object" || Array.isArray(record.source)) {
    return false;
  }
  const source = record.source as Record<string, unknown>;
  if (typeof source.bvid !== "string" || !BVID_PATTERN.test(source.bvid)) return false;
  if (source.title !== undefined && typeof source.title !== "string") return false;
  if (
    source.description !== undefined &&
    (typeof source.description !== "string" || source.description.length > 20_000)
  ) return false;
  if (
    source.durationSeconds !== undefined &&
    (typeof source.durationSeconds !== "number" ||
      !Number.isFinite(source.durationSeconds) ||
      source.durationSeconds <= 0)
  ) {
    return false;
  }

  if (record.artifact !== undefined && !isArtifact(record.artifact)) return false;
  if (record.status === "succeeded" && !isArtifact(record.artifact)) return false;
  if (record.analysis !== undefined && !isAnalysis(record.analysis)) return false;
  if (record.error !== undefined && !isJobError(record.error)) return false;
  return true;
}

function isMediaJobSnapshot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const source = record.source;
  return (
    typeof record.jobId === "string" &&
    JOB_ID_PATTERN.test(record.jobId) &&
    typeof record.status === "string" &&
    JOB_STATUSES.has(record.status) &&
    typeof record.phase === "string" &&
    JOB_PHASES.has(record.phase) &&
    typeof record.progress === "number" &&
    Number.isFinite(record.progress) &&
    record.progress >= 0 &&
    record.progress <= 1 &&
    Boolean(source) &&
    typeof source === "object" &&
    !Array.isArray(source) &&
    ["upload", "url"].includes(
      String((source as Record<string, unknown>).kind),
    ) &&
    (record.artifact === undefined || isArtifact(record.artifact)) &&
    (record.analysis === undefined || isAnalysis(record.analysis)) &&
    (record.error === undefined || isJobError(record.error))
  );
}

function isAnalysis(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const analysis = value as Record<string, unknown>;
  if (analysis.mode !== "direct" && analysis.mode !== "keyframes") return false;
  if (analysis.audio !== undefined) {
    if (!analysis.audio || typeof analysis.audio !== "object") return false;
    const audio = analysis.audio as Record<string, unknown>;
    if (
      typeof audio.url !== "string" ||
      !/^https?:\/\//i.test(audio.url) ||
      typeof audio.mimeType !== "string" ||
      !audio.mimeType.startsWith("audio/") ||
      typeof audio.sizeBytes !== "number" ||
      !Number.isSafeInteger(audio.sizeBytes) ||
      audio.sizeBytes <= 0
    ) {
      return false;
    }
  }
  if (!Array.isArray(analysis.frames) || analysis.frames.length > 64) return false;
  if (analysis.mode === "direct" && analysis.frames.length !== 0) return false;
  if (
    analysis.mode === "keyframes" &&
    (analysis.frames.length < 3 || analysis.audio === undefined)
  ) return false;
  for (const frameValue of analysis.frames) {
    if (!frameValue || typeof frameValue !== "object" || Array.isArray(frameValue)) {
      return false;
    }
    const frame = frameValue as Record<string, unknown>;
    if (
      typeof frame.url !== "string" ||
      !/^https?:\/\//i.test(frame.url) ||
      typeof frame.timestampSeconds !== "number" ||
      !Number.isFinite(frame.timestampSeconds) ||
      frame.timestampSeconds < 0 ||
      typeof frame.score !== "number" ||
      !Number.isFinite(frame.score) ||
      typeof frame.sizeBytes !== "number" ||
      !Number.isSafeInteger(frame.sizeBytes) ||
      frame.sizeBytes <= 0
    ) {
      return false;
    }
  }
  const transcript = analysis.transcript;
  if (!transcript || typeof transcript !== "object" || Array.isArray(transcript)) {
    return false;
  }
  const transcriptRecord = transcript as Record<string, unknown>;
  return (
    (transcriptRecord.status === "ready" ||
      transcriptRecord.status === "pending" ||
      transcriptRecord.status === "unavailable") &&
    typeof transcriptRecord.text === "string" &&
    Array.isArray(transcriptRecord.cues)
  );
}

function isArtifact(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  if (
    artifact.width !== undefined &&
    (typeof artifact.width !== "number" ||
      !Number.isSafeInteger(artifact.width) ||
      artifact.width <= 0 ||
      artifact.width > 4320)
  ) {
    return false;
  }
  if (
    artifact.height !== undefined &&
    (typeof artifact.height !== "number" ||
      !Number.isSafeInteger(artifact.height) ||
      artifact.height <= 0 ||
      artifact.height > 4320)
  ) {
    return false;
  }
  return (
    typeof artifact.playbackUrl === "string" &&
    /^https?:\/\//i.test(artifact.playbackUrl) &&
    typeof artifact.downloadUrl === "string" &&
    /^https?:\/\//i.test(artifact.downloadUrl) &&
    typeof artifact.filename === "string" &&
    artifact.filename.length > 0 &&
    artifact.filename.length <= 255 &&
    typeof artifact.mimeType === "string" &&
    /^video\//i.test(artifact.mimeType) &&
    typeof artifact.sizeBytes === "number" &&
    Number.isSafeInteger(artifact.sizeBytes) &&
    artifact.sizeBytes > 0 &&
    typeof artifact.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(artifact.sha256) &&
    typeof artifact.expiresAt === "string" &&
    Number.isFinite(Date.parse(artifact.expiresAt))
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

function normalizeUpstreamStatus(status: number) {
  if ([400, 401, 403, 404, 409, 413, 422, 429, 503].includes(status)) return status;
  return 502;
}

function bilibiliErrorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
) {
  const body: BilibiliApiErrorBody = { error: { code, message, retryable } };
  return noStoreJson(body, { status });
}

function noStoreJson(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}
