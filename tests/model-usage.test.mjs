import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationUsageRecord,
  normalizeModelCallUsage,
  parseConversationUsageRecord,
} from "../src/shared/model-usage.ts";

test("normalizes Qwen multimodal token usage with token fields only", () => {
  const usage = normalizeModelCallUsage(
    {
      prompt_tokens: 1_000,
      completion_tokens: 100,
      total_tokens: 1_100,
      prompt_tokens_details: {
        text_tokens: 50,
        image_tokens: 150,
        video_tokens: 500,
        audio_tokens: 300,
      },
    },
    {
      provider: "qwen",
      model: "qwen3.5-omni-plus",
      operation: "video_summary",
    },
  );

  assert.ok(usage);
  assert.equal(usage.totalTokens, 1_100);
  assert.equal(usage.promptTokens, 1_000);
  assert.equal(usage.completionTokens, 100);
  assert.equal(usage.tokenDetails.audioTokens, 300);
  assert.deepEqual(Object.keys(usage).sort(), [
    "completionTokens",
    "model",
    "operation",
    "promptTokens",
    "provider",
    "tokenDetails",
    "totalTokens",
  ]);
});

test("normalizes DeepSeek cache and reasoning token details", () => {
  const raw = {
    prompt_tokens: 1_000,
    completion_tokens: 200,
    total_tokens: 1_200,
    prompt_cache_hit_tokens: 400,
    prompt_cache_miss_tokens: 600,
    completion_tokens_details: { reasoning_tokens: 120 },
  };
  const usage = normalizeModelCallUsage(raw, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    operation: "recall_plan",
  });

  assert.ok(usage);
  assert.equal(usage.tokenDetails.cacheHitTokens, 400);
  assert.equal(usage.tokenDetails.cacheMissTokens, 600);
  assert.equal(usage.tokenDetails.reasoningTokens, 120);
});

test("aggregates and validates a persisted conversation usage record", () => {
  const call = normalizeModelCallUsage(
    {
      prompt_tokens: 500,
      completion_tokens: 50,
      total_tokens: 550,
    },
    {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      operation: "web_search_plan",
    },
  );
  assert.ok(call);
  const record = conversationUsageRecord("answer", [call], 1, 123_456);

  assert.deepEqual(parseConversationUsageRecord(record), record);
  assert.equal(record.totalTokens, 550);
  assert.equal(record.searchCount, 1);
  assert.equal(
    parseConversationUsageRecord({ ...record, totalTokens: 551 }),
    null,
  );
});
