import type { VideoModelContext } from "../video-engine";

export const LOCAL_VIDEO_PREPROCESSING_LIMITS = {
  maxSourceBytes: 300 * 1024 * 1024,
  maxDurationSeconds: 60 * 60,
  maxKeyframes: 24,
  minKeyframes: 3,
  targetFrameIntervalSeconds: 12,
  frameWidth: 960,
  jpegQuality: 6,
  targetAudioBytes: 6 * 1024 * 1024,
  targetFrameBytes: 3 * 1024 * 1024,
} as const;

const FFMPEG_CORE_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
const AUDIO_BITRATES_KBPS = [64, 48, 40, 32, 24, 16, 8] as const;

export type VideoPreprocessingStage =
  | "loading-engine"
  | "extracting-audio"
  | "extracting-frames";

export interface VideoPreprocessingProgress {
  stage: VideoPreprocessingStage;
  progress: number;
}

export interface VideoPreprocessingResult {
  context: VideoModelContext;
  audioBytes: number;
  frameBytes: number;
  frameCount: number;
  audioBitrateKbps?: number;
}

export interface VideoPreprocessingOptions {
  durationSeconds: number;
  signal?: AbortSignal;
  onProgress?: (progress: VideoPreprocessingProgress) => void;
}

export class VideoPreprocessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoPreprocessingError";
  }
}

