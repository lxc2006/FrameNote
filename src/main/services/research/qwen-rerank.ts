import {
  normalizeModelCallUsage,
  type ModelCallUsage,
} from "../../../shared/model-usage";
import { positiveInteger, runtimeValue } from "../../config/app-env";

const MODEL = "qwen3.7-text-rerank";
const DEFAULT_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/rerank/text-rerank/text-rerank";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_THRESHOLD = 0.2;
const DEFAULT_CHUNK_CHARACTERS = 2_000;
const DEFAULT_SOURCE_TOKEN_BUDGET = 20_000;

interface RerankResponse {
  output?: {
    results?: Array<{ index?: unknown; relevance_score?: unknown }>;
  };
  usage?: unknown;
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
}

export interface RerankResult {
  passages: string[];
  usage: ModelCallUsage | null;
}

export class QwenRerankError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QwenRerankError";
  }
}

export async function rerankWebDocument(
  query: string,
  text: string,
  signal?: AbortSignal,
): Promise<RerankResult> {
  const apiKey = runtimeValue("DASHSCOPE_API_KEY");
  if (!apiKey) {
    throw new QwenRerankError("尚未配置千问 API Key，无法进行网页精排。");
  }
  const chunks = splitWebDocument(
    text.slice(0, 100_000),
    positiveInteger(
      runtimeValue("WEB_RERANK_CHUNK_CHARACTERS"),
      DEFAULT_CHUNK_CHARACTERS,
    ),
  );
  if (!chunks.length) return { passages: [], usage: null };

  const timeoutSignal = AbortSignal.timeout(
    positiveInteger(
      runtimeValue("QWEN_RERANK_REQUEST_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
  );
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const response = await fetch(rerankEndpoint(), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        query: query.replace(/\s+/g, " ").trim().slice(0, 1_000),
        documents: chunks,
      },
      parameters: {
        top_n: chunks.length,
        instruct:
          "Given a web search query, retrieve relevant passages that answer the query.",
      },
    }),
    signal: requestSignal,
  });
  const body = (await response.json().catch(() => null)) as
    | RerankResponse
    | null;
  if (!response.ok || !Array.isArray(body?.output?.results)) {
    const details = [stringValue(body?.code), stringValue(body?.message)]
      .filter(Boolean)
      .join(": ");
    const requestId = stringValue(body?.request_id);
    throw new QwenRerankError(
      `千问网页精排失败（HTTP ${response.status}）${
        details ? `：${details}` : ""
      }${requestId ? `；request_id=${requestId}` : ""}`,
    );
  }

  const threshold = rerankThreshold();
  const selectedIndexes = body.output.results
    .flatMap((result) => {
      const index = result.index;
      const score = result.relevance_score;
      return typeof index === "number" &&
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < chunks.length &&
        typeof score === "number" &&
        Number.isFinite(score) &&
        score >= threshold
        ? [index]
        : [];
    })
    .sort((left, right) => left - right);
  const tokenBudget = positiveInteger(
    runtimeValue("WEB_RERANK_MAX_TOKENS_PER_SOURCE"),
    DEFAULT_SOURCE_TOKEN_BUDGET,
  );
  const passages: string[] = [];
  let usedTokens = 0;
  for (const index of selectedIndexes) {
    const passage = chunks[index];
    const passageTokens = estimateTextTokens(passage);
    if (usedTokens + passageTokens > tokenBudget) break;
    passages.push(passage);
    usedTokens += passageTokens;
  }
  return {
    passages,
    usage: normalizeModelCallUsage(body.usage, {
      provider: "qwen",
      model: MODEL,
      operation: "web_rerank",
    }),
  };
}

export function splitWebDocument(text: string, maxCharacters = 2_000) {
  const limit = Math.max(200, Math.trunc(maxCharacters));
  const blocks = text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (!current) return;
    chunks.push(current);
    current = "";
  };

  for (const block of blocks) {
    if (block.length > limit) {
      flush();
      for (let start = 0; start < block.length; start += limit) {
        chunks.push(block.slice(start, start + limit));
      }
      continue;
    }
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > limit) flush();
    current = current ? `${current}\n\n${block}` : block;
  }
  flush();
  return chunks;
}

export function estimateTextTokens(value: string) {
  const cjk =
    value.match(
      /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
    )?.length ?? 0;
  const remainder = value.replace(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]/gu,
    "",
  );
  return Math.max(1, cjk + Math.ceil(remainder.length / 4));
}

function rerankThreshold() {
  const configured = Number(runtimeValue("QWEN_RERANK_THRESHOLD"));
  return Number.isFinite(configured) && configured >= 0 && configured <= 1
    ? configured
    : DEFAULT_THRESHOLD;
}

function rerankEndpoint() {
  const configured = runtimeValue("DASHSCOPE_RERANK_ENDPOINT");
  if (configured) return validatedEndpoint(configured);
  const baseUrl = runtimeValue("DASHSCOPE_BASE_URL");
  if (!baseUrl) return DEFAULT_ENDPOINT;
  const base = validatedEndpoint(baseUrl);
  base.pathname = "/api/v1/services/rerank/text-rerank/text-rerank";
  base.search = "";
  base.hash = "";
  return base;
}

function validatedEndpoint(value: string) {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !localHttp) {
    throw new QwenRerankError("千问网页精排地址必须使用 HTTPS。");
  }
  return url;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 500)
    : undefined;
}
