import type {
  VideoConversationMessage,
  VideoSourceDescriptor,
  VideoSummary,
} from "../video-engine";

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
  transcript?: string;
  history?: VideoConversationMessage[];
  locale: string;
  region: string;
  timeZone: string;
  transcriptLanguage?: string;
  currentDate: string;
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
  status: "searched" | "skipped" | "forbidden" | "unavailable";
  plan: WebSearchPlan;
  query?: string;
  sources: WebSearchSource[];
  visitedPageCount: number;
  note?: string;
}
