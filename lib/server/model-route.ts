import OpenAI from "openai";
import type { AnalyzeVideoRequest, AskVideoRequest } from "../model-api";
import type {
  VideoConversationMessage,
  VideoModelContext,
  VideoSourceDescriptor,
  VideoSummary,
} from "../video-engine";
import {
  QwenConfigurationError,
  QwenInputError,
  QwenResponseError,
  parseVideoSummary,
} from "./qwen-video-engine";
import {
  DeepSeekConfigurationError,
  DeepSeekInputError,
  DeepSeekResponseError,
} from "./deepseek-conversation-engine";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARACTERS = 1_500_000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_FRAME_URLS = 256;
const AUDIO_FORMATS = ["mp3", "wav", "aac", "m4a", "ogg", "webm"] as const;

export async function readJsonRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new QwenInputError("请求必须使用 application/json。");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BYTES) {
    throw new QwenInputError("模型请求体过大，请改用对象存储中的视频 URL。");
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_JSON_BYTES) {
    throw new QwenInputError("模型请求体过大，请改用对象存储中的视频 URL。");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new QwenInputError("请求体不是有效 JSON。");
  }
}

export function parseAnalyzeVideoRequest(value: unknown): AnalyzeVideoRequest {
  const object = recordValue(value, "请求体");
  return {
    source: parseSource(object.source),
    context: parseContext(object.context, true),
  };
}

export function parseAskVideoRequest(value: unknown): AskVideoRequest {
  const object = recordValue(value, "请求体");
  const source = parseSource(object.source);
  const question = stringValue(object.question, "question", 4_000);
  const summary = parseSummaryInput(object.summary, source.title);
  const history = object.history === undefined
    ? undefined
    : parseHistory(object.history);

  return {
    question,
    source,
    summary,
    ...(object.context === undefined
      ? {}
      : { context: parseContext(object.context, true) }),
    ...(history ? { history } : {}),
  };
}

export function modelErrorResponse(
  error: unknown,
  provider: "qwen" | "deepseek" = "qwen",
) {
  if (
    error instanceof QwenConfigurationError ||
    error instanceof DeepSeekConfigurationError
  ) {
    return errorResponse(503, "MODEL_NOT_CONFIGURED", error.message, false);
  }
  if (error instanceof QwenInputError || error instanceof DeepSeekInputError) {
    return errorResponse(400, "INVALID_MODEL_INPUT", error.message, false);
  }
  if (error instanceof QwenResponseError || error instanceof DeepSeekResponseError) {
    return errorResponse(502, "INVALID_MODEL_RESPONSE", error.message, true);
  }
  if (error instanceof OpenAI.APIError) {
    const label = provider === "deepseek" ? "DeepSeek" : "Qwen";
    const codePrefix = provider === "deepseek" ? "DEEPSEEK" : "QWEN";
    if (error.status === 401 || error.status === 403) {
      return errorResponse(
        502,
        `${codePrefix}_AUTH_FAILED`,
        `${label} 鉴权失败，请检查 API Key 和 Base URL 是否匹配。`,
        false,
      );
    }
    if (error.status === 429) {
      return errorResponse(
        429,
        `${codePrefix}_RATE_LIMITED`,
        `${label} 当前请求过多或额度不足，请稍后重试。`,
        true,
      );
    }
    return errorResponse(
      502,
      `${codePrefix}_REQUEST_FAILED`,
      `${label} 模型调用失败，请稍后重试。`,
      true,
    );
  }

  console.error("Unexpected model route error", error);
  return errorResponse(500, "MODEL_INTERNAL_ERROR", "模型服务发生内部错误。", true);
}

export function noStoreJson(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
) {
  return noStoreJson(
    { error: { code, message, retryable } },
    { status },
  );
}

function parseSource(value: unknown): VideoSourceDescriptor {
  const object = recordValue(value, "source");
  const kind = object.kind;
  if (kind !== "upload" && kind !== "bilibili" && kind !== "url") {
    throw new QwenInputError("source.kind 必须是 upload、bilibili 或 url。");
  }

  return {
    kind,
    title: stringValue(object.title, "source.title", 300),
    subtitle: stringValue(object.subtitle, "source.subtitle", 1_000),
    downloadFirst: booleanValue(object.downloadFirst, "source.downloadFirst"),
    ...(optionalString(object.durationLabel, "source.durationLabel", 100)
      ? { durationLabel: optionalString(object.durationLabel, "source.durationLabel", 100) }
      : {}),
    ...(optionalString(object.bvid, "source.bvid", 20)
      ? { bvid: optionalString(object.bvid, "source.bvid", 20) }
      : {}),
    ...(optionalString(object.sourceUrl, "source.sourceUrl", 2_048)
      ? { sourceUrl: optionalString(object.sourceUrl, "source.sourceUrl", 2_048) }
      : {}),
  };
}

