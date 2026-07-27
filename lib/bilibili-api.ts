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

export type BilibiliDownloadVariant = "preview" | "analysis";

export const DEFAULT_BILIBILI_DOWNLOAD_VARIANT: BilibiliDownloadVariant = "preview";
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

export interface BilibiliAnalysisFrame {
  url: string;
  timestampSeconds: number;
  score: number;
  sizeBytes: number;
}

export interface BilibiliTranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface BilibiliTranscript {
  status: "pending" | "ready" | "unavailable";
  text: string;
  cues: BilibiliTranscriptCue[];
  language?: string;
  error?: string;
}

export interface BilibiliAnalysis {
  mode: "direct" | "keyframes";
  audio?: {
    url: string;
    mimeType: string;
    sizeBytes: number;
  };
  frames: BilibiliAnalysisFrame[];
  transcript: BilibiliTranscript;
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
