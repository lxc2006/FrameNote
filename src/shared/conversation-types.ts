import type {
  SourceKind,
  VideoTranscript,
  VideoSourceDescriptor,
  VideoSummary,
} from "./media-types";
import type { ConversationUsageRecord } from "./model-usage";

export interface ConversationMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  createdAt: number;
  reasoningContent?: string;
  reasoningDurationSeconds?: number;
  webSources?: ConversationWebSource[];
  webSearch?: ConversationWebSearchMetadata;
  stopped?: boolean;
  usage?: ConversationUsageRecord;
}

export interface ConversationWebSource {
  index: number;
  title: string;
  url: string;
}

export type ConversationWebSearchStatus =
  | "searched"
  | "skipped"
  | "forbidden"
  | "unavailable";

export interface ConversationWebSearchFailure {
  stage: "search" | "extract" | "filter";
  code: string;
  message: string;
  url?: string;
}

export interface ConversationWebSearchMetadata {
  status: ConversationWebSearchStatus;
  query?: string;
  note?: string;
  requestIssued: boolean;
  candidateCount: number;
  sourceCount: number;
  extractionFailureCount: number;
  failures: ConversationWebSearchFailure[];
}

export interface ConversationListItem {
  id: string;
  title: string;
  sourceKind: SourceKind;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationDetail extends ConversationListItem {
  source: VideoSourceDescriptor;
  summary: VideoSummary;
  messages: ConversationMessage[];
  activeModel: string | null;
  transcript?: VideoTranscript;
}

export interface CreateConversationInput {
  source: VideoSourceDescriptor;
  summary: VideoSummary;
  messages: ConversationMessageInput[];
  activeModel?: string | null;
  transcript?: VideoTranscript;
}

export type ConversationMessageInput = Pick<
  ConversationMessage,
  | "role"
  | "content"
  | "reasoningContent"
  | "reasoningDurationSeconds"
  | "webSources"
  | "webSearch"
  | "stopped"
  | "usage"
>;
