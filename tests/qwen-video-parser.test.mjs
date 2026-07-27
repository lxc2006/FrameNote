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
    `/lib/server/qwen-video-engine.ts?audio-empty=${Date.now()}`,
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
