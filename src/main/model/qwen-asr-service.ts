import { requestMediaService } from "../media/media-service-client";
import { positiveInteger, runtimeValue } from "../config/app-env";
import { getQwenConfig } from "./qwen-config";
import type {
  TranscriptLanguage,
  VideoTranscript,
  VideoTranscriptCue,
} from "../../shared/media-types";

const DEFAULT_MODEL = "qwen-audio-3.0-asr-flash";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_CHUNKS = 32;
const MAX_CHUNK_BYTES = 10 * 1024 * 1024;
const MAX_RETRIES = 2;
const SENTENCE_END = /[。！？!?；;]$/u;
const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TranscriptionInput {
  jobId: string;
  jobKind: "media" | "bilibili";
  languages: TranscriptLanguage[];
}

export interface QwenAsrProgress {
  completedChunks: number;
  totalChunks: number;
}

interface TranscriptionChunk {
  url: string;
  mimeType: string;
  sizeBytes: number;
  startSeconds: number;
  endSeconds: number;
}

interface QwenAsrWord {
  begin_time?: unknown;
  end_time?: unknown;
  text?: unknown;
  punctuation?: unknown;
}

interface QwenAsrSentence {
  begin_time?: unknown;
  end_time?: unknown;
  text?: unknown;
  sentence_end?: unknown;
  words?: unknown;
}

interface QwenAsrResponse {
  request_id?: unknown;
  output?: {
    text?: unknown;
    output?: {
      sentence?: QwenAsrSentence;
    };
    // Retain the former shape so responses from an older compatible endpoint
    // do not silently lose their transcript.
    sentence?: QwenAsrSentence;
  };
}

interface DashScopeErrorResponse {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
}

interface DashScopeErrorDetails {
  code?: string;
  message?: string;
  requestId?: string;
}

export class QwenAsrError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "QwenAsrError";
  }
}

export async function transcribeMediaJob(
  input: TranscriptionInput,
  signal: AbortSignal,
  onProgress?: (progress: QwenAsrProgress) => void,
): Promise<VideoTranscript> {
  validateInput(input);
  const config = getAsrConfig();
  if (!config.apiKey) {
    throw new QwenAsrError(
      "尚未配置 Qwen / DashScope API Key，无法进行在线字幕识别。",
      "QWEN_ASR_NOT_CONFIGURED",
      false,
    );
  }

  const chunks = await loadTranscriptionChunks(input, signal);
  onProgress?.({ completedChunks: 0, totalChunks: chunks.length });
  const audioBuffers = await Promise.all(
    chunks.map((chunk) => downloadChunk(chunk, signal)),
  );
  const cues: VideoTranscriptCue[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    throwIfAborted(signal);
    const response = await recognizeChunk(
      audioBuffers[index],
      chunks[index],
      input.languages,
      config,
      signal,
    );
    const chunkCues = cuesFromResponse(response, chunks[index]);
    cues.push(...chunkCues);
    onProgress?.({
      completedChunks: index + 1,
      totalChunks: chunks.length,
    });
  }

  const text = cues.map((cue) => cue.text.trim()).filter(Boolean).join("\n");
  return {
    status: text ? "ready" : "unavailable",
    text,
    cues,
    language: input.languages.length ? input.languages.join(",") : "auto",
    ...(text ? {} : { error: "Qwen 在线识别没有返回可辨语音。" }),
  };
}

function validateInput(input: TranscriptionInput) {
  if (
    !input ||
    typeof input !== "object" ||
    !JOB_ID_PATTERN.test(input.jobId) ||
    !["media", "bilibili"].includes(input.jobKind) ||
    !Array.isArray(input.languages) ||
    input.languages.length > 3 ||
    input.languages.some((language) => !["zh", "ja", "en"].includes(language))
  ) {
    throw new QwenAsrError("在线字幕请求无效。", "INVALID_TRANSCRIPTION_INPUT", false);
  }
}

