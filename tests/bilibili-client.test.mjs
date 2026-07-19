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
      maxHeight: 720,
    });
  }
});

test("returns a complete File that can back preview and manual download", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  const artifactUrl = "https://media.example.com/signed/artifact.mp4";
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
      downloadUrl: artifactUrl,
      filename: "公开测试视频.mp4",
      mimeType: "video/mp4",
      sizeBytes: mediaBytes.byteLength,
      sha256: "0".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      height: 1080,
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
    if (url === artifactUrl) {
      return new Response(mediaBytes, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": String(mediaBytes.byteLength),
        },
      });
    }
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

  const { downloadBilibiliVideo } = await vite.ssrLoadModule(
    `/lib/client/bilibili-client.ts?successful-job=${Date.now()}`,
  );
  const result = await downloadBilibiliVideo("BV1nx411u79K", {
    maxHeight: 1080,
    onProgress: (update) => progressUpdates.push(update),
  });

  assert.equal(result.title, snapshot.source.title);
  assert.equal(result.durationSeconds, snapshot.source.durationSeconds);
  assert.equal(result.sizeBytes, mediaBytes.byteLength);
  assert.equal(result.requestedHeight, 1080);
  assert.equal(result.height, 1080);
  assert.equal(result.file.name, snapshot.artifact.filename);
  assert.equal(result.file.type, snapshot.artifact.mimeType);
  assert.deepEqual(
    new Uint8Array(await result.file.arrayBuffer()),
    mediaBytes,
  );
  assert.equal(progressUpdates.at(-1).stage, "downloading");
  assert.equal(progressUpdates.at(-1).progress, 1);
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "GET", "DELETE"],
  );
  assert.deepEqual(requests[0].body, {
    bvid: "BV1nx411u79K",
    maxHeight: 1080,
  });
});
