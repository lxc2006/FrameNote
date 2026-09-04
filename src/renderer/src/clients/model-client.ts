import type {
  AnalyzeVideoRequest,
  AskVideoRequest,
  AskVideoResponse,
  AskVideoStreamEvent,
} from "@/shared/model-types";
import {
  DesktopBridgeError,
  desktopAbortError,
  desktopBridge,
  throwIfDesktopAborted,
  unwrapDesktopResult,
} from "./desktop-bridge";

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
  const desktop = requireModelApi();
  const requestId = crypto.randomUUID();
  throwIfDesktopAborted(signal);
  const cancel = () => desktop.cancelRequest(requestId);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await desktop.analyzeVideo(requestId, payload);
    throwIfDesktopAborted(signal);
    return unwrapDesktopResult(result);
  } catch (error) {
    if (signal?.aborted) throw desktopAbortError();
    throw asModelClientError(error);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export interface AskVideoStreamHandlers {
  onEvent?: (event: AskVideoStreamEvent) => void;
}

export async function askVideo(
  payload: AskVideoRequest,
  handlers: AskVideoStreamHandlers = {},
  signal?: AbortSignal,
): Promise<AskVideoResponse> {
  const desktop = requireModelApi();
  const requestId = crypto.randomUUID();
  throwIfDesktopAborted(signal);
  const cancel = () => desktop.cancelRequest(requestId);
  desktop.subscribe(requestId, (event) => handlers.onEvent?.(event));
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await desktop.askVideo(requestId, payload);
    throwIfDesktopAborted(signal);
    return unwrapDesktopResult(result);
  } catch (error) {
    if (signal?.aborted) throw desktopAbortError();
    throw asModelClientError(error);
  } finally {
    signal?.removeEventListener("abort", cancel);
    desktop.unsubscribe(requestId);
  }
}

function requireModelApi() {
  const model = desktopBridge()?.model;
  if (!model) {
    throw new ModelClientError(
      "FrameNote 桌面模型桥接不可用，请重新启动应用。",
      "DESKTOP_BRIDGE_UNAVAILABLE",
      true,
    );
  }
  return model;
}

function asModelClientError(error: unknown) {
  if (error instanceof ModelClientError) return error;
  if (error instanceof DesktopBridgeError) {
    return new ModelClientError(error.message, error.code, error.retryable);
  }
  return new ModelClientError(
    error instanceof Error ? error.message : "桌面模型服务发生未知错误。",
    "DESKTOP_MODEL_ERROR",
    true,
  );
}
