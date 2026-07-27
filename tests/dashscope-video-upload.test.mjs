import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createViteServer } from "vite";

test("streams a trusted local Bilibili artifact to DashScope temporary storage", async (t) => {
  const vite = await createViteServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());

  const runtime = await vite.ssrLoadModule("/lib/server/runtime-env.ts");
  runtime.setRuntimeBindings({
    DASHSCOPE_API_KEY: "test-dashscope-key",
    DASHSCOPE_BASE_URL: "https://dashscope.example.com/compatible-mode/v1",
    QWEN_VIDEO_MODEL: "qwen3.5-omni-plus",
    BILIBILI_MEDIA_SERVICE_URL: "http://127.0.0.1:8788",
    BILIBILI_MEDIA_SERVICE_TOKEN: "test-media-token",
  });
  t.after(() => runtime.setRuntimeBindings({}));

  const jobId = "88888888-8888-4888-8888-888888888888";
  const bvid = "BV1nx411u79K";
  const artifactUrl =
    `http://127.0.0.1:8788/v1/bilibili/jobs/${jobId}/artifact?signed=1`;
  const uploadHost = "https://upload.example.com";
  const videoBytes = new Uint8Array([0, 1, 2, 3, 4, 250, 251]);
  const requests = [];
  let uploadedBody = Buffer.alloc(0);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    requests.push({ url, method: init.method ?? "GET", headers });

    if (url === `http://127.0.0.1:8788/v1/bilibili/jobs/${jobId}`) {
      assert.equal(headers.get("authorization"), "Bearer test-media-token");
      return Response.json({
        jobId,
        status: "succeeded",
        source: { kind: "bilibili", bvid, durationSeconds: 120 },
        artifact: {
          playbackUrl: artifactUrl,
          filename: "短视频.mp4",
          mimeType: "video/mp4",
          sizeBytes: videoBytes.byteLength,
        },
      });
    }

    if (
      url ===
      "https://dashscope.example.com/api/v1/uploads?action=getPolicy&model=qwen3.5-omni-plus"
    ) {
      assert.equal(headers.get("authorization"), "Bearer test-dashscope-key");
      return Response.json({
        data: {
          policy: "encoded-policy",
          signature: "signature",
          upload_dir: "framenote-tests",
          upload_host: uploadHost,
          max_file_size_mb: 500,
          oss_access_key_id: "access-key-id",
          x_oss_object_acl: "private",
          x_oss_forbid_overwrite: "true",
        },
      });
    }

    if (url === artifactUrl) {
      return new Response(videoBytes, {
        headers: {
          "content-type": "video/mp4",
          "content-length": String(videoBytes.byteLength),
        },
      });
    }

    if (url === uploadHost) {
      uploadedBody = Buffer.from(
        await new Response(init.body).arrayBuffer(),
      );
      assert.equal(
        Number(headers.get("content-length")),
        uploadedBody.byteLength,
      );
      return new Response(null, { status: 200 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { resolveQwenVideoContext } = await vite.ssrLoadModule(
    `/lib/server/dashscope-video-upload.ts?upload=${Date.now()}`,
  );
  const context = await resolveQwenVideoContext(
    {
      kind: "bilibili",
      bvid,
      title: "短视频",
      subtitle: "B站视频",
    },
    {
      mediaJobId: jobId,
      durationSeconds: 120,
      fps: 1,
    },
  );

  assert.deepEqual(context, {
    videoUrl: `oss://framenote-tests/${jobId}.mp4`,
    durationSeconds: 120,
    fps: 1,
  });
  assert.equal(requests.map(({ method }) => method).join(","), "GET,GET,GET,POST");
  assert.ok(uploadedBody.includes(Buffer.from("name=\"file\"")));
  assert.ok(uploadedBody.includes(Buffer.from(videoBytes)));
});
