export type ModelUsageProvider = "qwen" | "deepseek";

export type ModelUsageOperation =
  | "video_summary"
  | "answer_readiness_initial"
  | "answer_readiness_after_recall"
  | "recall_plan"
  | "recall_rerank"
  | "web_search_plan"
  | "chat_answer";

export interface ModelTokenDetails {
  textTokens: number;
  imageTokens: number;
  videoTokens: number;
  audioTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
}

export interface ModelCallUsage {
  provider: ModelUsageProvider;
  model: string;
  operation: ModelUsageOperation;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostCnyMicros: number;
  pricingVersion: string;
  tokenDetails: ModelTokenDetails;
}

export interface ConversationUsageRecord {
  kind: "summary" | "answer";
  totalTokens: number;
  estimatedCostCnyMicros: number;
  searchCount: number;
  createdAt: number;
  calls: ModelCallUsage[];
}

export type ModelUsageSink = (usage: ModelCallUsage) => void;

const QWEN_PRICING_VERSION = "qwen3.5-omni-plus-cn-beijing-2026-07-30";
const DEEPSEEK_PRICING_VERSION = "deepseek-v4-2026-07-30-usd-cny-7.2";
const USD_TO_CNY = 7.2;

const QWEN_INPUT_NON_AUDIO_CNY_PER_MILLION = 7;
const QWEN_INPUT_AUDIO_CNY_PER_MILLION = 53;
const QWEN_OUTPUT_TEXT_CNY_PER_MILLION = 40;