function getAsrConfig() {
  const qwen = getQwenConfig();
  const endpointOverride = runtimeValue("DASHSCOPE_ASR_ENDPOINT");
  let endpoint: URL;
  try {
    if (endpointOverride) {
      endpoint = new URL(endpointOverride);
    } else {
      const base = new URL(qwen.baseURL);
      endpoint = new URL(
        "/api/v1/services/aigc/multimodal-generation/generation",
        base,
      );
    }
  } catch {
    throw new QwenAsrError(
      "DashScope 在线字幕服务地址无效。",
      "QWEN_ASR_NOT_CONFIGURED",
      false,
    );
  }
  if (endpoint.protocol !== "https:") {
    throw new QwenAsrError(
      "DashScope 在线字幕服务必须使用 HTTPS。",
      "QWEN_ASR_NOT_CONFIGURED",
      false,
    );
  }
  return {
    apiKey: qwen.apiKey,
    endpoint: endpoint.toString(),
    model: runtimeValue("QWEN_ASR_MODEL") ?? DEFAULT_MODEL,
    timeoutMs: positiveInteger(
      runtimeValue("QWEN_ASR_REQUEST_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

async function loadTranscriptionChunks(
  input: TranscriptionInput,
  signal: AbortSignal,
): Promise<TranscriptionChunk[]> {
  const response = await requestMediaService(
    `/v1/${input.jobKind}/jobs/${input.jobId}`,
    { method: "GET", signal },
    30_000,
  );
  const body = (await response.json().catch(() => null)) as {
    status?: unknown;
    analysis?: { transcriptionAudio?: unknown };
    error?: { message?: unknown };
  } | null;
  if (!response.ok) {
    throw new QwenAsrError(
      typeof body?.error?.message === "string"
        ? body.error.message
        : `媒体核心返回 HTTP ${response.status}。`,
      "TRANSCRIPTION_AUDIO_UNAVAILABLE",
      response.status >= 500,
    );
  }
  const rawChunks = body?.analysis?.transcriptionAudio;
  if (body?.status !== "succeeded" || !Array.isArray(rawChunks)) {
    throw new QwenAsrError(
      "媒体核心没有返回在线识别音轨。",
      "TRANSCRIPTION_AUDIO_UNAVAILABLE",
      true,
    );
  }
  if (rawChunks.length === 0 || rawChunks.length > MAX_CHUNKS) {
    throw new QwenAsrError(
      "在线识别音频分片数量无效。",
      "INVALID_TRANSCRIPTION_AUDIO",
      false,
    );
  }
  return rawChunks.map((raw, index) => parseChunk(raw, index));
}

function parseChunk(value: unknown, index: number): TranscriptionChunk {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new QwenAsrError(
      `在线识别音频分片 ${index + 1} 无效。`,
      "INVALID_TRANSCRIPTION_AUDIO",
      false,
    );
  }
  const chunk = value as Record<string, unknown>;
  if (
    typeof chunk.url !== "string" ||
    !isLoopbackChunkUrl(chunk.url) ||
    chunk.mimeType !== "audio/mpeg" ||
    typeof chunk.sizeBytes !== "number" ||
    !Number.isFinite(chunk.sizeBytes) ||
    chunk.sizeBytes <= 0 ||
    chunk.sizeBytes > MAX_CHUNK_BYTES ||
    typeof chunk.startSeconds !== "number" ||
    !Number.isFinite(chunk.startSeconds) ||
    typeof chunk.endSeconds !== "number" ||
    !Number.isFinite(chunk.endSeconds) ||
    chunk.startSeconds < 0 ||
    chunk.endSeconds <= chunk.startSeconds ||
    chunk.endSeconds - chunk.startSeconds > 300.5
  ) {
    throw new QwenAsrError(
      `在线识别音频分片 ${index + 1} 元数据无效。`,
      "INVALID_TRANSCRIPTION_AUDIO",
      false,
    );
  }
  return chunk as unknown as TranscriptionChunk;
}

function isLoopbackChunkUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Boolean(url.port) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

async function downloadChunk(chunk: TranscriptionChunk, signal: AbortSignal) {
  const response = await fetch(chunk.url, {
    signal,
    headers: { accept: "audio/mpeg" },
  });
  if (!response.ok) {
    throw new QwenAsrError(
      `无法读取在线识别音频（HTTP ${response.status}）。`,
      "TRANSCRIPTION_AUDIO_UNAVAILABLE",
      response.status >= 500,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length <= 0 ||
    bytes.length > MAX_CHUNK_BYTES ||
    bytes.length > Math.max(chunk.sizeBytes + 64 * 1024, chunk.sizeBytes * 1.1)
  ) {
    throw new QwenAsrError(
      "媒体核心返回的在线识别音频大小无效。",
      "INVALID_TRANSCRIPTION_AUDIO",
      false,
    );
  }
  return bytes;
}

async function recognizeChunk(
  audio: Buffer,
  chunk: TranscriptionChunk,
  languages: TranscriptLanguage[],
  config: ReturnType<typeof getAsrConfig>,
  signal: AbortSignal,
): Promise<QwenAsrResponse> {
  const payload = {
    model: config.model,
    input: {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: `data:audio/mpeg;base64,${audio.toString("base64")}`,
              },
            },
          ],
        },
      ],
    },
    parameters: {
      format: "mp3",
      sample_rate: "16000",
      ...(languages.length ? { language_hints: languages } : {}),
    },
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    throwIfAborted(signal);
    const timeout = AbortSignal.timeout(config.timeoutMs);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
          "x-dashscope-sse": "disable",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, timeout]),
      });
      const body = (await response.json().catch(() => null)) as
        | QwenAsrResponse
        | DashScopeErrorResponse
        | null;
      if (response.ok && body) return body as QwenAsrResponse;
      const details = dashScopeErrorDetails(body);
      if (isEmptyAsrChunk(response.status, details)) {
        console.info("[qwen-asr] Empty audio chunk skipped", {
          code: details.code ?? "unknown",
          message: details.message ?? "ASR_RESPONSE_HAVE_NO_WORDS",
          request_id: details.requestId ?? "unknown",
          audioRange: formatRange(chunk),
        });
        return {
          request_id: details.requestId,
          output: { text: "" },
        };
      }
      if (response.status === 401 || response.status === 403) {
        logDashScopeFailure(response.status, details, chunk);
        throw new QwenAsrError(
          dashScopeFailureMessage(
            "Qwen 在线字幕鉴权失败，请检查 DashScope API Key。",
            details,
          ),
          "QWEN_ASR_AUTH_FAILED",
          false,
        );
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        await abortableDelay(750 * 2 ** attempt, signal);
        continue;
      }
      logDashScopeFailure(response.status, details, chunk);
      throw new QwenAsrError(
        dashScopeFailureMessage(
          response.status === 429
            ? "Qwen 在线字幕请求过多或额度不足，请稍后重试。"
            : `Qwen 在线字幕识别失败（HTTP ${response.status}）。`,
          details,
        ),
        response.status === 429
          ? "QWEN_ASR_RATE_LIMITED"
          : "QWEN_ASR_REQUEST_FAILED",
        retryable,
      );
    } catch (error) {
      if (error instanceof QwenAsrError) throw error;
      if (signal.aborted) throw error;
      if (attempt < MAX_RETRIES) {
        await abortableDelay(750 * 2 ** attempt, signal);
        continue;
      }
      throw new QwenAsrError(
        `Qwen 在线字幕识别超时或网络异常（${formatRange(chunk)}）。`,
        "QWEN_ASR_NETWORK_ERROR",
        true,
      );
    }
  }
  throw new QwenAsrError(
    "Qwen 在线字幕识别失败。",
    "QWEN_ASR_REQUEST_FAILED",
    true,
  );
}

