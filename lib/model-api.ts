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
  reasoningMode?: "flash" | "pro";
  webSearchEnabled?: boolean;
}

export interface AnalyzeVideoResponse {
  provider: "qwen";
  model: string;
  summary: VideoSummary;
}

export interface AskVideoResponse {
  provider: "deepseek";
  model: string;
  answer: string;
  webSearchUsed?: boolean;
}

export interface ModelApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
