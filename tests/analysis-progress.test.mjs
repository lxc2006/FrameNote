import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createViteServer } from "vite";

test("estimates long-running analysis stages without completing them early", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const {
    advanceDisplayedProgress,
    estimatedStageDurationMs,
    estimatedStageProgress,
  } = await vite.ssrLoadModule(
    `/lib/client/analysis-progress.ts?progress=${Date.now()}`,
  );

  assert.ok(
    estimatedStageDurationMs("transcript", 1_200) >
      estimatedStageDurationMs("transcript", 120),
  );
  assert.ok(
    estimatedStageProgress("qwen", 30_000, 600, 0.15) >
      estimatedStageProgress("qwen", 1_000, 600, 0.15),
  );
  const longRunningTranscript = estimatedStageProgress(
    "transcript",
    60 * 60 * 1_000,
    3_600,
  );
  assert.ok(longRunningTranscript > 0.9);
  assert.ok(longRunningTranscript <= 0.94);
  assert.equal(advanceDisplayedProgress(20, 80), 22.5);
  assert.equal(advanceDisplayedProgress(79.9, 80), 80);
  assert.equal(advanceDisplayedProgress(80, 20), 80);
});