export async function extractVideoEvidence(
  file: File,
  options: VideoPreprocessingOptions,
): Promise<VideoPreprocessingResult> {
  validateInput(file, options.durationSeconds);
  throwIfAborted(options.signal);

  options.onProgress?.({ stage: "loading-engine", progress: 0 });
  const [{ FFmpeg, FFFSType }, { toBlobURL }] = await Promise.all([
    import("@ffmpeg/ffmpeg"),
    import("@ffmpeg/util"),
  ]);
  const ffmpeg = new FFmpeg();
  let activeStage: VideoPreprocessingStage = "loading-engine";
  const progressListener = ({ progress }: { progress: number }) => {
    options.onProgress?.({
      stage: activeStage,
      progress: clamp(progress, 0, 1),
    });
  };
  ffmpeg.on("progress", progressListener);

  try {
    await ffmpeg.load(
      {
        coreURL: await toBlobURL(
          `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`,
          "text/javascript",
        ),
        wasmURL: await toBlobURL(
          `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`,
          "application/wasm",
        ),
      },
      { signal: options.signal },
    );
    throwIfAborted(options.signal);
    options.onProgress?.({ stage: "loading-engine", progress: 1 });

    await ffmpeg.createDir("/source", { signal: options.signal });
    await ffmpeg.mount(
      FFFSType.WORKERFS,
      { files: [file] },
      "/source",
    );
    const inputPath = `/source/${file.name}`;

    activeStage = "extracting-audio";
    options.onProgress?.({ stage: activeStage, progress: 0 });
    const audioBitrateKbps = selectAudioBitrate(options.durationSeconds);
    const audioExitCode = await ffmpeg.exec(
      [
        "-i",
        inputPath,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        `${audioBitrateKbps}k`,
        "audio.mp3",
      ],
      -1,
      { signal: options.signal },
    );
    const audioData = audioExitCode === 0
      ? await readBinaryFile(ffmpeg, "audio.mp3", options.signal)
      : undefined;
    options.onProgress?.({ stage: activeStage, progress: 1 });

    activeStage = "extracting-frames";
    options.onProgress?.({ stage: activeStage, progress: 0 });
    const framePlan = createFramePlan(options.durationSeconds);
    const frameExitCode = await ffmpeg.exec(
      [
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        "-vf",
        `fps=1/${framePlan.intervalSeconds.toFixed(3)},scale=${LOCAL_VIDEO_PREPROCESSING_LIMITS.frameWidth}:-2`,
        "-frames:v",
        String(framePlan.count),
        "-q:v",
        String(LOCAL_VIDEO_PREPROCESSING_LIMITS.jpegQuality),
        "frame-%03d.jpg",
      ],
      -1,
      { signal: options.signal },
    );
    if (frameExitCode !== 0) {
      throw new VideoPreprocessingError("无法从该视频中提取关键帧，请检查视频编码格式。");
    }

    const frameNames = (await ffmpeg.listDir("/", { signal: options.signal }))
      .filter((entry) => !entry.isDir && /^frame-\d+\.jpg$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const frames = await Promise.all(
      frameNames.map((name) => readBinaryFile(ffmpeg, name, options.signal)),
    );
    const selectedFrames = selectFramesWithinBudget(
      frames,
      LOCAL_VIDEO_PREPROCESSING_LIMITS.targetFrameBytes,
    );
    if (selectedFrames.length === 0) {
      throw new VideoPreprocessingError("视频没有可用画面，无法生成关键帧。");
    }
    options.onProgress?.({ stage: activeStage, progress: 1 });

    const frameUrls = await Promise.all(
      selectedFrames.map((frame) => bytesToDataUrl(frame.data, "image/jpeg")),
    );
    const audioUrl = audioData
      ? await bytesToDataUrl(audioData, "audio/mpeg")
      : undefined;
    const frameTimestamps = selectedFrames.map((frame) =>
      Math.min(
        options.durationSeconds,
        frame.sourceIndex * framePlan.intervalSeconds,
      ),
    );
    const frameBytes = selectedFrames.reduce(
      (total, frame) => total + frame.data.byteLength,
      0,
    );

    return {
      context: {
        frameUrls,
        frameTimestamps,
        ...(audioUrl ? { audioUrl, audioFormat: "mp3" as const } : {}),
      },
      audioBytes: audioData?.byteLength ?? 0,
      frameBytes,
      frameCount: frameUrls.length,
      ...(audioData ? { audioBitrateKbps } : {}),
    };
  } catch (error) {
    if (isAbortError(error) || options.signal?.aborted) {
      throw new DOMException("视频预处理已取消。", "AbortError");
    }
    if (error instanceof VideoPreprocessingError) throw error;
    throw new VideoPreprocessingError(
      error instanceof Error
        ? `本地视频预处理失败：${error.message}`
        : "本地视频预处理失败。",
    );
  } finally {
    ffmpeg.off("progress", progressListener);
    ffmpeg.terminate();
  }
}

function validateInput(file: File, durationSeconds: number) {
  if (file.size > LOCAL_VIDEO_PREPROCESSING_LIMITS.maxSourceBytes) {
    throw new VideoPreprocessingError(
      `浏览器本地处理暂时支持不超过 ${Math.round(
        LOCAL_VIDEO_PREPROCESSING_LIMITS.maxSourceBytes / 1024 / 1024,
      )} MB 的视频。`,
    );
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new VideoPreprocessingError("尚未读取到视频时长，请稍后重试。");
  }
  if (durationSeconds > LOCAL_VIDEO_PREPROCESSING_LIMITS.maxDurationSeconds) {
    throw new VideoPreprocessingError(
      `浏览器本地处理暂时支持不超过 ${Math.round(
        LOCAL_VIDEO_PREPROCESSING_LIMITS.maxDurationSeconds / 60,
      )} 分钟的视频。`,
    );
  }
}

function selectAudioBitrate(durationSeconds: number) {
  const targetKbps = Math.floor(
    (LOCAL_VIDEO_PREPROCESSING_LIMITS.targetAudioBytes * 8) /
      durationSeconds /
      1000,
  );
  return AUDIO_BITRATES_KBPS.find((bitrate) => bitrate <= targetKbps) ?? 8;
}

function createFramePlan(durationSeconds: number) {
  const count = clamp(
    Math.ceil(
      durationSeconds /
        LOCAL_VIDEO_PREPROCESSING_LIMITS.targetFrameIntervalSeconds,
    ),
    LOCAL_VIDEO_PREPROCESSING_LIMITS.minKeyframes,
    LOCAL_VIDEO_PREPROCESSING_LIMITS.maxKeyframes,
  );
  return {
    count,
    intervalSeconds: Math.max(0.25, durationSeconds / count),
  };
}

function selectFramesWithinBudget(frames: Uint8Array[], budget: number) {
  const indexed = frames.map((data, sourceIndex) => ({ data, sourceIndex }));
  const totalBytes = indexed.reduce((total, frame) => total + frame.data.byteLength, 0);
  if (totalBytes <= budget) return indexed;

  const estimatedCount = Math.max(
    1,
    Math.floor((frames.length * budget) / totalBytes),
  );
  const targetCount = Math.min(frames.length, estimatedCount);
  if (targetCount === 1) return [indexed[Math.floor(indexed.length / 2)]];

  return Array.from({ length: targetCount }, (_, index) => {
    const sourceIndex = Math.round(
      (index * (indexed.length - 1)) / (targetCount - 1),
    );
    return indexed[sourceIndex];
  });
}

async function readBinaryFile(
  ffmpeg: { readFile: (path: string, encoding?: string, options?: { signal?: AbortSignal }) => Promise<Uint8Array | string> },
  path: string,
  signal?: AbortSignal,
) {
  const data = await ffmpeg.readFile(path, undefined, { signal });
  if (typeof data === "string") {
    throw new VideoPreprocessingError(`无法读取处理产物：${path}`);
  }
  return data;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  return new Promise<string>((resolve, reject) => {
    const copy = Uint8Array.from(bytes);
    const reader = new FileReader();
    reader.onerror = () => reject(new VideoPreprocessingError("编码模型输入失败。"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new VideoPreprocessingError("编码模型输入失败。"));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(new Blob([copy.buffer], { type: mimeType }));
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("视频预处理已取消。", "AbortError");
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}
