import type {
  AnalyzeVideoRequest,
  AnalyzeVideoResponse,
  AskVideoRequest,
  AskVideoResponse,
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

export async function askVideo(payload: AskVideoRequest, signal?: AbortSignal) {
  return requestModel<AskVideoResponse>("/api/model/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
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
