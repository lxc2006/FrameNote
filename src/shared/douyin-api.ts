export interface DouyinPreviewResponse {
  playbackUrl: string;
  sourceUrl: string;
  videoId: string;
  title: string;
  description?: string;
  durationSeconds: number;
  sizeBytes: number;
  width?: number;
  height?: number;
  filename: string;
}

export interface DouyinApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
