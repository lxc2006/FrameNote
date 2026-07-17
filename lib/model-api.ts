import type {
  VideoConversationMessage,
  VideoModelContext,
  VideoSourceDescriptor,
  VideoSummary,
} from "./video-engine";

export interface AnalyzeVideoRequest {
  source: VideoSourceDescriptor;
  context: VideoModelContext;
}

export interface AskVideoRequest {
  question: string;
  source: VideoSourceDescriptor;
  summary: VideoSummary;
  context?: VideoModelContext;
  history?: VideoConversationMessage[];
}

export interface ModelStatusResponse {
  provider: "qwen";
  configured: boolean;
  model: string;
  acceptedInputs: Array<"video_url" | "frames" | "transcript">;
}

export interface AnalyzeVideoResponse {
  provider: "qwen";
  model: string;
  summary: VideoSummary;
}

export interface AskVideoResponse {
  provider: "qwen";
  model: string;
  answer: string;
}

export interface ModelApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    rawResponse?: string;
  };
}
