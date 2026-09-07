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
  | "analyzing"
  | "ready";

export interface BilibiliJobSource {
  bvid: string;
  title?: string;
  durationSeconds?: number;
  description?: string;
}

export type BilibiliDownloadVariant = "analysis";

export const BILIBILI_ANALYSIS_DOWNLOAD_VARIANT: BilibiliDownloadVariant = "analysis";

export interface BilibiliArtifact {
  playbackUrl: string;
  downloadUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
  width?: number;
  height?: number;
}

export interface BilibiliPreviewResponse {
  playbackUrl: string;
  audioPlaybackUrl?: string;
  bvid: string;
  title: string;
  description?: string;
  durationSeconds: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  filename: string;
}

export interface BilibiliAnalysisFrame {
  url: string;
  timestampSeconds: number;
  score: number;
  sizeBytes: number;
}

export interface TranscriptionAudioChunk {
  url: string;
  mimeType: "audio/mpeg";
  sizeBytes: number;
  startSeconds: number;
  endSeconds: number;
}

export interface BilibiliAnalysis {
  mode: "direct" | "keyframes";
  audio?: {
    url: string;
    mimeType: string;
    sizeBytes: number;
  };
  transcriptionAudio: TranscriptionAudioChunk[];
  frames: BilibiliAnalysisFrame[];
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
  analysis?: BilibiliAnalysis;
  error?: BilibiliJobError;
}

export interface CreateBilibiliJobRequest {
  bvid: string;
  variant: BilibiliDownloadVariant;
  directSummaryMaxSeconds?: number;
}

export interface BilibiliApiErrorBody {
  error: BilibiliJobError;
}
