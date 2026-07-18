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

export interface BilibiliArtifact {
  downloadUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string;
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
}

export interface BilibiliApiErrorBody {
  error: BilibiliJobError;
}
