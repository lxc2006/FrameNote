export interface TimedVideoFrame {
  data: Uint8Array;
  timestamp: number;
}

export interface NativeFrameExtractionOptions {
  timestamps: number[];
  maxEdge: number;
  jpegQuality: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  seekTimeoutMs?: number;
  onProgress?: (progress: number) => void;
}

export interface FfmpegFrameExtractionOptions {
  inputPath: string;
  timestamps: number[];
  maxEdge: number;
  jpegQuality: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  seekTimeoutMs?: number;
  onProgress?: (progress: number) => void;
}

export interface FrameExtractionFallbackOptions {
  minimumFrames: number;
  signal?: AbortSignal;
  nativeExtractor?: (
    onProgress: (progress: number) => void,
  ) => Promise<TimedVideoFrame[]>;
  fallbackExtractor: (
    onProgress: (progress: number) => void,
  ) => Promise<TimedVideoFrame[]>;
  onProgress?: (progress: number) => void;
}

interface FfmpegFrameApi {
  exec: (
    args: string[],
    timeout?: number,
    options?: { signal?: AbortSignal },
  ) => Promise<number>;
  readFile: (
    path: string,
    encoding?: string,
    options?: { signal?: AbortSignal },
  ) => Promise<Uint8Array | string>;
  deleteFile: (path: string, options?: { signal?: AbortSignal }) => Promise<boolean>;
}

const NATIVE_EXTRACTION_TIMEOUT_MS = 60_000;
const NATIVE_SEEK_TIMEOUT_MS = 8_000;
const FFMPEG_EXTRACTION_TIMEOUT_MS = 120_000;
const FFMPEG_SEEK_TIMEOUT_MS = 12_000;
const CANVAS_ENCODE_TIMEOUT_MS = 8_000;
const HAVE_CURRENT_DATA = 2;

export class NativeFrameExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeFrameExtractionError";
  }
}

export function canUseNativeFrameExtraction(file: File) {
  const mimeType = file.type.toLowerCase();
  return (
    mimeType === "video/mp4" ||
    mimeType === "video/webm" ||
    /\.(?:mp4|m4v|mov|webm)$/i.test(file.name)
  );
}

export function fitFrameDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxEdge: number,
) {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    !Number.isFinite(maxEdge) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0 ||
    maxEdge < 2
  ) {
    throw new RangeError("Frame dimensions and maxEdge must be positive.");
  }

  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const toEvenDimension = (value: number) =>
    Math.max(2, Math.floor((value * scale) / 2) * 2);
  return {
    width: toEvenDimension(sourceWidth),
    height: toEvenDimension(sourceHeight),
  };
}

export async function extractFramesWithFallback(
  options: FrameExtractionFallbackOptions,
) {
  const nativeWeight = 0.15;
  let reportedProgress = 0;
  const report = (progress: number) => {
    reportedProgress = Math.max(reportedProgress, clamp(progress, 0, 1));
    options.onProgress?.(reportedProgress);
  };

  if (options.nativeExtractor) {
    try {
      const frames = await options.nativeExtractor((progress) =>
        report(progress * nativeWeight),
      );
      if (frames.length >= options.minimumFrames) {
        report(1);
        return frames;
      }
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) throw error;
    }
  }

  throwIfAborted(options.signal);
  const fallbackFloor = reportedProgress;
  const frames = await options.fallbackExtractor((progress) =>
    report(fallbackFloor + (1 - fallbackFloor) * progress),
  );
  if (frames.length >= options.minimumFrames) report(1);
  return frames;
}

