import {
  extractWebDocument,
  type ExtractedWebDocument,
} from "./web-content";
import { positiveInteger, runtimeValue } from "../../config/app-env";
import { planWebSearch } from "./web-search-planner";
import type {
  WebSearchEvidence,
  WebSearchPlanningContext,
  WebSearchSource,
} from "./web-search-types";
import type { ModelUsageSink } from "../../../shared/model-usage";
import type {
  ConversationWebSearchFailure,
  ConversationWebSource,
} from "../../../shared/conversation-types";
import type { WebContentCacheRepository } from "../../database/web-content-cache-repository";
import { rerankWebDocument } from "./qwen-rerank";

export type {
  WebSearchEvidence,
  WebSearchPlan,
  WebSearchPlanningContext,
  WebSearchSource,
} from "./web-search-types";

const DEFAULT_SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const ZHIPU_SEARCH_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/web_search";
const TARGET_READABLE_PAGES = 4;
const MAX_SEARCH_CANDIDATES = 12;
const DEFAULT_TIMEOUT_MS = 15_000;

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

interface ZhipuSearchResult {
  error?: unknown;
  message?: unknown;
  search_result?: Array<Record<string, unknown>>;
}

type WebSearchProvider = "serpapi" | "zhipu";

interface SearchCandidateResult {
  candidates: SearchCandidate[];
  failure?: ConversationWebSearchFailure;
}

interface WebSearchUsageHooks {
  onModelUsage?: ModelUsageSink;
  onSearchRequest?: () => void;
  contentCache?: WebContentCacheRepository;
}

export async function prepareWebSearch(
  context: WebSearchPlanningContext,
  signal?: AbortSignal,
  usageHooks: WebSearchUsageHooks = {},
): Promise<WebSearchEvidence> {
  const previousSources = referencedPreviousSources(
    context.question,
    context.previousSources ?? [],
  );
  let plan;
  if (previousSources.length) {
    plan = {
      decision: "search" as const,
      query: context.question.replace(/\s+/g, " ").trim().slice(0, 240),
      reason: "用户要求继续访问此前联网结果。",
      searchLanguage: context.locale,
    };
  } else {
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
        requestIssued: false,
        candidateCount: 0,
        extractionFailureCount: 0,
        failures: [
          {
            stage: "search",
            code: "SEARCH_PLANNING_FAILED",
            message: safeErrorMessage(error, "搜索规划模型暂时不可用。"),
          },
        ],
        note: "未能完成联网意图判断与关键词提取，本轮没有执行搜索。",
      };
    }
  }

  if (plan.decision !== "search" || !plan.query) {
    const status = plan.decision === "forbidden" ? "forbidden" : "skipped";
    return {
      status,
      plan,
      sources: [],
      visitedPageCount: 0,
      requestIssued: false,
      candidateCount: 0,
      extractionFailureCount: 0,
      failures: [],
      note:
        status === "forbidden"
          ? "搜索规划判断本轮不应访问公开网页。"
          : "当前问题不需要联网检索。",
    };
  }

  if (!runtimeValue("DASHSCOPE_API_KEY")) {
    return {
      status: "unavailable",
      plan,
      query: plan.query,
      sources: [],
      visitedPageCount: 0,
      requestIssued: false,
      candidateCount: 0,
      extractionFailureCount: 0,
      failures: [
        {
          stage: "filter",
          code: "QWEN_RERANK_NOT_CONFIGURED",
          message: "尚未配置千问 API Key。",
        },
      ],
      note: "尚未配置千问 API Key，无法对网页正文进行精排。",
    };
  }

  const provider = selectedSearchProvider();
  const providerLabel = provider === "zhipu" ? "智谱搜索" : "SerpAPI";
  let searchResult: SearchCandidateResult;
  if (previousSources.length) {
    searchResult = {
      candidates: previousSources.map((source) => ({
        title: source.title,
        url: source.url,
        snippet: "来自当前对话此前访问的网页。",
        sourceType: "organic",
      })),
    };
  } else {
    const apiKey = runtimeValue(
      provider === "zhipu" ? "ZHIPU_SEARCH_API_KEY" : "SERPAPI_API_KEY",
    );
    if (!apiKey) {
      return {
        status: "unavailable",
        plan,
        query: plan.query,
        sources: [],
        visitedPageCount: 0,
        requestIssued: false,
        candidateCount: 0,
        extractionFailureCount: 0,
        failures: [
          {
            stage: "search",
            code:
              provider === "zhipu"
                ? "ZHIPU_SEARCH_NOT_CONFIGURED"
                : "SERPAPI_NOT_CONFIGURED",
            message: `尚未配置${providerLabel} Key。`,
          },
        ],
        note: `尚未配置${providerLabel} Key，无法执行联网检索。`,
      };
    }
    usageHooks.onSearchRequest?.();
    searchResult =
      provider === "zhipu"
        ? await searchZhipu(plan.query, apiKey, signal)
        : await searchSerpApi(
            plan.query,
            plan.searchLanguage ?? context.locale,
            plan.countryCode ?? countryCodeFromRegion(context.region),
            apiKey,
            signal,
          );
  }
  const candidates = searchResult.candidates;
  if (!candidates.length) {
    const note = searchResult.failure?.message
      ? `搜索已执行，但未取得可读网页：${searchResult.failure.message}`
      : `搜索已执行，但${providerLabel}没有返回网页候选结果。`;
    return {
      status: "unavailable",
      plan,
      query: plan.query,
      sources: [],
      visitedPageCount: 0,
      requestIssued: true,
      candidateCount: 0,
      extractionFailureCount: 0,
      failures: searchResult.failure ? [searchResult.failure] : [],
      note,
    };
  }

  const sources: WebSearchSource[] = [];
  const failures: ConversationWebSearchFailure[] = [];
  let extractionFailureCount = 0;
  for (const candidate of candidates) {
    if (sources.length >= TARGET_READABLE_PAGES) break;
    let document = cachedDocument(usageHooks.contentCache, candidate.url);
    if (!document) {
      const extraction = await extractWebDocument(candidate.url, signal);
      if (!extraction.ok) {
        extractionFailureCount += 1;
        failures.push({
          stage: "extract",
          code: extraction.code,
          message: extraction.message,
          url: candidate.url,
        });
        continue;
      }
      document = extraction.document;
      usageHooks.contentCache?.put({
        originalUrl: document.url,
        finalUrl: document.finalUrl,
        title: document.title || candidate.title,
        ...(document.publishedAt ? { publishedAt: document.publishedAt } : {}),
        ...(document.contentType ? { contentType: document.contentType } : {}),
        text: document.text,
        method: document.method,
      });
    }
    let passages: string[];
    try {
      const reranked = await rerankWebDocument(
        `${plan.query} ${context.question}`,
        document.text,
        signal,
      );
      passages = reranked.passages;
      if (reranked.usage) usageHooks.onModelUsage?.(reranked.usage);
    } catch (error) {
      if (signal?.aborted) throw error;
      failures.push({
        stage: "filter",
        code: "QWEN_RERANK_FAILED",
        message: safeErrorMessage(error, "千问网页精排失败。"),
        url: candidate.url,
      });
      continue;
    }
    if (!passages.length) {
      failures.push({
        stage: "filter",
        code: "NO_RERANK_PASSAGES_ABOVE_THRESHOLD",
        message: "网页正文已读取，但没有分片达到精排阈值。",
        url: candidate.url,
      });
      continue;
    }
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
    requestIssued: true,
    candidateCount: candidates.length,
    extractionFailureCount,
    failures,
    ...(sources.length
      ? {}
      : {
          note: `搜索已执行并取得 ${candidates.length} 个候选结果，但未取得可读网页正文。${
            failures[0]?.message ? ` 首个失败原因：${failures[0].message}` : ""
          }`,
        }),
  };
}