function dashScopeErrorDetails(
  body: QwenAsrResponse | DashScopeErrorResponse | null,
): DashScopeErrorDetails {
  const errorBody = body as DashScopeErrorResponse | null;
  return {
    code: safeDashScopeText(errorBody?.code, 120),
    message: safeDashScopeText(errorBody?.message, 500),
    requestId: safeDashScopeText(errorBody?.request_id, 128),
  };
}

function isEmptyAsrChunk(status: number, details: DashScopeErrorDetails) {
  if (status !== 400) return false;
  return [details.code, details.message].some(
    (value) => value?.toUpperCase() === "ASR_RESPONSE_HAVE_NO_WORDS",
  );
}

function safeDashScopeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/data:audio\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/giu, "[audio data omitted]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, "sk-***")
    .replace(/bearer\s+\S+/giu, "Bearer ***")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function dashScopeFailureMessage(
  summary: string,
  details: DashScopeErrorDetails,
) {
  const identifiers = [
    details.code ? `code: ${details.code}` : null,
    details.requestId ? `request_id: ${details.requestId}` : null,
  ].filter((value): value is string => Boolean(value));
  return `${summary}${details.message ? ` ${details.message}` : ""}${
    identifiers.length ? `（${identifiers.join("；")}）` : ""
  }`;
}

