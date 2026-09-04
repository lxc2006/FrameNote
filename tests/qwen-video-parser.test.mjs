import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createViteServer } from "vite";

test("normalizes common Qwen audio field variants through one parser", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const { parseVideoSummary } = await vite.ssrLoadModule(
    `/src/main/model/qwen-video-engine.ts?audio-empty=${Date.now()}`,
  );
  const parsed = parseVideoSummary(
    JSON.stringify({
      title: "测试",
      overview: "视频包含音乐，但没有可辨讲话。",
      keyPoints: [
        { time: "00:00", title: "开始", detail: "音乐开始播放。" },
      ],
      chapters: [
        { time: "00:00", title: "开场", description: "画面与音乐出现。" },
      ],
      evidence: [],
      audioAnalysis: {
        status: "analyzed",
        summary: "能够辨认背景音乐，没有可辨讲话。",
        // Qwen occasionally invents this legacy field in a malformed shape.
        // New summaries ignore it because subtitles belong to FunASR.
        speech: ["", { content: "不应进入结构化总结。" }],
        music: ["持续的背景音乐。", { description: "节奏平稳。" }],
        soundscape: { text: "轻微的环境声。" },
        temporalChanges: [],
      },
    }),
    "回退标题",
    { requireAudioAnalysis: true, audioEvidence: "embedded" },
  );

  assert.equal("speech" in parsed.audioAnalysis, false);
  assert.equal(
    parsed.audioAnalysis.music,
    "持续的背景音乐。；节奏平稳。",
  );
  assert.equal(parsed.audioAnalysis.soundscape, "轻微的环境声。");
});

test("ignores malformed optional evidence without rejecting a valid summary", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const { parseVideoSummary } = await vite.ssrLoadModule(
    `/src/main/model/qwen-video-engine.ts?optional-evidence=${Date.now()}`,
  );
  const parsed = parseVideoSummary(
    JSON.stringify({
      title: "测试总结",
      overview: "视频包含完整且可用的概览。",
      keyPoints: [
        { time: "00:01", title: "开始", detail: "视频内容开始。" },
      ],
      chapters: [
        { time: "00:01", title: "开场", description: "视频进入开场部分。" },
      ],
      evidence: [
        { time: "00:01", fact: "" },
        { time: "", fact: "缺少时间。" },
        null,
        { time: "00:02", fact: "这是一条有效证据。" },
      ],
    }),
    "回退标题",
  );

  assert.deepEqual(parsed.evidence, [
    { time: "00:02", fact: "这是一条有效证据。" },
  ]);
});

test("keeps at most 24 summary time points", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const { parseVideoSummary } = await vite.ssrLoadModule(
    `/src/main/model/qwen-video-engine.ts?time-points=${Date.now()}`,
  );
  const parsed = parseVideoSummary(
    JSON.stringify({
      title: "长视频",
      overview: "包含许多时间点。",
      keyPoints: Array.from({ length: 30 }, (_, index) => ({
        time: `00:${String(index).padStart(2, "0")}`,
        title: `时间点 ${index + 1}`,
        detail: `第 ${index + 1} 个片段。`,
      })),
      chapters: [
        { time: "00:00", title: "开始", description: "视频开始。" },
      ],
    }),
    "回退标题",
  );

  assert.equal(parsed.keyPoints.length, 24);
  assert.equal(parsed.keyPoints[0].title, "时间点 1");
  assert.equal(parsed.keyPoints.at(-1).title, "时间点 30");
});
