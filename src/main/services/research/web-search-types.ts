import type {
  VideoConversationMessage,
  VideoSourceDescriptor,
  VideoSummary,
} from "../../../shared/media-types";
import type {
  ConversationWebSource,
  ConversationWebSearchFailure,
  ConversationWebSearchStatus,
} from "../../../shared/conversation-types";

export type WebSearchDecision = "search" | "skip" | "forbidden";

export interface WebSearchPlan {
  decision: WebSearchDecision;
  query?: string;
  reason: string;
  searchLanguage?: string;
  countryCode?: string;
}

export interface WebSearchPlanningContext {
  question: string;
  source: VideoSourceDescriptor;
  summary: VideoSummary;
  history?: VideoConversationMessage[];
  locale: string;
  region: string;
  timeZone: string;
  currentDate: string;
  routeReason?: string;
  missingFacts?: string[];
  forceSearch?: boolean;
  previousSources?: ConversationWebSource[];
}

export interface WebSearchSource {
  index: number;
  title: string;
  url: string;
  snippet: string;
  passages: string[];
  publishedAt?: string;
  reliability: "high" | "medium" | "unverified";
  sourceType: "organic" | "news" | "local";
  extractionMethod: "trafilatura" | "pypdf" | "browser-run";
}

export interface WebSearchEvidence {
  status: ConversationWebSearchStatus;
  plan: WebSearchPlan;
  query?: string;
  sources: WebSearchSource[];
  visitedPageCount: number;
  requestIssued: boolean;
  candidateCount: number;
  extractionFailureCount: number;
  failures: ConversationWebSearchFailure[];
  note?: string;
}