function parseContext(value: unknown, required: boolean): VideoModelContext {
  const object = recordValue(value, "context");
  const videoUrl = optionalString(object.videoUrl, "context.videoUrl", MAX_JSON_BYTES);
  const transcript = optionalString(
    object.transcript,
    "context.transcript",
    MAX_TRANSCRIPT_CHARACTERS,
  );
  const frameUrls = object.frameUrls === undefined
    ? undefined
    : parseFrameUrls(object.frameUrls);
  const frameTimestamps = object.frameTimestamps === undefined
    ? undefined
    : parseFrameTimestamps(object.frameTimestamps, frameUrls?.length);
  const audioUrl = optionalString(object.audioUrl, "context.audioUrl", MAX_JSON_BYTES);
  const audioFormat = object.audioFormat === undefined
    ? undefined
    : parseAudioFormat(object.audioFormat);
  const fps = object.fps === undefined ? undefined : numberValue(object.fps, "context.fps");

  if (videoUrl) validateMediaUrl(videoUrl, "context.videoUrl", "video");
  if (audioUrl) validateMediaUrl(audioUrl, "context.audioUrl", "audio");
  if (audioFormat && !audioUrl) {
    throw new QwenInputError("context.audioFormat 需要与 context.audioUrl 一起提供。");
  }
  if (fps !== undefined && (fps < 0.1 || fps > 10)) {
    throw new QwenInputError("context.fps 必须在 0.1 到 10 之间。");
  }
  if (required && !videoUrl && !frameUrls?.length && !audioUrl && !transcript) {
    throw new QwenInputError(
      "context 至少需要 videoUrl、frameUrls、audioUrl 或 transcript 之一。",
    );
  }

  return {
    ...(videoUrl ? { videoUrl } : {}),
    ...(frameUrls ? { frameUrls } : {}),
    ...(frameTimestamps ? { frameTimestamps } : {}),
    ...(audioUrl ? { audioUrl } : {}),
    ...(audioFormat ? { audioFormat } : {}),
    ...(transcript ? { transcript } : {}),
    ...(fps !== undefined ? { fps } : {}),
  };
}

function parseFrameTimestamps(value: unknown, frameCount?: number) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new QwenInputError("context.frameTimestamps 必须是非空数组。");
  }
  if (!frameCount || value.length !== frameCount) {
    throw new QwenInputError(
      "context.frameTimestamps 必须与 context.frameUrls 数量一致。",
    );
  }
  let previous = -1;
  return value.map((item, index) => {
    const time = numberValue(item, `context.frameTimestamps[${index}]`);
    if (time < 0 || time < previous) {
      throw new QwenInputError(
        "context.frameTimestamps 必须是按时间升序排列的非负数。",
      );
    }
    previous = time;
    return time;
  });
}

function parseAudioFormat(value: unknown) {
  if (
    typeof value !== "string" ||
    !AUDIO_FORMATS.includes(value as (typeof AUDIO_FORMATS)[number])
  ) {
    throw new QwenInputError(
      `context.audioFormat 必须是 ${AUDIO_FORMATS.join("、")} 之一。`,
    );
  }
  return value as (typeof AUDIO_FORMATS)[number];
}

function parseFrameUrls(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FRAME_URLS) {
    throw new QwenInputError(
      `context.frameUrls 必须包含 1 到 ${MAX_FRAME_URLS} 个地址。`,
    );
  }
  return value.map((item, index) => {
    const url = stringValue(item, `context.frameUrls[${index}]`, MAX_JSON_BYTES);
    validateMediaUrl(url, `context.frameUrls[${index}]`, "image");
    return url;
  });
}

function validateMediaUrl(
  value: string,
  field: string,
  mediaKind: "image" | "video" | "audio",
) {
  if (value.startsWith("https://")) return;
  const dataPrefix = mediaKind === "video"
    ? /^data:(?:video\/[^;,]+)?;base64,/i
    : mediaKind === "audio"
      ? /^data:(?:audio\/[^;,]+)?;base64,/i
      : /^data:image\/[^;,]+;base64,/i;
  if (dataPrefix.test(value)) return;
  throw new QwenInputError(`${field} 必须是 HTTPS 地址或受支持的 Base64 data URL。`);
}

function parseSummaryInput(value: unknown, fallbackTitle: string): VideoSummary {
  try {
    return parseVideoSummary(JSON.stringify(value), fallbackTitle);
  } catch (error) {
    if (error instanceof QwenResponseError) {
      throw new QwenInputError(`summary 格式无效：${error.message}`);
    }
    throw error;
  }
}

function parseHistory(value: unknown): VideoConversationMessage[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_MESSAGES) {
    throw new QwenInputError(`history 最多包含 ${MAX_HISTORY_MESSAGES} 条消息。`);
  }
  return value.map((item, index) => {
    const object = recordValue(item, `history[${index}]`);
    if (object.role !== "assistant" && object.role !== "user") {
      throw new QwenInputError(`history[${index}].role 格式无效。`);
    }
    return {
      role: object.role,
      content: stringValue(object.content, `history[${index}].content`, 8_000),
    };
  });
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QwenInputError(`${field} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new QwenInputError(`${field} 必须是非空字符串。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new QwenInputError(`${field} 超过长度限制。`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string, maxLength: number) {
  if (value === undefined || value === null || value === "") return undefined;
  return stringValue(value, field, maxLength);
}

function booleanValue(value: unknown, field: string) {
  if (typeof value !== "boolean") {
    throw new QwenInputError(`${field} 必须是布尔值。`);
  }
  return value;
}

function numberValue(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new QwenInputError(`${field} 必须是有限数字。`);
  }
  return value;
}
