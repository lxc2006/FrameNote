import type {
  DouyinApiErrorBody,
  DouyinPreviewResponse,
} from "@/shared/douyin-api";
import { mediaApiFetch } from "./media-transport";
import { desktopBridge, unwrapDesktopResult } from "./desktop-bridge";

export type DouyinPreviewResult = DouyinPreviewResponse;

interface DouyinPreviewOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { stage: "preparing" | "downloading"; progress: number }) => void;
}

export class DouyinClientError extends Error {
  constructor(
    message: string,
    readonly code = "DOUYIN_RESOLVE_FAILED",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "DouyinClientError";
  }
}

export async function prepareDouyinVideoPreview(
  sourceUrl: string,
  options: DouyinPreviewOptions = {},
): Promise<DouyinPreviewResult> {
  if (options.signal?.aborted) throw abortError();
  options.onProgress?.({ stage: "preparing", progress: 0 });
  try {
    const bridge = desktopBridge();
    if (!bridge) throw new DouyinClientError("桌面桥接不可用，无法建立抖音匿名会话。");
    unwrapDesktopResult(await bridge.media.prepareDouyinSession());
    const response = await mediaApiFetch("/v1/douyin/preview", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceUrl }),
      signal: options.signal,
    });
    const data = (await response.json().catch(() => null)) as
      | DouyinPreviewResponse
      | DouyinApiErrorBody
      | null;
    if (!response.ok || !data || "error" in data) {
      const upstream = data && "error" in data ? data.error : undefined;
      throw new DouyinClientError(
        upstream?.message ?? `抖音视频解析失败（HTTP ${response.status}）。`,
        upstream?.code,
        upstream?.retryable ?? response.status >= 500,
      );
    }
    if (
      typeof data.playbackUrl !== "string" ||
      !data.playbackUrl ||
      typeof data.sourceUrl !== "string" ||
      typeof data.videoId !== "string" ||
      typeof data.title !== "string" ||
      !Number.isFinite(data.durationSeconds) ||
      data.durationSeconds <= 0
    ) {
      throw new DouyinClientError(
        "媒体服务没有返回有效的抖音播放信息。",
        "DOUYIN_PLAYBACK_URL_MISSING",
        true,
      );
    }
    options.onProgress?.({ stage: "downloading", progress: 1 });
    return data;
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw abortError();
    if (error instanceof DouyinClientError) throw error;
    throw new DouyinClientError(
      error instanceof Error ? error.message : "抖音视频解析失败。",
      "DOUYIN_NETWORK_ERROR",
      true,
    );
  }
}

function abortError() {
  return new DOMException("抖音视频获取已取消。", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
