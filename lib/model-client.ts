import type {
  AnalyzeVideoRequest,
  AnalyzeVideoResponse,
  AskVideoRequest,
  AskVideoResponse,
  AskVideoStreamEvent,
  ModelApiErrorBody,
} from "./model-api";

export class ModelClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = "MODEL_REQUEST_FAILED", retryable = false) {
    super(message);
    this.name = "ModelClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export async function analyzeVideo(
  payload: AnalyzeVideoRequest,
  signal?: AbortSignal,
) {
  return requestModel<AnalyzeVideoResponse>("/api/model/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
}

export interface AskVideoStreamHandlers {
  onEvent?: (event: AskVideoStreamEvent) => void;
}

export async function askVideo(
  payload: AskVideoRequest,
  handlers: AskVideoStreamHandlers = {},
  signal?: AbortSignal,
): Promise<AskVideoResponse> {
  let response: Response;
  try {
    response = await fetch("/api/model/ask", {
      method: "POST",
      headers: {
        accept: "text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ModelClientError(
      "无法连接模型服务，请检查网络后重试。",
      "NETWORK_ERROR",
      true,
    );
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      | ModelApiErrorBody
      | null;
    throw new ModelClientError(
      body?.error?.message ?? `模型服务返回 HTTP ${response.status}。`,
      body?.error?.code,
      body?.error?.retryable,
    );
  }
  if (!response.body) {
    throw new ModelClientError(
      "模型服务没有返回可读取的数据流。",
      "EMPTY_RESPONSE",
      true,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneResult: AskVideoResponse | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const event = parseSseEvent(frame);
        if (!event) continue;
        handlers.onEvent?.(event);
        if (event.type === "error") {
          throw new ModelClientError(
            event.error.message,
            event.error.code,
            event.error.retryable,
          );
        }
        if (event.type === "done") {
          doneResult = event;
        }
      }
      if (done) break;
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  if (!doneResult) {
    throw new ModelClientError(
      "模型数据流在完成前意外结束。",
      "INCOMPLETE_STREAM",
      true,
    );
  }
  return doneResult;
}

function parseSseEvent(frame: string): AskVideoStreamEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  try {
    return JSON.parse(data) as AskVideoStreamEvent;
  } catch {
    throw new ModelClientError(
      "模型服务返回了无效的数据流。",
      "INVALID_STREAM",
      true,
    );
  }
}

function isAbortError(error: unknown) {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

async function requestModel<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ModelClientError("无法连接模型服务，请检查网络后重试。", "NETWORK_ERROR", true);
  }

  const body = await response.json().catch(() => null) as
    | T
    | ModelApiErrorBody
    | null;
  if (!response.ok) {
    const modelError = body && typeof body === "object" && "error" in body
      ? body.error
      : null;
    throw new ModelClientError(
      modelError?.message ?? `模型服务返回 HTTP ${response.status}。`,
      modelError?.code,
      modelError?.retryable,
    );
  }
  if (!body) throw new ModelClientError("模型服务返回了空响应。", "EMPTY_RESPONSE", true);
  return body as T;
}
