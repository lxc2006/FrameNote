import type {
  TranscriptLanguage,
  VideoTranscript,
} from "@/shared/media-types";
import {
  DesktopBridgeError,
  desktopAbortError,
  desktopBridge,
  throwIfDesktopAborted,
  unwrapDesktopResult,
} from "./desktop-bridge";

export class TranscriptionClientError extends Error {
  constructor(
    message: string,
    readonly code = "TRANSCRIPTION_FAILED",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TranscriptionClientError";
  }
}

export interface TranscriptionProgress {
  completedChunks: number;
  totalChunks: number;
}

export async function extractOnlineTranscript(
  jobId: string,
  jobKind: "media" | "bilibili",
  languages: TranscriptLanguage[],
  signal?: AbortSignal,
  onProgress?: (progress: TranscriptionProgress) => void,
): Promise<VideoTranscript> {
  const transcription = desktopBridge()?.transcription;
  if (!transcription) {
    throw new TranscriptionClientError(
      "FrameNote 在线字幕桥接不可用，请重新启动应用。",
      "DESKTOP_BRIDGE_UNAVAILABLE",
      true,
    );
  }
  const requestId = crypto.randomUUID();
  throwIfDesktopAborted(signal);
  const cancel = () => transcription.cancelRequest(requestId);
  signal?.addEventListener("abort", cancel, { once: true });
  if (onProgress) transcription.subscribe(requestId, onProgress);
  try {
    const result = await transcription.extract(requestId, {
      jobId,
      jobKind,
      languages,
    });
    throwIfDesktopAborted(signal);
    return unwrapDesktopResult(result);
  } catch (error) {
    if (signal?.aborted) throw desktopAbortError();
    if (error instanceof DesktopBridgeError) {
      throw new TranscriptionClientError(
        error.message,
        error.code,
        error.retryable,
      );
    }
    throw new TranscriptionClientError(
      error instanceof Error ? error.message : "在线字幕识别失败。",
      "TRANSCRIPTION_FAILED",
      true,
    );
  } finally {
    transcription.unsubscribe(requestId);
    signal?.removeEventListener("abort", cancel);
  }
}
