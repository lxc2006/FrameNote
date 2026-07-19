import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createViteServer } from "vite";

test("extracts sampled frames without scanning the full video", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const extractor = await vite.ssrLoadModule(
    `/lib/client/frame-extractor.ts?test=${Date.now()}`,
  );
  const preprocessor = await vite.ssrLoadModule(
    `/lib/client/video-preprocessor.ts?test=${Date.now()}`,
  );

  await t.test("builds a bounded plan for a seven-minute video", () => {
    const plan = preprocessor.createFramePlan(7 * 60);
    assert.equal(plan.count, 24);
    assert.equal(plan.intervalSeconds, 17.5);
    assert.equal(plan.timestamps.length, 24);
    assert.equal(plan.timestamps[0], 0);
    assert.ok(plan.timestamps.every((value, index, values) =>
      value >= 0 && value < 7 * 60 && (index === 0 || value > values[index - 1])
    ));
  });

  await t.test("uses native extraction without invoking the fallback", async () => {
    const nativeFrames = [{ data: new Uint8Array([1]), timestamp: 0 }];
    let fallbackCalls = 0;
    const progress = [];
    const frames = await extractor.extractFramesWithFallback({
      minimumFrames: 1,
      nativeExtractor: async (onProgress) => {
        onProgress(0.5);
        return nativeFrames;
      },
      fallbackExtractor: async () => {
        fallbackCalls += 1;
        return [];
      },
      onProgress: (value) => progress.push(value),
    });

    assert.equal(frames, nativeFrames);
    assert.equal(fallbackCalls, 0);
    assert.deepEqual(progress, [0.075, 1]);
  });

  await t.test("falls back once and keeps progress monotonic", async () => {
    let fallbackCalls = 0;
    const progress = [];
    const fallbackFrames = [{ data: new Uint8Array([2]), timestamp: 10 }];
    const frames = await extractor.extractFramesWithFallback({
      minimumFrames: 1,
      nativeExtractor: async (onProgress) => {
        onProgress(0.8);
        throw new extractor.NativeFrameExtractionError("native failed");
      },
      fallbackExtractor: async (onProgress) => {
        fallbackCalls += 1;
        onProgress(0.25);
        onProgress(1);
        return fallbackFrames;
      },
      onProgress: (value) => progress.push(value),
    });

    assert.equal(frames, fallbackFrames);
    assert.equal(fallbackCalls, 1);
    assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
    assert.equal(progress.at(-1), 1);
  });

  await t.test("does not fall back after user cancellation", async () => {
    const controller = new AbortController();
    let fallbackCalls = 0;
    await assert.rejects(
      extractor.extractFramesWithFallback({
        minimumFrames: 1,
        signal: controller.signal,
        nativeExtractor: async () => {
          controller.abort();
          throw new DOMException("cancelled", "AbortError");
        },
        fallbackExtractor: async () => {
          fallbackCalls += 1;
          return [];
        },
      }),
      (error) => error instanceof DOMException && error.name === "AbortError",
    );
    assert.equal(fallbackCalls, 0);
  });

  await t.test("uses input-side FFmpeg seeks for the compatibility fallback", async () => {
    const commands = [];
    const deleted = [];
    const progress = [];
    const ffmpeg = {
      async exec(args) {
        commands.push(args);
        return 0;
      },
      async readFile(path) {
        return new Uint8Array([Number(path.match(/(\d+)\.jpg$/)?.[1] ?? 0)]);
      },
      async deleteFile(path) {
        deleted.push(path);
        return true;
      },
    };
    const timestamps = [0, 17.5, 35];
    const frames = await extractor.extractFramesWithFfmpegSeeks(ffmpeg, {
      inputPath: "/source/video.mp4",
      timestamps,
      width: 960,
      jpegQuality: 6,
      timeoutMs: 1_000,
      seekTimeoutMs: 100,
      onProgress: (value) => progress.push(value),
    });

    assert.deepEqual(frames.map(({ timestamp }) => timestamp), timestamps);
    assert.equal(commands.length, timestamps.length);
    for (const command of commands) {
      assert.ok(command.indexOf("-ss") < command.indexOf("-i"));
      assert.ok(!command.some((value) => value.startsWith("fps=")));
      assert.equal(command[command.indexOf("-frames:v") + 1], "1");
    }
    assert.equal(deleted.length, timestamps.length);
    assert.equal(progress.at(-1), 1);
  });

  await t.test("captures native video frames through Canvas and releases resources", async (t) => {
    const originalDocument = globalThis.document;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revoked = [];
    let drawCount = 0;
    let canvasRemoved = false;
    let videoRemoved = false;

    class ReadyVideo extends EventTarget {
      readyState = 0;
      videoWidth = 1280;
      videoHeight = 720;
      duration = 60;
      error = null;
      src = "";
      #currentTime = 0;
      get currentTime() {
        return this.#currentTime;
      }
      set currentTime(value) {
        this.#currentTime = value;
        queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
      }
      load() {
        if (!this.src) return;
        queueMicrotask(() => {
          this.readyState = 2;
          this.dispatchEvent(new Event("loadedmetadata"));
          this.dispatchEvent(new Event("loadeddata"));
        });
      }
      pause() {}
      remove() {
        videoRemoved = true;
      }
      removeAttribute() {
        this.src = "";
      }
    }

    class ReadyCanvas {
      width = 0;
      height = 0;
      getContext() {
        return {
          fillStyle: "",
          fillRect() {},
          drawImage: () => {
            drawCount += 1;
          },
        };
      }
      toBlob(callback) {
        queueMicrotask(() =>
          callback(new Blob([new Uint8Array([drawCount])], { type: "image/jpeg" })),
        );
      }
      remove() {
        canvasRemoved = true;
      }
    }

    globalThis.document = {
      createElement(name) {
        if (name === "video") return new ReadyVideo();
        if (name === "canvas") return new ReadyCanvas();
        throw new Error(`Unexpected element: ${name}`);
      },
    };
    URL.createObjectURL = () => "blob:ready-video";
    URL.revokeObjectURL = (url) => revoked.push(url);
    t.after(() => {
      globalThis.document = originalDocument;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    const progress = [];
    const frames = await extractor.extractFramesWithNativeVideo(
      new File([new Uint8Array([1])], "video.mp4", { type: "video/mp4" }),
      {
        timestamps: [0, 15, 30],
        width: 960,
        jpegQuality: 0.82,
        timeoutMs: 100,
        seekTimeoutMs: 50,
        onProgress: (value) => progress.push(value),
      },
    );

    assert.deepEqual(frames.map(({ timestamp }) => timestamp), [0, 15, 30]);
    assert.deepEqual(frames.map(({ data }) => [...data]), [[1], [2], [3]]);
    assert.equal(drawCount, 3);
    assert.equal(progress.at(-1), 1);
    assert.equal(videoRemoved, true);
    assert.equal(canvasRemoved, true);
    assert.deepEqual(revoked, ["blob:ready-video"]);
  });

  await t.test("times out native media loading and releases the Blob URL", async (t) => {
    const originalDocument = globalThis.document;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const revoked = [];

    class StalledVideo extends EventTarget {
      readyState = 0;
      videoWidth = 1280;
      videoHeight = 720;
      duration = 60;
      currentTime = 0;
      error = null;
      src = "";
      load() {}
      pause() {}
      remove() {}
      removeAttribute() {
        this.src = "";
      }
    }

    globalThis.document = {
      createElement(name) {
        if (name === "video") return new StalledVideo();
        throw new Error(`Unexpected element: ${name}`);
      },
    };
    URL.createObjectURL = () => "blob:stalled-video";
    URL.revokeObjectURL = (url) => revoked.push(url);
    t.after(() => {
      globalThis.document = originalDocument;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    });

    await assert.rejects(
      extractor.extractFramesWithNativeVideo(
        new File([new Uint8Array([1])], "video.mp4", { type: "video/mp4" }),
        {
          timestamps: [0],
          width: 960,
          jpegQuality: 0.82,
          timeoutMs: 10,
          seekTimeoutMs: 10,
        },
      ),
      (error) => error instanceof extractor.NativeFrameExtractionError,
    );
    assert.deepEqual(revoked, ["blob:stalled-video"]);
  });
});
