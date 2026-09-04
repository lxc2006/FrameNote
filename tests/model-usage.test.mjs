import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationUsageRecord,
  normalizeModelCallUsage,
  parseConversationUsageRecord,
} from "../src/shared/model-usage.ts";

test("prices Qwen multimodal input from the provider usage breakdown", () => {
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
  assert.equal(usage.estimatedCostCnyMicros, 24_800);
  assert.equal(usage.tokenDetails.audioTokens, 300);
});

test("prices DeepSeek cache hit, cache miss, and output tokens separately", () => {
  const raw = {
    prompt_tokens: 1_000,
    completion_tokens: 200,
    total_tokens: 1_200,
    prompt_cache_hit_tokens: 400,
    prompt_cache_miss_tokens: 600,
    completion_tokens_details: { reasoning_tokens: 120 },
  };
  const flash = normalizeModelCallUsage(raw, {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    operation: "recall_plan",
    deepSeekTier: "flash",
  });
  const pro = normalizeModelCallUsage(raw, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    operation: "chat_answer",
    deepSeekTier: "pro",
  });

  assert.ok(flash);
  assert.ok(pro);
  assert.equal(flash.estimatedCostCnyMicros, 1_016);
  assert.equal(pro.estimatedCostCnyMicros, 3_142);
  assert.equal(pro.tokenDetails.reasoningTokens, 120);
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
      deepSeekTier: "flash",
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
