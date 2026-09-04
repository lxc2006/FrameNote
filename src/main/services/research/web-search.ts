import { extractWebDocument } from "./web-content";
import { positiveInteger, runtimeValue } from "../../config/app-env";
import { planWebSearch } from "./web-search-planner";
import type {
  WebSearchEvidence,
  WebSearchPlanningContext,
  WebSearchSource,
} from "./web-search-types";
import type { ModelUsageSink } from "../../../shared/model-usage";

export type {
  WebSearchEvidence,
  WebSearchPlan,
  WebSearchPlanningContext,
  WebSearchSource,
} from "./web-search-types";

const DEFAULT_SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const TARGET_READABLE_PAGES = 4;
const MAX_SEARCH_CANDIDATES = 12;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_PASSAGES_PER_SOURCE = 4;
const MAX_PASSAGE_CHARACTERS = 1_600;

interface SearchCandidate {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  sourceType: WebSearchSource["sourceType"];
}

interface SerpApiResult {
  error?: unknown;
  organic_results?: Array<Record<string, unknown>>;
  news_results?: Array<Record<string, unknown>>;
  local_results?: {
    places?: Array<Record<string, unknown>>;
  };
}

interface WebSearchUsageHooks {
  onModelUsage?: ModelUsageSink;
  onSearchRequest?: () => void;
}

export async function prepareWebSearch(
  context: WebSearchPlanningContext,
  signal?: AbortSignal,
  usageHooks: WebSearchUsageHooks = {},
): Promise<WebSearchEvidence> {
  let plan;
  try {
    plan = await planWebSearch(
      context,
      signal,
      undefined,
      usageHooks.onModelUsage,
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      status: "unavailable",
      plan: {
        decision: "skip",
        reason: "搜索规划模型暂时不可用。",
      },
      sources: [],
      visitedPageCount: 0,
      note: "未能完成联网意图判断与关键词提取，本轮没有执行搜索。",
    };
  }

  if (plan.decision !== "search" || !plan.query) {
    const status = plan.decision === "forbidden" ? "forbidden" : "skipped";
    return {
      status,
      plan,
      sources: [],
      visitedPageCount: 0,
      note:
        status === "forbidden"
          ? "搜索规划判断本轮不应访问公开网页。"
          : "当前问题不需要联网检索。",
    };
  }

  const apiKey = runtimeValue("SERPAPI_API_KEY");
  if (!apiKey) {
    return {
      status: "unavailable",
      plan,
      query: plan.query,
      sources: [],
      visitedPageCount: 0,
      note: "尚未配置 SERPAPI_API_KEY，无法执行联网检索。",
    };
  }

  usageHooks.onSearchRequest?.();
  const candidates = await searchSerpApi(
    plan.query,
    plan.searchLanguage ?? context.locale,
    plan.countryCode ?? countryCodeFromRegion(context.region),
    apiKey,
    signal,
  );
  if (!candidates.length) {
    return {
      status: "unavailable",
      plan,
      query: plan.query,
      sources: [],
      visitedPageCount: 0,
      note: "SerpAPI 没有返回可读取的网页结果。",
    };
  }

  const sources: WebSearchSource[] = [];
  for (const candidate of candidates) {
    if (sources.length >= TARGET_READABLE_PAGES) break;
    const document = await extractWebDocument(candidate.url, signal);
    if (!document) continue;
    const passages = selectRelevantPassages(
      document.text,
      `${plan.query} ${context.question}`,
    );
    if (!passages.length) continue;
    const finalUrl = document.finalUrl;
    sources.push({
      index: sources.length + 1,
      title: (document.title || candidate.title).slice(0, 240),
      url: finalUrl,
      snippet: candidate.snippet.slice(0, 800),
      passages,
      ...(document.publishedAt || candidate.publishedAt
        ? {
            publishedAt: (
              document.publishedAt || candidate.publishedAt
            )?.slice(0, 80),
          }
        : {}),
      reliability: sourceReliability(finalUrl),
      sourceType: candidate.sourceType,
      extractionMethod: document.method,
    });
  }

  return {
    status: sources.length > 0 ? "searched" : "unavailable",
    plan,
    query: plan.query,
    sources,
    visitedPageCount: sources.length,
    ...(sources.length
      ? {}
      : {
          note:
            "搜索结果均无法读取：可能需要登录、触发了反爬验证，或没有可提取正文。",
        }),
  };
}

