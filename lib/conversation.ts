import type {
  SourceKind,
  VideoTranscript,
  VideoSourceDescriptor,
  VideoSummary,
} from "./video-engine";

export interface ConversationMessage {
  id: string;
  role: "assistant" | "user";
  content: string;
  createdAt: number;
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
  messages: Array<Pick<ConversationMessage, "role" | "content">>;
  activeModel?: string | null;
  transcript?: VideoTranscript;
}
