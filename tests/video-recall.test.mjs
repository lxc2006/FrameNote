import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createViteServer } from "vite";
import {
  applyVerifiedVideoTimeReferences,
} from "../src/main/model/video-recall-policy.ts";

const summary = {
  title: "四个方法",
  overview: "视频依次介绍四个方法。",
  keyPoints: [
    { time: "01:26", title: "漫无目的地走路", detail: "第一个方法。" },
    { time: "02:05", title: "主动发呆", detail: "第二个方法。" },
    { time: "02:29", title: "20分钟短睡", detail: "第三个方法。" },
    { time: "03:04", title: "切换到动手类活动", detail: "第四个方法。" },
  ],
  chapters: [],
};

test("removes external Markdown URLs attached to video time markers", () => {
  const answer = applyVerifiedVideoTimeReferences(
    "位置 [[video:00:11]](https://www.bilibili.com/video/BV1AB411C7mD?t=11)。",
  );

  assert.equal(answer, "位置 [[video:00:11]]。");
});

test("keeps attached video-time URL examples inside code unchanged", () => {
  const example =
    "`[[video:00:11]](https://example.com/video?t=11)`\n\n```text\n[[video:00:12]](https://example.com/video?t=12)\n```";

  assert.equal(applyVerifiedVideoTimeReferences(example), example);
});

test("links every verified plain video timestamp while leaving guesses plain", () => {
  const answer = applyVerifiedVideoTimeReferences(
    "四点在 01:26、02:05、02:29 和 03:04。旧的误判时间 08:56 不应跳转，代码 `02:29` 也不处理。",
    undefined,
    summary,
  );

  assert.match(answer, /\[\[video:86\.000\|01:26\]\]/);
  assert.match(answer, /\[\[video:125\.000\|02:05\]\]/);
  assert.match(answer, /\[\[video:149\.000\|02:29\]\]/);
  assert.match(answer, /\[\[video:184\.000\|03:04\]\]/);
  assert.match(answer, /08:56 不应跳转/);
  assert.match(answer, /`02:29` 也不处理/);
});

test("uses only verified plain timestamps and leaves internal ids untouched", () => {
  const answer = applyVerifiedVideoTimeReferences(
    "内部编号 [R1] 不应成为跳转点，更精确的字幕位置是 02:29。",
    {
      plan: {
        targets: ["transcript"],
        query: "位置",
        reason: "测试",
        fullReview: false,
      },
      items: [
        {
          id: "R1",
          source: "transcript",
          text: "[02:29] 精确字幕。",
          startSeconds: 125,
          endSeconds: 155,
        },
      ],
    },
    summary,
  );

  assert.match(answer, /\[R1\] 不应成为跳转点/);
  assert.match(answer, /\[\[video:149\.000\|02:29\]\]/);
});

test("compact memory keeps the complete overview and complete timeline", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  const { buildVideoMemory } = await vite.ssrLoadModule(
    `/src/main/model/video-recall.ts?memory=${Date.now()}`,
  );
  const overview = "完整内容概览。".repeat(500);
  const memory = buildVideoMemory(
    {
      kind: "bilibili",
      title: "长视频",
      subtitle: "B站",
      durationLabel: "20:00",
      bvid: "BV1AB411C7mD",
      sourceUrl: "https://www.bilibili.com/video/BV1AB411C7mD",
      description: "简介".repeat(1_500),
    },
    {
      title: "长视频总结",
      overview,
      keyPoints: Array.from({ length: 24 }, (_, index) => ({
        time: `${String(Math.floor(index / 60)).padStart(2, "0")}:${String(
          index % 60,
        ).padStart(2, "0")}`,
        title: `要点 ${index + 1}`,
        detail: `内容 ${index + 1}`,
      })),
      chapters: [],
      audioAnalysis: {
        status: "analyzed",
        summary: "声音".repeat(500),
        music: null,
        soundscape: "讲话",
        temporalChanges: [],
      },
    },
  );

  assert.equal(memory.overview, overview);
  assert.equal(memory.video.description.length, 2_000);
  assert.equal(memory.keyPoints.length, 24);
  assert.equal(memory.keyPoints[0].title, "要点 1");
  assert.equal(memory.keyPoints.at(-1).title, "要点 24");
  assert.equal(memory.audioOverview.length, 700);
});