async function searchSerpApi(
  query: string,
  locale: string,
  countryCode: string | undefined,
  apiKey: string,
  signal?: AbortSignal,
) {
  const endpoint = serpApiEndpoint();
  endpoint.searchParams.set("engine", "google");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("output", "json");
  endpoint.searchParams.set("safe", "active");
  endpoint.searchParams.set("hl", normalizeGoogleLanguage(locale));
  if (countryCode) endpoint.searchParams.set("gl", countryCode);
  endpoint.searchParams.set("num", String(MAX_SEARCH_CANDIDATES));

  const timeoutSignal = AbortSignal.timeout(
    positiveInteger(
      runtimeValue("SERPAPI_REQUEST_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
  );
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(endpoint, {
      headers: { accept: "application/json" },
      signal: requestSignal,
    });
    const body = (await response.json().catch(() => null)) as
      | SerpApiResult
      | null;
    if (!response.ok || !body || typeof body !== "object") return [];
    if (typeof body.error === "string" && body.error.trim()) return [];
    return collectCandidates(body).slice(0, MAX_SEARCH_CANDIDATES);
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}

function serpApiEndpoint() {
  const configured = runtimeValue("SERPAPI_ENDPOINT");
  if (!configured) return new URL(DEFAULT_SERPAPI_ENDPOINT);
  try {
    const url = new URL(configured);
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    if (url.protocol !== "https:" && !localHttp) {
      return new URL(DEFAULT_SERPAPI_ENDPOINT);
    }
    return url;
  } catch {
    return new URL(DEFAULT_SERPAPI_ENDPOINT);
  }
}

function collectCandidates(body: SerpApiResult) {
  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();
  const add = (
    item: Record<string, unknown>,
    sourceType: SearchCandidate["sourceType"],
  ) => {
    const url = publicHttpUrl(stringField(item.link) || stringField(item.website));
    const title =
      stringField(item.title) ||
      stringField(item.name) ||
      stringField(item.source);
    if (!url || !title || seen.has(url)) return;
    seen.add(url);
    const snippet =
      stringField(item.snippet) ||
      stringField(item.description) ||
      stringField(item.address) ||
      "搜索结果没有提供摘要。";
    candidates.push({
      title: title.slice(0, 240),
      url,
      snippet: snippet.slice(0, 800),
      ...(stringField(item.date)
        ? { publishedAt: stringField(item.date)?.slice(0, 80) }
        : {}),
      sourceType,
    });
  };

  for (const result of body.organic_results ?? []) add(result, "organic");
  for (const result of body.news_results ?? []) add(result, "news");
  for (const result of body.local_results?.places ?? []) add(result, "local");
  return candidates;
}

export function selectRelevantPassages(text: string, query: string) {
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n{2,}|\n(?=(?:[-*•]|\d+[.)、])\s+)/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter((paragraph) => paragraph.length >= 60)
    .slice(0, 500);
  if (!paragraphs.length) return [];

  const terms = searchTerms(query);
  const ranked = paragraphs
    .map((paragraph, order) => {
      const normalized = paragraph.toLocaleLowerCase();
      const overlap = terms.reduce(
        (score, term) => score + (normalized.includes(term) ? 1 : 0),
        0,
      );
      const lengthScore = Math.min(paragraph.length, 800) / 800;
      const earlyScore = 1 / (order + 4);
      return {
        paragraph,
        order,
        score: overlap * 3 + lengthScore + earlyScore,
      };
    })
    .sort((left, right) => right.score - left.score || left.order - right.order);

  const selected: string[] = [];
  for (const item of ranked) {
    if (
      selected.some(
        (existing) =>
          existing.includes(item.paragraph.slice(0, 80)) ||
          item.paragraph.includes(existing.slice(0, 80)),
      )
    ) {
      continue;
    }
    selected.push(item.paragraph.slice(0, MAX_PASSAGE_CHARACTERS));
    if (selected.length >= MAX_PASSAGES_PER_SOURCE) break;
  }
  return selected;
}

function searchTerms(value: string) {
  const normalized = value.toLocaleLowerCase();
  const terms = new Set(
    normalized
      .match(/[a-z0-9][a-z0-9._-]{1,}|[\p{Script=Han}]{2,}/gu)
      ?.map((term) => term.trim())
      .filter(Boolean) ?? [],
  );
  for (const run of normalized.match(/[\p{Script=Han}]{3,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1 && terms.size < 80; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return [...terms].slice(0, 80);
}

function normalizeGoogleLanguage(value: string) {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("zh")) return "zh-cn";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("en")) return "en";
  return normalized.match(/^[a-z]{2,3}/)?.[0] ?? "zh-cn";
}

function countryCodeFromRegion(value: string) {
  const normalized = value.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(normalized)) return normalized;
  if (/china|中国|beijing|shanghai|chongqing|guangdong/.test(normalized)) {
    return "cn";
  }
  return undefined;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function publicHttpUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      isPrivateHostname(url.hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized === "::1"
  ) {
    return true;
  }
  if (/^(?:127|10)\./.test(normalized) || /^192\.168\./.test(normalized)) {
    return true;
  }
  const private172 = normalized.match(/^172\.(\d{1,3})\./);
  if (private172) {
    const second = Number(private172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return normalized === "0.0.0.0";
}

function sourceReliability(urlValue: string): WebSearchSource["reliability"] {
  const hostname = new URL(urlValue).hostname.toLowerCase();
  if (
    /(?:^|\.)(?:gov|edu)(?:\.[a-z]{2,})?$/.test(hostname) ||
    /(?:^|\.)(?:who\.int|un\.org|worldbank\.org|oecd\.org)$/.test(hostname)
  ) {
    return "high";
  }
  if (
    /(?:^|\.)(?:wikipedia\.org|reuters\.com|apnews\.com|bbc\.com|nature\.com|science\.org)$/.test(
      hostname,
    )
  ) {
    return "medium";
  }
  return "unverified";
}
