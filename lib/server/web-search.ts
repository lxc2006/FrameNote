import type { VideoSourceDescriptor } from "../video-engine";
import { positiveInteger, runtimeValue } from "./runtime-env";

const SERPAPI_ENDPOINT = "https://serpapi.com/search.json";
const MAX_SEARCH_RESULTS = 8;
const MAX_QUERY_CHARACTERS = 240;
const DEFAULT_TIMEOUT_MS = 15_000;

const SEARCH_INTENT_PATTERN =
  /(?:联网|上网|搜索|搜一下|查一下|查证|核实|事实核查|来源|出处|是真的吗|是否属实|对不对|可靠吗|可信(?:吗|么)?|准确吗|有没有依据|最新|最近|今日|今天|刚刚|目前|现在|实时|新闻|价格|多少钱|汇率|天气|比分|赛程|政策|法规|版本|更新|发布|附近|周边|当地|本地|营业时间|地址|电话|官网|现任|(?:总统|总理|主席|首相|CEO|负责人|冠军|排名|票房|市值|股价).{0,12}(?:是谁|多少|排名|情况)|current|latest|today|news|search|verify|fact[\s-]?check|near me)/i;

const UNSAFE_SEARCH_PATTERNS = [
  /(?:自制|制作|组装|合成).{0,10}(?:炸弹|爆炸物|枪支|枪械|毒气|剧毒物)/i,
  /(?:购买|交易|出售).{0,8}(?:毒品|枪支|枪械|爆炸物|儿童色情)/i,
  /(?:入侵|攻击|盗取|破解).{0,10}(?:账号|密码|服务器|网站|摄像头|银行卡)/i,
  /(?:人肉|开盒|跟踪|定位).{0,10}(?:个人|住址|手机号|身份证|实时位置)/i,
  /(?:自杀|轻生).{0,8}(?:方法|教程|成功率|最有效)/i,
  /(?:儿童|未成年).{0,8}(?:色情|裸照|性交易)/i,
];

export interface WebSearchSource {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  reliability: "high" | "medium" | "unverified";
  sourceType: "organic" | "news" | "local" | "answer";
}

export interface WebSearchEvidence {
  status: "searched" | "blocked" | "unavailable";
  query?: string;
  sources: WebSearchSource[];
  note?: string;
}

interface SerpApiResult {
  error?: unknown;
  answer_box?: Record<string, unknown>;
  knowledge_graph?: Record<string, unknown>;
  organic_results?: Array<Record<string, unknown>>;
  news_results?: Array<Record<string, unknown>>;
  local_results?: {
    places?: Array<Record<string, unknown>>;
  };
}

export function shouldUseWebSearch(question: string) {
  return SEARCH_INTENT_PATTERN.test(question.trim());
}

export function isUnsafeWebSearch(question: string) {
  return UNSAFE_SEARCH_PATTERNS.some((pattern) => pattern.test(question));
}

export async function prepareWebSearch(
  question: string,
  source: VideoSourceDescriptor,
  signal?: AbortSignal,
): Promise<WebSearchEvidence | undefined> {
  if (!shouldUseWebSearch(question)) return undefined;
  if (isUnsafeWebSearch(question)) {
    return {
      status: "blocked",
      sources: [],
      note: "该请求可能涉及危险操作、违法获取或严重隐私侵害，已跳过联网检索。",
    };
  }

  const apiKey = runtimeValue("SERPAPI_API_KEY");
  if (!apiKey) {
    return {
      status: "unavailable",
      sources: [],
      note: "尚未配置 SERPAPI_API_KEY，无法执行联网检索。",
    };
  }

  const query = buildSearchQuery(question, source);
  const endpoint = new URL(SERPAPI_ENDPOINT);
  endpoint.searchParams.set("engine", "google");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("output", "json");
  endpoint.searchParams.set("safe", "active");
  endpoint.searchParams.set("hl", "zh-cn");
  endpoint.searchParams.set("gl", "cn");
  endpoint.searchParams.set("num", String(MAX_SEARCH_RESULTS));

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
    if (!response.ok || !body || typeof body !== "object") {
      return {
        status: "unavailable",
        query,
        sources: [],
        note: `SerpAPI 检索失败（HTTP ${response.status}）。`,
      };
    }
    if (typeof body.error === "string" && body.error.trim()) {
      return {
        status: "unavailable",
        query,
        sources: [],
        note: `SerpAPI 检索失败：${body.error.trim().slice(0, 180)}`,
      };
    }
    const sources = collectSources(body).slice(0, MAX_SEARCH_RESULTS);
    return {
      status: sources.length > 0 ? "searched" : "unavailable",
      query,
      sources,
      ...(sources.length > 0
        ? {}
        : { note: "SerpAPI 没有返回可用于回答的搜索结果。" }),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      status: "unavailable",
      query,
      sources: [],
      note: timeoutSignal.aborted
        ? "SerpAPI 检索超时。"
        : "暂时无法连接 SerpAPI。",
    };
  }
}

function buildSearchQuery(question: string, source: VideoSourceDescriptor) {
  const normalized = question
    .replace(
      /(?:请|麻烦)?(?:帮我)?(?:联网|上网)?(?:搜索|搜一下|查一下|查证|核实)(?:一下)?/gi,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const needsVideoContext =
    /(?:这个|该|视频中|作者|里面|上述|它)/.test(normalized);
  const query = needsVideoContext
    ? `${source.title} ${normalized}`
    : normalized;
  return query.slice(0, MAX_QUERY_CHARACTERS);
}

function collectSources(body: SerpApiResult) {
  const sources: WebSearchSource[] = [];
  const seen = new Set<string>();
  const add = (
    item: Record<string, unknown>,
    sourceType: WebSearchSource["sourceType"],
  ) => {
    const url = stringField(item.link) || stringField(item.website);
    const title =
      stringField(item.title) ||
      stringField(item.name) ||
      stringField(item.source);
    const snippet =
      stringField(item.snippet) ||
      stringField(item.description) ||
      stringField(item.answer) ||
      stringField(item.address);
    if (!url || !title || seen.has(url) || !isPublicHttpUrl(url)) return;
    seen.add(url);
    sources.push({
      title: title.slice(0, 240),
      url,
      snippet: (snippet || "搜索结果未提供摘要。").slice(0, 800),
      ...(stringField(item.date)
        ? { publishedAt: stringField(item.date)?.slice(0, 80) }
        : {}),
      reliability: sourceReliability(url),
      sourceType,
    });
  };

  if (body.answer_box) add(body.answer_box, "answer");
  if (body.knowledge_graph) add(body.knowledge_graph, "answer");
  for (const result of body.news_results ?? []) add(result, "news");
  for (const result of body.organic_results ?? []) add(result, "organic");
  for (const result of body.local_results?.places ?? []) add(result, "local");
  return sources;
}

function stringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPublicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
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