const DEEPSEEK_PRICES_USD_PER_MILLION = {
  flash: { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  pro: { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
} as const;

interface NormalizeUsageOptions {
  provider: ModelUsageProvider;
  model: string;
  operation: ModelUsageOperation;
  deepSeekTier?: "flash" | "pro";
}

export function normalizeModelCallUsage(
  rawUsage: unknown,
  options: NormalizeUsageOptions,
): ModelCallUsage | null {
  const usage = recordOrNull(rawUsage);
  if (!usage) return null;

  const promptTokens = nonNegativeInteger(usage.prompt_tokens) ?? 0;
  const completionTokens = nonNegativeInteger(usage.completion_tokens) ?? 0;
  const totalTokens =
    nonNegativeInteger(usage.total_tokens) ??
    promptTokens + completionTokens;
  const promptDetails =
    recordOrNull(usage.prompt_tokens_details) ??
    recordOrNull(usage.input_tokens_details);
  const completionDetails = recordOrNull(usage.completion_tokens_details);
  const audioTokens = Math.min(
    promptTokens,
    nonNegativeInteger(promptDetails?.audio_tokens) ?? 0,
  );
  const cacheHitTokens = Math.min(
    promptTokens,
    nonNegativeInteger(usage.prompt_cache_hit_tokens) ??
      nonNegativeInteger(promptDetails?.cached_tokens) ??
      0,
  );
  const explicitCacheMiss =
    nonNegativeInteger(usage.prompt_cache_miss_tokens) ?? 0;
  const cacheMissTokens = Math.min(
    Math.max(0, promptTokens - cacheHitTokens),
    Math.max(explicitCacheMiss, promptTokens - cacheHitTokens),
  );
  const tokenDetails: ModelTokenDetails = {
    textTokens: nonNegativeInteger(promptDetails?.text_tokens) ?? 0,
    imageTokens: nonNegativeInteger(promptDetails?.image_tokens) ?? 0,
    videoTokens: nonNegativeInteger(promptDetails?.video_tokens) ?? 0,
    audioTokens,
    cacheHitTokens,
    cacheMissTokens,
    reasoningTokens:
      nonNegativeInteger(completionDetails?.reasoning_tokens) ?? 0,
  };

  const estimatedCostCnyMicros =
    options.provider === "qwen"
      ? qwenCostCnyMicros(promptTokens, completionTokens, audioTokens)
      : deepSeekCostCnyMicros(
          completionTokens,
          cacheHitTokens,
          cacheMissTokens,
          options.deepSeekTier ?? "flash",
        );

  return {
    provider: options.provider,
    model: options.model,
    operation: options.operation,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCostCnyMicros,
    pricingVersion:
      options.provider === "qwen"
        ? QWEN_PRICING_VERSION
        : DEEPSEEK_PRICING_VERSION,
    tokenDetails,
  };
}

export function conversationUsageRecord(
  kind: ConversationUsageRecord["kind"],
  calls: ModelCallUsage[],
  searchCount = 0,
  createdAt = Date.now(),
): ConversationUsageRecord {
  return {
    kind,
    totalTokens: calls.reduce((total, call) => total + call.totalTokens, 0),
    estimatedCostCnyMicros: calls.reduce(
      (total, call) => total + call.estimatedCostCnyMicros,
      0,
    ),
    searchCount: Math.max(0, Math.trunc(searchCount)),
    createdAt,
    calls,
  };
}

export function parseConversationUsageRecord(
  value: unknown,
): ConversationUsageRecord | null {
  const record = recordOrNull(value);
  if (!record || (record.kind !== "summary" && record.kind !== "answer")) {
    return null;
  }
  const totalTokens = boundedInteger(record.totalTokens, 0, 1_000_000_000);
  const estimatedCostCnyMicros = boundedInteger(
    record.estimatedCostCnyMicros,
    0,
    1_000_000_000_000,
  );
  const searchCount = boundedInteger(record.searchCount, 0, 100);
  const createdAt = boundedInteger(
    record.createdAt,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    totalTokens === null ||
    estimatedCostCnyMicros === null ||
    searchCount === null ||
    createdAt === null ||
    !Array.isArray(record.calls) ||
    record.calls.length > 16
  ) {
    return null;
  }

  const calls = record.calls.map(parseModelCallUsage);
  if (calls.some((call) => call === null)) return null;
  const normalizedCalls = calls as ModelCallUsage[];
  if (
    totalTokens !==
      normalizedCalls.reduce((total, call) => total + call.totalTokens, 0) ||
    estimatedCostCnyMicros !==
      normalizedCalls.reduce(
        (total, call) => total + call.estimatedCostCnyMicros,
        0,
      )
  ) {
    return null;
  }

  return {
    kind: record.kind,
    totalTokens,
    estimatedCostCnyMicros,
    searchCount,
    createdAt,
    calls: normalizedCalls,
  };
}

function parseModelCallUsage(value: unknown): ModelCallUsage | null {
  const record = recordOrNull(value);
  const provider =
    record?.provider === "qwen" || record?.provider === "deepseek"
      ? record.provider
      : null;
  const operation =
    record?.operation === "video_summary" ||
    record?.operation === "answer_readiness_initial" ||
    record?.operation === "answer_readiness_after_recall" ||
    record?.operation === "recall_plan" ||
    record?.operation === "recall_rerank" ||
    record?.operation === "web_search_plan" ||
    record?.operation === "chat_answer"
      ? record.operation
      : null;
  const model =
    typeof record?.model === "string" && record.model.trim().length <= 200
      ? record.model.trim()
      : "";
  const promptTokens = boundedInteger(record?.promptTokens, 0, 1_000_000_000);
  const completionTokens = boundedInteger(
    record?.completionTokens,
    0,
    1_000_000_000,
  );
  const totalTokens = boundedInteger(record?.totalTokens, 0, 1_000_000_000);
  const estimatedCostCnyMicros = boundedInteger(
    record?.estimatedCostCnyMicros,
    0,
    1_000_000_000_000,
  );
  const pricingVersion =
    typeof record?.pricingVersion === "string" &&
    record.pricingVersion.trim().length <= 200
      ? record.pricingVersion.trim()
      : "";
  const details = recordOrNull(record?.tokenDetails);
  const tokenDetails = details
    ? {
        textTokens: boundedInteger(details.textTokens, 0, 1_000_000_000),
        imageTokens: boundedInteger(details.imageTokens, 0, 1_000_000_000),
        videoTokens: boundedInteger(details.videoTokens, 0, 1_000_000_000),
        audioTokens: boundedInteger(details.audioTokens, 0, 1_000_000_000),
        cacheHitTokens: boundedInteger(
          details.cacheHitTokens,
          0,
          1_000_000_000,
        ),
        cacheMissTokens: boundedInteger(
          details.cacheMissTokens,
          0,
          1_000_000_000,
        ),
        reasoningTokens: boundedInteger(
          details.reasoningTokens,
          0,
          1_000_000_000,
        ),
      }
    : null;
  if (
    !provider ||
    !operation ||
    !model ||
    promptTokens === null ||
    completionTokens === null ||
    totalTokens === null ||
    totalTokens !== promptTokens + completionTokens ||
    estimatedCostCnyMicros === null ||
    !pricingVersion ||
    !tokenDetails ||
    Object.values(tokenDetails).some((entry) => entry === null)
  ) {
    return null;
  }

  return {
    provider,
    model,
    operation,
    promptTokens,
    completionTokens,
    totalTokens,
    estimatedCostCnyMicros,
    pricingVersion,
    tokenDetails: tokenDetails as ModelTokenDetails,
  };
}

function qwenCostCnyMicros(
  promptTokens: number,
  completionTokens: number,
  audioTokens: number,
) {
  const nonAudioTokens = Math.max(0, promptTokens - audioTokens);
  return Math.round(
    nonAudioTokens * QWEN_INPUT_NON_AUDIO_CNY_PER_MILLION +
      audioTokens * QWEN_INPUT_AUDIO_CNY_PER_MILLION +
      completionTokens * QWEN_OUTPUT_TEXT_CNY_PER_MILLION,
  );
}

function deepSeekCostCnyMicros(
  completionTokens: number,
  cacheHitTokens: number,
  cacheMissTokens: number,
  tier: "flash" | "pro",
) {
  const prices = DEEPSEEK_PRICES_USD_PER_MILLION[tier];
  return Math.round(
    (cacheHitTokens * prices.cacheHit +
      cacheMissTokens * prices.cacheMiss +
      completionTokens * prices.output) *
      USD_TO_CNY,
  );
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown) {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}