async function searchZhipu(
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchCandidateResult> {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(ZHIPU_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        search_query: query.slice(0, 70),
        search_engine: "search_std",
        search_intent: false,
        count: MAX_SEARCH_CANDIDATES,
        search_recency_filter: "noLimit",
        content_size: "high",
      }),
      signal: requestSignal,
    });
    const body = (await response.json().catch(() => null)) as
      | ZhipuSearchResult
      | null;
    if (!response.ok) {
      return {
        candidates: [],
        failure: {
          stage: "search",
          code: `ZHIPU_SEARCH_HTTP_${response.status}`,
          message:
            stringField(body?.message) ||
            stringField(body?.error) ||
            `智谱搜索请求失败（HTTP ${response.status}）。`,
        },
      };
    }
    if (!body || !Array.isArray(body.search_result)) {
      return {
        candidates: [],
        failure: {
          stage: "search",
          code: "ZHIPU_SEARCH_INVALID_RESPONSE",
          message: "智谱搜索返回了无法解析的响应。",
        },
      };
    }
    return {
      candidates: collectZhipuCandidates(body.search_result).slice(
        0,
        MAX_SEARCH_CANDIDATES,
      ),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      candidates: [],
      failure: {
        stage: "search",
        code: "ZHIPU_SEARCH_REQUEST_FAILED",
        message: safeErrorMessage(error, "智谱搜索请求失败。"),
      },
    };
  }
}

