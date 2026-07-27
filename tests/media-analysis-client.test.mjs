import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createViteServer } from "vite";

test("uploads a local video to the shared low-resolution analysis pipeline", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const jobId = "99999999-9999-4999-8999-999999999999";
  const snapshot = {
    jobId,
    status: "succeeded",
    phase: "ready",
    progress: 1,
    source: {
      kind: "upload",
      filename: "local.mp4",
      title: "local",
      durationSeconds: 75,
    },
    artifact: {
      playbackUrl: `https://media.example.com/v1/media/jobs/${jobId}/artifact`,
      downloadUrl: `https://media.example.com/v1/media/jobs/${jobId}/artifact?download=1`,
      filename: "local.mp4",
      mimeType: "video/mp4",
      sizeBytes: 4_096,
      sha256: "9".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      width: 854,
      height: 480,
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
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, method: init.method ?? "GET", body: init.body });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const responseSnapshot = url.endsWith("/transcript")
      ? {
          ...snapshot,
          analysis: {
            ...snapshot.analysis,
            transcript: {
              status: "ready",
              language: "zh",
              text: "这是本地视频字幕。",
              cues: [
                {
                  startSeconds: 0,
                  endSeconds: 2.5,
                  text: "这是本地视频字幕。",
                },
              ],
            },
          },
        }
      : snapshot;
    return Response.json(responseSnapshot, {
      status: init.method === "POST" ? 202 : 200,
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const {
    prepareMediaAnalysis,
    extractMediaTranscript,
    releaseMediaAnalysis,
  } = await vite.ssrLoadModule(
    `/lib/client/media-analysis-client.ts?upload=${Date.now()}`,
  );
  const file = new File([new Uint8Array([1, 2, 3])], "local.mp4", {
    type: "video/mp4",
  });
  const result = await prepareMediaAnalysis(file, {
    sourceKind: "upload",
    directSummaryMaxSeconds: 360,
  });

  const form = requests[0].body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("sourceKind"), "upload");
  assert.equal(form.get("directSummaryMaxSeconds"), "360");
  assert.equal(form.get("file").name, "local.mp4");
  assert.deepEqual(result.context, {
    mediaJobId: jobId,
    fps: 1,
    durationSeconds: 75,
  });
  assert.equal(result.analysisMode, "direct");
  assert.equal(result.width, 854);
  assert.equal(result.height, 480);

  const transcript = await extractMediaTranscript(jobId);
  assert.equal(transcript.status, "ready");
  assert.equal(transcript.text, "这是本地视频字幕。");

  await releaseMediaAnalysis(jobId);
  assert.deepEqual(
    requests.map(({ method }) => method),
    ["POST", "POST", "DELETE"],
  );
});

test("explains an entry-layer HTTP 413 instead of blaming the media service", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("Payload Too Large", { status: 413 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { prepareMediaAnalysis } = await vite.ssrLoadModule(
    `/lib/client/media-analysis-client.ts?too-large=${Date.now()}`,
  );
  const file = new File([new Uint8Array([1])], "local.mp4", {
    type: "video/mp4",
  });

  await assert.rejects(
    prepareMediaAnalysis(file, {
      sourceKind: "upload",
      directSummaryMaxSeconds: 360,
    }),
    (error) => {
      assert.equal(error.code, "MEDIA_REQUEST_TOO_LARGE");
      assert.match(error.message, /网站入口拒绝/);
      return true;
    },
  );
});