export async function extractFramesWithNativeVideo(
  file: File,
  options: NativeFrameExtractionOptions,
): Promise<TimedVideoFrame[]> {
  throwIfAborted(options.signal);
  if (typeof document === "undefined") {
    throw new NativeFrameExtractionError("当前环境不支持浏览器原生视频抽帧。");
  }

  const timeoutMs = options.timeoutMs ?? NATIVE_EXTRACTION_TIMEOUT_MS;
  const seekTimeoutMs = options.seekTimeoutMs ?? NATIVE_SEEK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const video = document.createElement("video");
  let canvas: HTMLCanvasElement | undefined;
  const objectUrl = URL.createObjectURL(file);
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    const metadata = waitForMediaEvent(
      video,
      ["loadedmetadata"],
      options.signal,
      remainingTime(deadline, seekTimeoutMs),
    );
    video.src = objectUrl;
    video.load();
    await metadata;

    if (!video.videoWidth || !video.videoHeight) {
      throw new NativeFrameExtractionError("视频没有可读取的画面尺寸。");
    }
    if (video.readyState < HAVE_CURRENT_DATA) {
      await waitForMediaEvent(
        video,
        ["loadeddata", "canplay"],
        options.signal,
        remainingTime(deadline, seekTimeoutMs),
      );
    }

    canvas = document.createElement("canvas");
    const { width: targetWidth, height: targetHeight } = fitFrameDimensions(
      video.videoWidth,
      video.videoHeight,
      options.maxEdge,
    );
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
      throw new NativeFrameExtractionError("浏览器无法创建关键帧画布。");
    }

    const frames: TimedVideoFrame[] = [];
    for (const [index, requestedTimestamp] of options.timestamps.entries()) {
      throwIfAborted(options.signal);
      const timestamp = clampTimestamp(requestedTimestamp, video.duration);
      if (
        Math.abs(video.currentTime - timestamp) > 0.01 ||
        video.readyState < HAVE_CURRENT_DATA
      ) {
        const seeked = waitForMediaEvent(
          video,
          ["seeked"],
          options.signal,
          remainingTime(deadline, seekTimeoutMs),
        );
        video.currentTime = timestamp;
        await seeked;
      }

      context.fillStyle = "#000";
      context.fillRect(0, 0, targetWidth, targetHeight);
      context.drawImage(video, 0, 0, targetWidth, targetHeight);
      const blob = await canvasToJpeg(
        canvas,
        options.jpegQuality,
        options.signal,
        remainingTime(deadline, CANVAS_ENCODE_TIMEOUT_MS),
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      throwIfAborted(options.signal);
      remainingTime(deadline, 1);
      frames.push({ data: bytes, timestamp });
      options.onProgress?.((index + 1) / options.timestamps.length);
    }
    return frames;
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) throw error;
    if (error instanceof NativeFrameExtractionError) throw error;
    throw new NativeFrameExtractionError(
      error instanceof Error
        ? `浏览器原生视频抽帧失败：${error.message}`
        : "浏览器原生视频抽帧失败。",
    );
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas.remove();
    }
    URL.revokeObjectURL(objectUrl);
  }
}

export async function extractFramesWithFfmpegSeeks(
  ffmpeg: FfmpegFrameApi,
  options: FfmpegFrameExtractionOptions,
): Promise<TimedVideoFrame[]> {
  const timeoutMs = options.timeoutMs ?? FFMPEG_EXTRACTION_TIMEOUT_MS;
  const seekTimeoutMs = options.seekTimeoutMs ?? FFMPEG_SEEK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const frames: TimedVideoFrame[] = [];

  for (const [index, timestamp] of options.timestamps.entries()) {
    throwIfAborted(options.signal);
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const outputPath = `/frame-fast-${String(index + 1).padStart(3, "0")}.jpg`;
    const exitCode = await ffmpeg.exec(
      [
        "-ss",
        timestamp.toFixed(3),
        "-i",
        options.inputPath,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale=w=min(${options.maxEdge}\\,iw):h=min(${options.maxEdge}\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2`,
        "-frames:v",
        "1",
        "-q:v",
        String(options.jpegQuality),
        outputPath,
      ],
      Math.max(1, Math.min(seekTimeoutMs, remaining)),
      { signal: options.signal },
    );

    if (exitCode === 0) {
      try {
        const data = await ffmpeg.readFile(outputPath, undefined, {
          signal: options.signal,
        });
        if (data instanceof Uint8Array) {
          frames.push({ data, timestamp });
        }
      } finally {
        await ffmpeg.deleteFile(outputPath).catch(() => false);
      }
    }
    options.onProgress?.((index + 1) / options.timestamps.length);
  }

  return frames;
}

function waitForMediaEvent(
  video: HTMLVideoElement,
  successEvents: string[],
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(
      () => finish(() => reject(new NativeFrameExtractionError("视频跳转等待超时。"))),
      timeoutMs,
    );
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      for (const event of successEvents) video.removeEventListener(event, onSuccess);
      video.removeEventListener("error", onError);
      video.removeEventListener("abort", onError);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onSuccess = () => finish(resolve);
    const onError = () =>
      finish(() =>
        reject(
          new NativeFrameExtractionError(
            video.error?.message || "浏览器无法解码该视频。",
          ),
        ),
      );
    const onAbort = () =>
      finish(() => reject(new DOMException("视频预处理已取消。", "AbortError")));

    for (const event of successEvents) video.addEventListener(event, onSuccess);
    video.addEventListener("error", onError);
    video.addEventListener("abort", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
) {
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(
      () => finish(() => reject(new NativeFrameExtractionError("关键帧编码超时。"))),
      timeoutMs,
    );
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException("视频预处理已取消。", "AbortError")));

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    canvas.toBlob(
      (blob) =>
        finish(() =>
          blob
            ? resolve(blob)
            : reject(new NativeFrameExtractionError("浏览器无法编码关键帧。")),
        ),
      "image/jpeg",
      quality,
    );
  });
}

function remainingTime(deadline: number, maximum: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new NativeFrameExtractionError("浏览器原生视频抽帧超时。");
  }
  return Math.max(1, Math.min(maximum, remaining));
}

function clampTimestamp(timestamp: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, timestamp);
  return Math.min(Math.max(0, timestamp), Math.max(0, duration - 0.05));
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("视频预处理已取消。", "AbortError");
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}