async function searchSerpApi(
  query: string,
  locale: string,
  countryCode: string | undefined,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchCandidateResult> {
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
    if (!response.ok) {
      return {
        candidates: [],
        failure: {
          stage: "search",
          code: `SERPAPI_HTTP_${response.status}`,
          message:
            typeof body?.error === "string" && body.error.trim()
              ? body.error.trim().slice(0, 500)
              : `SerpAPI 请求失败（HTTP ${response.status}）。`,
        },
      };
    }
    if (!body || typeof body !== "object") {
      return {
        candidates: [],
        failure: {
          stage: "search",
          code: "SERPAPI_INVALID_RESPONSE",
          message: "SerpAPI 返回了无法解析的响应。",
        },
      };
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return {
        candidates: [],
        failure: {
          stage: "search",
          code: "SERPAPI_ERROR",
          message: body.error.trim().slice(0, 500),
        },
      };
    }
    return {
      candidates: collectCandidates(body).slice(0, MAX_SEARCH_CANDIDATES),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      candidates: [],
      failure: {
        stage: "search",
        code: "SERPAPI_REQUEST_FAILED",
        message: safeErrorMessage(error, "SerpAPI 请求失败。"),
      },
    };
  }
}

function safeErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : fallback;
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

function collectZhipuCandidates(results: Array<Record<string, unknown>>) {
  const candidates: SearchCandidate[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const url = publicHttpUrl(stringField(result.link));
    const title = stringField(result.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      title: title.slice(0, 240),
      url,
      snippet: (stringField(result.content) ?? "搜索结果没有提供摘要。").slice(
        0,
        800,
      ),
      ...(stringField(result.publish_date)
        ? { publishedAt: stringField(result.publish_date)?.slice(0, 80) }
        : {}),
      sourceType: "organic",
    });
  }
  return candidates;
}

function selectedSearchProvider(): WebSearchProvider {
  return runtimeValue("FRAMENOTE_WEB_SEARCH_PROVIDER") === "zhipu"
    ? "zhipu"
    : "serpapi";
}

function cachedDocument(
  cache: WebContentCacheRepository | undefined,
  url: string,
): ExtractedWebDocument | null {
  const cached = cache?.get(url);
  if (!cached) return null;
  return {
    url: cached.originalUrl,
    finalUrl: cached.finalUrl,
    ...(cached.title ? { title: cached.title } : {}),
    ...(cached.publishedAt ? { publishedAt: cached.publishedAt } : {}),
    ...(cached.contentType ? { contentType: cached.contentType } : {}),
    text: cached.text,
    method: cached.method,
  };
}

function referencedPreviousSources(
  question: string,
  sources: ConversationWebSource[],
) {
  const unique = sources.filter(
    (source, index) =>
      sources.findIndex((candidate) => candidate.url === source.url) === index,
  );
  const normalizedQuestion = question.toLocaleLowerCase().replace(/\s+/g, "");
  const explicitUrls = (question.match(/https?:\/\/[^\s<>"']+/gi) ?? [])
    .map((url) => publicHttpUrl(url.replace(/[),，。；;]+$/, "")))
    .filter((url): url is string => Boolean(url));
  const urlMatches = explicitUrls.map((url, index) => {
    const existing = unique.find((source) => source.url === url);
    return existing ?? { index: index + 1, title: url, url };
  });
  if (urlMatches.length) return urlMatches;
  if (!unique.length) return [];

  const ordinalMatch = normalizedQuestion.match(
    /第?(1[0-2]|[1-9]|一|二|三|四|五|六|七|八|九|十|十一|十二)(?:个|条|篇)?(?:网页|来源|链接|结果)/,
  );
  if (ordinalMatch) {
    const index = ordinalNumber(ordinalMatch[1]);
    const matched = unique.find((source) => source.index === index);
    return matched ? [matched] : [];
  }

  const titleMatches = unique.filter((source) => {
    const title = source.title.toLocaleLowerCase().replace(/\s+/g, "");
    return title.length >= 4 && normalizedQuestion.includes(title);
  });
  if (titleMatches.length) return titleMatches;

  return /(?:之前|此前|刚才|上次|前面).{0,12}(?:网页|来源|链接|搜索结果|资料)|(?:这个|这些|该)(?:网页|来源|链接)/.test(normalizedQuestion)
    ? unique
    : [];
}

export function referencesPreviousWebSource(
  question: string,
  sources: ConversationWebSource[] = [],
) {
  return referencedPreviousSources(question, sources).length > 0;
}

function ordinalNumber(value: string) {
  const numeric = Number(value);
  if (Number.isSafeInteger(numeric)) return numeric;
  return (
    {
      一: 1,
      二: 2,
      三: 3,
      四: 4,
      五: 5,
      六: 6,
      七: 7,
      八: 8,
      九: 9,
      十: 10,
      十一: 11,
      十二: 12,
    } as Record<string, number>
  )[value];
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
