import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createViteServer } from "vite";

test("surfaces a Bilibili job error instead of rejecting its snapshot", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const requests = [];
  let jobStatus = "running";
  const erroredSnapshot = {
    jobId: "11111111-1111-4111-8111-111111111111",
    phase: "downloading",
    progress: 0.08,
    source: { bvid: "BV1nx411u79K", title: "公开测试视频", durationSeconds: 80 },
    error: {
      code: "DOWNLOAD_FAILED",
      message: "B 站视频下载失败，请稍后重试。",
      retryable: true,
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const method = init.method ?? "GET";
    requests.push({
      method,
      url: String(input),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const snapshot = {
      ...erroredSnapshot,
      status: method === "DELETE" ? "failed" : jobStatus,
    };
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { BilibiliClientError, downloadBilibiliVideo } = await vite.ssrLoadModule(
    `/lib/client/bilibili-client.ts?failed-job=${Date.now()}`,
  );

  // Accept both the former in-flight error window and the finalized failed state.
  for (jobStatus of ["running", "failed"]) {
    requests.length = 0;
    await assert.rejects(
      downloadBilibiliVideo("BV1nx411u79K"),
      (error) => {
        assert.ok(error instanceof BilibiliClientError);
        assert.equal(error.code, erroredSnapshot.error.code);
        assert.equal(error.message, erroredSnapshot.error.message);
        assert.equal(error.retryable, erroredSnapshot.error.retryable);
        return true;
      },
    );
    assert.deepEqual(requests.map(({ method }) => method), ["POST", "DELETE"]);
    assert.deepEqual(requests[0].body, {
      bvid: "BV1nx411u79K",
      variant: "analysis",
    });
  }
});

test("prepares separate highest-quality playback and download URLs without buffering media", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const requests = [];
  const playbackUrl = "https://media.example.com/signed/highest-compatible.mp4?download=0";
  const artifactUrl = "https://media.example.com/signed/highest-compatible.mp4";
  const snapshot = {
    jobId: "22222222-2222-4222-8222-222222222222",
    status: "succeeded",
    phase: "ready",
    progress: 1,
    source: {
      bvid: "BV1nx411u79K",
      title: "最高画质测试视频",
      durationSeconds: 600,
    },
    artifact: {
      playbackUrl,
      downloadUrl: artifactUrl,
      filename: "最高画质测试视频.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5 * 1024 * 1024 * 1024,
      sha256: "a".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      width: 1920,
      height: 1080,
    },
  };

  globalThis.fetch = async (input, init = {}) => {
    requests.push({
      method: init.method ?? "GET",
      url: String(input),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(snapshot), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { prepareBilibiliVideoDownload } = await vite.ssrLoadModule(
    `/lib/client/bilibili-client.ts?manual-download=${Date.now()}`,
  );
  const result = await prepareBilibiliVideoDownload("BV1nx411u79K");

  assert.equal(result.playbackUrl, playbackUrl);
  assert.equal(result.downloadUrl, artifactUrl);
  assert.equal(result.filename, snapshot.artifact.filename);
  assert.equal(result.sizeBytes, snapshot.artifact.sizeBytes);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.deepEqual(requests.map(({ method }) => method), ["POST"]);
  assert.deepEqual(requests[0].body, {
    bvid: "BV1nx411u79K",
    variant: "preview",
  });
});

test("rejects AI analysis artifacts above 500 MB before buffering media", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const requests = [];
  const artifactUrl = "https://media.example.com/signed/too-large-analysis.mp4";
  const snapshot = {
    jobId: "55555555-5555-4555-8555-555555555555",
    status: "succeeded",
    phase: "ready",
    progress: 1,
    source: {
      bvid: "BV1nx411u79K",
      title: "超大分析素材",
      durationSeconds: 600,
    },
    artifact: {
      playbackUrl: `${artifactUrl}?download=0`,
      downloadUrl: artifactUrl,
      filename: "analysis.mp4",
      mimeType: "video/mp4",
      sizeBytes: 500 * 1024 * 1024 + 1,
      sha256: "c".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      width: 854,
      height: 480,
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const method = init.method ?? "GET";
    requests.push({ method, url: String(input) });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(snapshot), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { BilibiliClientError, downloadBilibiliVideo } =
    await vite.ssrLoadModule(
      `/lib/client/bilibili-client.ts?analysis-limit=${Date.now()}`,
    );
  await assert.rejects(
    downloadBilibiliVideo("BV1nx411u79K"),
    (error) => {
      assert.ok(error instanceof BilibiliClientError);
      assert.equal(error.code, "VIDEO_TOO_LARGE");
      assert.match(error.message, /500 MB/);
      return true;
    },
  );
  assert.deepEqual(requests.map(({ method }) => method), ["POST", "DELETE"]);
  assert.ok(!requests.some(({ url }) => url === artifactUrl));
});

test("rejects a prepared video without an inline playback URL", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const requests = [];
  const snapshot = {
    jobId: "44444444-4444-4444-8444-444444444444",
    status: "succeeded",
    phase: "ready",
    progress: 1,
    source: {
      bvid: "BV1nx411u79K",
      title: "缺少播放地址的视频",
      durationSeconds: 80,
    },
    artifact: {
      downloadUrl: "https://media.example.com/signed/download.mp4",
      filename: "video.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
      sha256: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
    },
  };

  globalThis.fetch = async (input, init = {}) => {
    requests.push({ method: init.method ?? "GET", url: String(input) });
    if (init.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(snapshot), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { BilibiliClientError, prepareBilibiliVideoDownload } =
    await vite.ssrLoadModule(
      `/lib/client/bilibili-client.ts?missing-playback=${Date.now()}`,
    );
  await assert.rejects(
    prepareBilibiliVideoDownload("BV1nx411u79K"),
    (error) => {
      assert.ok(error instanceof BilibiliClientError);
      assert.equal(error.code, "INVALID_DOWNLOAD_URL");
      return true;
    },
  );
  assert.deepEqual(requests.map(({ method }) => method), ["POST", "DELETE"]);
});

test("returns a trusted low-resolution media job without buffering the video", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const playbackUrl = "https://media.example.com/signed/artifact.mp4?download=0";
  const mediaBytes = new Uint8Array([0, 1, 2, 3, 4]);
  const requests = [];
  const progressUpdates = [];
  const snapshot = {
    jobId: "33333333-3333-4333-8333-333333333333",
    status: "succeeded",
    phase: "ready",
    progress: 1,
    source: {
      bvid: "BV1nx411u79K",
      title: "公开测试视频",
      durationSeconds: 80,
    },
    artifact: {
      playbackUrl,
      downloadUrl: "https://media.example.com/signed/artifact.mp4",
      filename: "公开测试视频.mp4",
      mimeType: "video/mp4",
      sizeBytes: mediaBytes.byteLength,
      sha256: "0".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      width: 480,
      height: 854,
    },
    analysis: {
      mode: "direct",
      audio: null,
      frames: [],
      transcript: {
        status: "pending",
        language: "zh",
        text: "",
        cues: [],
      },
    },
  };

  globalThis.fetch = async (input, init = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    requests.push({
      method,
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(snapshot), {
      status: method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { downloadBilibiliVideo, releaseBilibiliAnalysis } =
    await vite.ssrLoadModule(
    `/lib/client/bilibili-client.ts?successful-job=${Date.now()}`,
  );
  const result = await downloadBilibiliVideo("BV1nx411u79K", {
    directSummaryMaxSeconds: 120,
    onProgress: (update) => progressUpdates.push(update),
  });

  assert.equal(result.title, snapshot.source.title);
  assert.equal(result.durationSeconds, snapshot.source.durationSeconds);
  assert.equal(result.sizeBytes, mediaBytes.byteLength);
  assert.equal(result.width, 480);
  assert.equal(result.height, 854);
  assert.equal(result.context.mediaJobId, snapshot.jobId);
  assert.equal(result.file, undefined);
  await releaseBilibiliAnalysis(result.jobId);
  assert.equal(progressUpdates.at(-1).stage, "preparing");
  assert.equal(progressUpdates.at(-1).progress, 1);
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "DELETE"],
  );
  assert.deepEqual(requests[0].body, {
    bvid: "BV1nx411u79K",
    variant: "analysis",
    directSummaryMaxSeconds: 120,
  });
});

test("uses server-selected keyframes, audio and FunASR subtitles", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const originalFileReader = globalThis.FileReader;
  class TestFileReader {
    async readAsDataURL(blob) {
      const bytes = Buffer.from(await blob.arrayBuffer());
      this.result = `data:${blob.type};base64,${bytes.toString("base64")}`;
      this.onload?.();
    }
  }
  globalThis.FileReader = TestFileReader;
  const requests = [];
  const assetBytes = new Uint8Array([1, 2, 3, 4]);
  const frameUrls = [1, 2, 3].map(
    (index) => `https://media.example.com/analysis-frame-${index}.jpg`,
  );
  const audioUrl = "https://media.example.com/analysis-audio.mp3";
  const snapshot = {
    jobId: "66666666-6666-4666-8666-666666666666",
    status: "succeeded",
    phase: "ready",
    progress: 1,
    source: {
      bvid: "BV1nx411u79K",
      title: "带字幕的视频",
      description: "这是公开视频简介。",
      durationSeconds: 80,
    },
    artifact: {
      playbackUrl: "https://media.example.com/analysis.mp4?download=0",
      downloadUrl: "https://media.example.com/analysis.mp4?download=1",
      filename: "analysis.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      width: 854,
      height: 480,
    },
    analysis: {
      mode: "keyframes",
      audio: {
        url: audioUrl,
        mimeType: "audio/mpeg",
        sizeBytes: assetBytes.byteLength,
      },
      frames: frameUrls.map((url, index) => ({
        url,
        timestampSeconds: index * 12.5,
        score: 0.9 - index * 0.1,
        sizeBytes: assetBytes.byteLength,
      })),
      transcript: {
        status: "ready",
        language: "zh",
        text: "测试字幕。",
        cues: [{ startSeconds: 1, endSeconds: 2, text: "测试字幕。" }],
      },
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const method = init.method ?? "GET";
    const url = String(input);
    requests.push({ method, url });
    if (url === audioUrl || frameUrls.includes(url)) {
      return new Response(assetBytes, {
        status: 200,
        headers: {
          "content-type": url === audioUrl ? "audio/mpeg" : "image/jpeg",
        },
      });
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response(JSON.stringify(snapshot), {
      status: method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalFileReader;
  });

  const { downloadBilibiliVideo, releaseBilibiliAnalysis } =
    await vite.ssrLoadModule(
      `/lib/client/bilibili-client.ts?analysis-evidence=${Date.now()}`,
    );
  const result = await downloadBilibiliVideo("BV1nx411u79K");
  assert.equal(result.description, snapshot.source.description);
  assert.equal(result.context.frameUrls.length, 3);
  assert.deepEqual(result.context.frameTimestamps, [0, 12.5, 25]);
  assert.match(result.context.audioUrl, /^data:audio\/mpeg;base64,/);
  assert.deepEqual(result.transcript, snapshot.analysis.transcript);
  assert.equal(result.file, undefined);
  await releaseBilibiliAnalysis(result.jobId);
  assert.equal(requests.at(-1).method, "DELETE");
});

test("short Bilibili videos go to Qwen first and request FunASR afterward", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const requests = [];
  const snapshot = {
    jobId: "77777777-7777-4777-8777-777777777777",
    status: "succeeded",
    phase: "ready",
    progress: 1,
    source: {
      bvid: "BV1nx411u79K",
      title: "短视频",
      durationSeconds: 120,
    },
    artifact: {
      playbackUrl: "http://127.0.0.1:8788/signed/analysis.mp4?download=0",
      downloadUrl: "http://127.0.0.1:8788/signed/analysis.mp4?download=1",
      filename: "analysis.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1024,
      sha256: "d".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      width: 854,
      height: 480,
    },
    analysis: {
      mode: "direct",
      frames: [],
      transcript: {
        status: "pending",
        language: "zh",
        text: "",
        cues: [],
      },
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({
      method: init.method ?? "GET",
      url,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const responseSnapshot = url.endsWith("/transcript")
      ? {
          ...snapshot,
          analysis: {
            ...snapshot.analysis,
            transcript: {
              status: "ready",
              language: "zh",
              text: "短视频字幕。",
              cues: [
                { startSeconds: 0, endSeconds: 2, text: "短视频字幕。" },
              ],
            },
          },
        }
      : snapshot;
    return new Response(JSON.stringify(responseSnapshot), {
      status: init.method === "POST" ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const {
    downloadBilibiliVideo,
    extractBilibiliTranscript,
    releaseBilibiliAnalysis,
  } =
    await vite.ssrLoadModule(
      `/lib/client/bilibili-client.ts?direct-analysis=${Date.now()}`,
    );
  const result = await downloadBilibiliVideo("BV1nx411u79K", {
    directSummaryMaxSeconds: 360,
  });

  assert.equal(result.analysisMode, "direct");
  assert.deepEqual(result.context, {
    mediaJobId: snapshot.jobId,
    fps: 1,
    durationSeconds: 120,
  });
  assert.equal(result.transcript, undefined);
  assert.equal(result.file, undefined);
  assert.deepEqual(requests[0].body, {
    bvid: "BV1nx411u79K",
    variant: "analysis",
    directSummaryMaxSeconds: 360,
  });
  assert.equal(requests.length, 1);

  const transcript = await extractBilibiliTranscript(result.jobId);
  assert.equal(transcript.status, "ready");
  assert.equal(transcript.text, "短视频字幕。");
  assert.ok(requests.at(-1).url.endsWith("/transcript"));

  await releaseBilibiliAnalysis(result.jobId);
  assert.equal(requests.at(-1).method, "DELETE");
});
