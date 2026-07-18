import type {
  BilibiliApiErrorBody,
  BilibiliJobSnapshot,
  CreateBilibiliJobRequest,
} from "../bilibili-api";
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
  "ready",
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
  return { bvid: `BV${bvid.trim().slice(2)}` };
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

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const signals = init.signal ? [init.signal, timeoutSignal] : [timeoutSignal];

  try {
    return await fetch(`${config.baseURL}${path}`, {
      ...init,
      headers,
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
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
    source.durationSeconds !== undefined &&
    (typeof source.durationSeconds !== "number" ||
      !Number.isFinite(source.durationSeconds) ||
      source.durationSeconds <= 0)
  ) {
    return false;
  }

  if (record.artifact !== undefined && !isArtifact(record.artifact)) return false;
  if (record.status === "succeeded" && !isArtifact(record.artifact)) return false;
  if (record.error !== undefined && !isJobError(record.error)) return false;
  return true;
}

function isArtifact(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  return (
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
