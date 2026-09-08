import type { VideoSourceDescriptor } from "@/shared/media-types";
import { prepareBilibiliVideoPreview } from "./bilibili-client";
import { prepareDouyinVideoPreview } from "./douyin-client";

export interface PlatformVideoPreview {
  kind: "bilibili" | "douyin";
  playbackUrl: string;
  audioPlaybackUrl?: string;
  filename: string;
  title: string;
  description?: string;
  durationSeconds: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  sourceUrl: string;
  sourceLabel: string;
  platformId: string;
}

interface PlatformVideoPreviewOptions {
  signal?: AbortSignal;
  onProgress?: (progress: {
    stage: "preparing" | "downloading";
    progress: number;
  }) => void;
}

export async function preparePlatformVideoPreview(
  source: VideoSourceDescriptor,
  options: PlatformVideoPreviewOptions = {},
): Promise<PlatformVideoPreview> {
  if (source.kind === "bilibili") {
    if (!source.bvid) throw new Error("没有可获取的 BV 号。");
    const preview = await prepareBilibiliVideoPreview(source.bvid, options);
    return {
      kind: "bilibili",
      playbackUrl: preview.playbackUrl,
      audioPlaybackUrl: preview.audioPlaybackUrl,
      filename: preview.filename || "bilibili-video.mp4",
      title: preview.title,
      description: preview.description,
      durationSeconds: preview.durationSeconds,
      sizeBytes: preview.sizeBytes,
      width: preview.width,
      height: preview.height,
      sourceUrl: source.sourceUrl ?? `https://www.bilibili.com/video/${preview.bvid}`,
      sourceLabel: preview.bvid,
      platformId: preview.bvid,
    };
  }

  if (source.kind === "douyin") {
    if (!source.sourceUrl) throw new Error("没有可获取的抖音分享链接。");
    const preview = await prepareDouyinVideoPreview(source.sourceUrl, options);
    return {
      kind: "douyin",
      playbackUrl: preview.playbackUrl,
      filename: preview.filename || "douyin-video.mp4",
      title: preview.title,
      description: preview.description,
      durationSeconds: preview.durationSeconds,
      sizeBytes: preview.sizeBytes,
      width: preview.width,
      height: preview.height,
      sourceUrl: preview.sourceUrl,
      sourceLabel: "抖音",
      platformId: preview.videoId,
    };
  }

  throw new Error("当前来源不是受支持的在线视频平台。");
}
