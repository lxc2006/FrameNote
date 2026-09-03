import type {
  VideoConversationMessage,
  VideoModelContext,
  VideoSourceDescriptor,
  VideoSummary,
} from "./video-engine";
import type { ConversationWebSource } from "./conversation";
import type { ConversationUsageRecord } from "./model-usage";

export interface AnalyzeVideoRequest {
  source: VideoSourceDescriptor;
  context: VideoModelContext;
}

export interface AskVideoRequest {
  question: string;
  /**
   * 已保存对话优先只传 id；服务端会校验归属并从 D1 读取视频记忆、
   * 冷存档字幕和历史消息。
   */
  conversationId?: string;
  /** 未能保存对话时使用的降级内联上下文。 */
  source?: VideoSourceDescriptor;
  /** 未能保存对话时使用的降级内联上下文。 */
  summary?: VideoSummary;
  context?: VideoModelContext;
  history?: VideoConversationMessage[];
  reasoningMode?: "flash" | "pro";
  webSearchEnabled?: boolean;
  fullRecallEnabled?: boolean;
  searchContext?: {
    locale?: string;
    timeZone?: string;
  };
}

export interface AnalyzeVideoResponse {
  provider: "qwen";
  model: string;
  summary: VideoSummary;
  usage: ConversationUsageRecord;
}

export interface AskVideoResponse {
  provider: "deepseek";
  model: string;
  answer: string;
  reasoningContent?: string;
  reasoningDurationSeconds?: number;
  webSources?: ConversationWebSource[];
  webSearchUsed?: boolean;
  visitedPageCount?: number;
  usage: ConversationUsageRecord;
}

export type AskVideoStreamPhase =
  | "assess"
  | "recall"
  | "reassess"
  | "search"
  | "answer";

export type AskVideoStreamEvent =
  | {
      type: "phase";
      phase: AskVideoStreamPhase;
      label: string;
    }
  | {
      type: "reasoning_delta";
      delta: string;
    }
  | {
      type: "answer_delta";
      delta: string;
    }
  | ({
      type: "done";
    } & AskVideoResponse)
  | {
      type: "error";
      error: ModelApiErrorBody["error"];
    };

export interface ModelApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
