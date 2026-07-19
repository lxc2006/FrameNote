export type BilibiliJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export type BilibiliJobPhase =
  | "queued"
  | "resolving"
  | "downloading"
  | "merging"
  | "ready";

export interface BilibiliJobSource {
  bvid: string;
  title?: string;
  durationSeconds?: number;
}

export type BilibiliVideoQuality = 720 | 1080;

export const BILIBILI_VIDEO_QUALITIES = [720, 1080] as const;

export const DEFAULT_BILIBILI_VIDEO_QUALITY: BilibiliVideoQuality = 720;

export interface BilibiliArtifact {
  downloadUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
  height?: number;
}

export interface BilibiliJobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface BilibiliJobSnapshot {
  jobId: string;
  status: BilibiliJobStatus;
  phase: BilibiliJobPhase;
  progress: number;
  source: BilibiliJobSource;
  artifact?: BilibiliArtifact;
  error?: BilibiliJobError;
}

export interface CreateBilibiliJobRequest {
  bvid: string;
  maxHeight: BilibiliVideoQuality;
}

export interface BilibiliApiErrorBody {
  error: BilibiliJobError;
}