function logDashScopeFailure(
  status: number,
  details: DashScopeErrorDetails,
  chunk: TranscriptionChunk,
) {
  console.error("[qwen-asr] DashScope request failed", {
    status,
    code: details.code ?? "unknown",
    message: details.message ?? "No provider message returned.",
    request_id: details.requestId ?? "unknown",
    audioRange: formatRange(chunk),
  });
}

function cuesFromResponse(
  response: QwenAsrResponse,
  chunk: TranscriptionChunk,
): VideoTranscriptCue[] {
  const sentence =
    response.output?.output?.sentence ?? response.output?.sentence;
  const words = Array.isArray(sentence?.words)
    ? sentence.words.filter(
        (word): word is QwenAsrWord =>
          Boolean(word) && typeof word === "object" && !Array.isArray(word),
      )
    : [];
  const cues = words.length ? cuesFromWords(words, chunk) : [];
  if (cues.length) return cues;

  const text =
    typeof sentence?.text === "string"
      ? sentence.text.trim()
      : typeof response.output?.text === "string"
        ? response.output.text.trim()
        : "";
  if (!text) return [];
  const chunkDuration = chunk.endSeconds - chunk.startSeconds;
  const begin = clamp(
    milliseconds(sentence?.begin_time, 0),
    0,
    Math.max(0, chunkDuration - 0.01),
  );
  const end = clamp(
    milliseconds(sentence?.end_time, chunkDuration),
    begin + 0.01,
    chunkDuration,
  );
  return [
    {
      startSeconds: roundTime(chunk.startSeconds + begin),
      endSeconds: roundTime(
        Math.min(
          chunk.endSeconds,
          chunk.startSeconds + Math.max(begin + 0.01, end),
        ),
      ),
      text,
    },
  ];
}

function cuesFromWords(
  words: QwenAsrWord[],
  chunk: TranscriptionChunk,
): VideoTranscriptCue[] {
  const cues: VideoTranscriptCue[] = [];
  const chunkDuration = chunk.endSeconds - chunk.startSeconds;
  let text = "";
  let start = 0;
  let end = 0;

  const flush = () => {
    const normalized = text.trim();
    if (normalized) {
      cues.push({
        startSeconds: roundTime(chunk.startSeconds + start),
        endSeconds: roundTime(
          Math.min(
            chunk.endSeconds,
            chunk.startSeconds + Math.max(start + 0.01, end),
          ),
        ),
        text: normalized,
      });
    }
    text = "";
  };

  for (const word of words) {
    const wordText = typeof word.text === "string" ? word.text : "";
    const punctuation =
      typeof word.punctuation === "string" ? word.punctuation : "";
    if (!wordText.trim() && !punctuation) continue;
    const wordStart = clamp(
      milliseconds(word.begin_time, end),
      0,
      Math.max(0, chunkDuration - 0.01),
    );
    const wordEnd = clamp(
      milliseconds(word.end_time, Math.max(wordStart + 0.01, end)),
      wordStart + 0.01,
      chunkDuration,
    );
    if (!text) start = wordStart;
    text += wordText;
    if (punctuation && !text.endsWith(punctuation)) text += punctuation;
    end = Math.max(wordEnd, wordStart + 0.01);
    if (SENTENCE_END.test(text.trim()) || text.length >= 80 || end - start >= 18) {
      flush();
    }
  }
  flush();
  return cues;
}

function milliseconds(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value / 1000)
    : fallback;
}

function roundTime(value: number) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatRange(chunk: TranscriptionChunk) {
  return `${Math.floor(chunk.startSeconds)}–${Math.ceil(chunk.endSeconds)} 秒`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("在线字幕识别已取消。", "AbortError"));
      },
      { once: true },
    );
  });
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException("在线字幕识别已取消。", "AbortError");
  }
}
