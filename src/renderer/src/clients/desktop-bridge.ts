import type {
  DesktopIpcResult,
  FrameNoteDesktopApi,
} from "@/shared/ipc-contract";

export class DesktopBridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "DesktopBridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function desktopBridge(): FrameNoteDesktopApi | undefined {
  return typeof window === "undefined" ? undefined : window.framenoteDesktop;
}

export function unwrapDesktopResult<T>(result: DesktopIpcResult<T>): T {
  if (result.ok) return result.value;
  throw new DesktopBridgeError(
    result.error.message,
    result.error.code,
    result.error.retryable,
  );
}

export function desktopAbortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function throwIfDesktopAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw desktopAbortError();
}
