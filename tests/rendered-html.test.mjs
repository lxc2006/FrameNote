import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

async function render() {
  return request("/");
}

async function request(pathname, init, bindings = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, init),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
      ...bindings,
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the FrameNote video workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>帧记 FrameNote｜B站视频 AI 总结<\/title>/i);
  assert.match(html, /让一段视频，变成一次可继续的对话/);
  assert.match(html, /上传视频/);
  assert.match(html, /B站链接/);
  assert.match(html, /视频总结对话/);
  assert.match(html, /正在检查模型/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("exposes Qwen and DeepSeek model status without leaking credentials", async () => {
  const response = await request("/api/model/status");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/i);

  const payload = await response.json();
  assert.equal(payload.provider, "qwen");
  assert.equal(typeof payload.configured, "boolean");
  assert.equal(typeof payload.model, "string");
  assert.deepEqual(payload.acceptedInputs, [
    "video_url",
    "frames",
    "audio",
    "transcript",
  ]);
  assert.equal(payload.conversation.provider, "deepseek");
  assert.equal(payload.conversation.model, "deepseek-v4-pro");
  assert.equal(typeof payload.conversation.configured, "boolean");
  assert.equal("apiKey" in payload, false);
  assert.equal("apiKey" in payload.conversation, false);
});

test("validates model requests before attempting a provider call", async () => {
  const response = await request("/api/model/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 400);

  const payload = await response.json();
  assert.equal(payload.error.code, "INVALID_MODEL_INPUT");
  assert.equal(payload.error.retryable, false);
});

test("validates and proxies Bilibili download jobs without exposing the service token", async (t) => {
  const invalidResponse = await request("/api/bilibili/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bvid: "not-a-bvid" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error.code, "INVALID_BILIBILI_INPUT");

  const unconfiguredResponse = await request("/api/bilibili/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bvid: "BV1nx411u79K" }),
  });
  assert.equal(unconfiguredResponse.status, 503);
  assert.equal(
    (await unconfiguredResponse.json()).error.code,
    "MEDIA_SERVICE_NOT_CONFIGURED",
  );

  const insecureServiceResponse = await request(
    "/api/bilibili/jobs",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bvid: "BV1nx411u79K" }),
    },
    {
      BILIBILI_MEDIA_SERVICE_URL: "http://media.example.com",
      BILIBILI_MEDIA_SERVICE_TOKEN: "must-not-cross-plaintext-http",
    },
  );
  assert.equal(insecureServiceResponse.status, 503);
  assert.equal(
    (await insecureServiceResponse.json()).error.code,
    "MEDIA_SERVICE_NOT_CONFIGURED",
  );

  const jobId = "11111111-1111-4111-8111-111111111111";
  const failedJobId = "22222222-2222-4222-8222-222222222222";
  const upstreamRequests = [];
  const mediaService = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    upstreamRequests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
    });
    const failed = req.url?.endsWith(failedJobId) ?? false;
    const ready = req.method !== "POST" && !failed;
    res.writeHead(req.method === "POST" ? 202 : 200, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify({
      jobId: failed ? failedJobId : jobId,
      status: failed ? "failed" : ready ? "succeeded" : "queued",
      phase: failed ? "downloading" : ready ? "ready" : "queued",
      progress: failed ? 0.08 : ready ? 1 : 0,
      source: {
        bvid: "BV1nx411u79K",
        ...(ready || failed ? { title: "公开测试视频", durationSeconds: 80 } : {}),
      },
      ...(failed ? {
        error: {
          code: "DOWNLOAD_FAILED",
          message: "B 站视频下载失败，请稍后重试。",
          retryable: true,
        },
      } : {}),
      ...(ready ? {
        artifact: {
          downloadUrl: `http://127.0.0.1/media/${jobId}`,
          filename: "BV1nx411u79K.mp4",
          mimeType: "video/mp4",
          sizeBytes: 1024,
          sha256: "0".repeat(64),
          expiresAt: "2099-01-01T00:00:00Z",
        },
      } : {}),
    }));
  });
  mediaService.listen(0, "127.0.0.1");
  await once(mediaService, "listening");
  t.after(() => mediaService.close());
  const address = mediaService.address();
  assert.ok(address && typeof address === "object");
  const bindings = {
    BILIBILI_MEDIA_SERVICE_URL: `http://127.0.0.1:${address.port}`,
    BILIBILI_MEDIA_SERVICE_TOKEN: "media-service-test-token",
  };

  const createResponse = await request(
    "/api/bilibili/jobs",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bvid: "BV1nx411u79K" }),
    },
    bindings,
  );
  assert.equal(createResponse.status, 202);
  assert.equal((await createResponse.json()).jobId, jobId);

  const statusResponse = await request(`/api/bilibili/jobs/${jobId}`, undefined, bindings);
  assert.equal(statusResponse.status, 200);
  const statusPayload = await statusResponse.json();
  assert.equal(statusPayload.status, "succeeded");
  assert.equal(statusPayload.artifact.sizeBytes, 1024);
  assert.equal(JSON.stringify(statusPayload).includes("media-service-test-token"), false);

  const failedResponse = await request(
    `/api/bilibili/jobs/${failedJobId}`,
    undefined,
    bindings,
  );
  assert.equal(failedResponse.status, 200);
  const failedPayload = await failedResponse.json();
  assert.equal(failedPayload.status, "failed");
  assert.equal(failedPayload.error.code, "DOWNLOAD_FAILED");
  assert.match(failedPayload.error.message, /下载失败/);

  const deleteResponse = await request(
    `/api/bilibili/jobs/${jobId}`,
    { method: "DELETE" },
    bindings,
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(
    upstreamRequests.map(({ method }) => method),
    ["POST", "GET", "GET", "DELETE"],
  );
  assert.deepEqual(upstreamRequests[0].body, { bvid: "BV1nx411u79K" });
  assert.ok(upstreamRequests.every(
    ({ authorization }) => authorization === "Bearer media-service-test-token",
  ));
});

test("uses Qwen for analysis and DeepSeek V4 Pro for follow-up answers", async (t) => {
  const providerRequests = [];
  const summary = {
    title: "测试视频",
    overview: "视频解释了如何验证模型接口。",
    keyPoints: [{ title: "接口", detail: "使用兼容模式调用。" }],
    chapters: [{ time: "00:00", title: "开始", description: "介绍测试。" }],
    takeaway: "模型调用链路可用。",
    evidence: [{ time: "00:01", fact: "画面展示了接口测试。" }],
  };
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const providerRequest = {
      authorization: req.headers.authorization,
      url: req.url,
      body: JSON.parse(body),
    };
    providerRequests.push(providerRequest);
    if (providerRequest.body.model === "deepseek-v4-pro") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-deepseek-test",
        object: "chat.completion",
        created: 0,
        model: "deepseek-v4-pro",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "结论：模型调用链路可用。依据见 00:01。",
          },
          finish_reason: "stop",
        }],
      }));
      return;
    }

    const content = `${JSON.stringify(summary)}\n\`\`\``;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-qwen-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "qwen3.5-omni-plus",
      choices: [{
        index: 0,
        delta: { content },
        finish_reason: null,
      }],
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => provider.close());
  const address = provider.address();
  assert.ok(address && typeof address === "object");

  const response = await request(
    "/api/model/analyze",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          kind: "upload",
          title: "测试视频",
          subtitle: "test.mp4",
          downloadFirst: false,
        },
        context: {
          videoUrl: "https://media.example.com/test.mp4",
          fps: 0.5,
        },
      }),
    },
    {
      DASHSCOPE_API_KEY: "local-test-key",
      DASHSCOPE_BASE_URL: `http://127.0.0.1:${address.port}/compatible-mode/v1`,
      QWEN_VIDEO_MODEL: "qwen3.5-omni-plus",
    },
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.summary, summary);
  const providerRequest = providerRequests[0];
  assert.equal(providerRequest.authorization, "Bearer local-test-key");
  assert.equal(providerRequest.url, "/compatible-mode/v1/chat/completions");
  assert.equal(providerRequest.body.stream, true);
  assert.equal(providerRequest.body.response_format.type, "json_object");
  const videoPart = providerRequest.body.messages[1].content[0];
  assert.equal(videoPart.type, "video_url");
  assert.equal(videoPart.video_url.url, "https://media.example.com/test.mp4");
  assert.equal(videoPart.fps, 0.5);

  const extractedMediaResponse = await request(
    "/api/model/analyze",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          kind: "upload",
          title: "本地预处理视频",
          subtitle: "local.mp4",
          downloadFirst: false,
        },
        context: {
          frameUrls: [
            "data:image/jpeg;base64,AAAA",
            "data:image/jpeg;base64,BBBB",
          ],
          frameTimestamps: [0, 12.5],
          audioUrl: "data:audio/mpeg;base64,CCCC",
          audioFormat: "mp3",
        },
      }),
    },
    {
      DASHSCOPE_API_KEY: "local-test-key",
      DASHSCOPE_BASE_URL: `http://127.0.0.1:${address.port}/compatible-mode/v1`,
      QWEN_VIDEO_MODEL: "qwen3.5-omni-plus",
    },
  );
  assert.equal(extractedMediaResponse.status, 200);
  const extractedMediaRequest = providerRequests[1];
  const extractedParts = extractedMediaRequest.body.messages[1].content;
  assert.equal(extractedParts[0].type, "video");
  assert.equal(extractedParts[0].video.length, 2);
  assert.equal(extractedParts[1].type, "input_audio");
  assert.equal(extractedParts[1].input_audio.format, "mp3");
  assert.equal(extractedParts[1].input_audio.data, "data:audio/mpeg;base64,CCCC");
  assert.match(extractedParts[2].text, /第2帧=12\.50秒/);

  const askResponse = await request(
    "/api/model/ask",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "结论是什么？",
        source: {
          kind: "upload",
          title: "测试视频",
          subtitle: "test.mp4",
          downloadFirst: false,
        },
        summary,
        history: [{ role: "user", content: "它讲了什么？" }],
      }),
    },
    {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/deepseek`,
      DEEPSEEK_CHAT_MODEL: "deepseek-v4-pro",
    },
  );
  assert.equal(askResponse.status, 200);
  const askPayload = await askResponse.json();
  assert.equal(askPayload.provider, "deepseek");
  assert.equal(askPayload.model, "deepseek-v4-pro");
  assert.equal(askPayload.answer, "结论：模型调用链路可用。依据见 00:01。");
  assert.equal(providerRequests[2].authorization, "Bearer deepseek-test-key");
  assert.equal(providerRequests[2].url, "/deepseek/chat/completions");
  assert.equal(providerRequests[2].body.stream, false);
  assert.match(providerRequests[2].body.messages.at(-1).content, /结论是什么/);
});

test("removes disposable starter assets and keeps model choice decoupled", async () => {
  const [page, layout, packageJson, engine, workbench, bilibiliClient] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/video-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/VideoWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/bilibili-client.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<VideoWorkbench \/>/);
  assert.match(layout, /lang="zh-CN"/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(engine, /interface VideoEngine/);
  assert.match(engine, /mode: "demo"/);
  assert.match(workbench, /analyzeVideo/);
  assert.match(workbench, /askVideo/);
  assert.match(workbench, /downloadBilibiliVideo/);
  assert.match(workbench, /showDownloadedVideo\(downloaded\.file\)/);
  assert.match(workbench, /aria-label="视频预览与下载"/);
  assert.match(workbench, /download=\{videoPreview\.filename\}/);
  assert.match(workbench, /"下载视频"/);
  assert.match(workbench, /"打开\/下载原视频"/);
  assert.match(bilibiliClient, /\/api\/bilibili\/jobs/);
  assert.doesNotMatch(workbench, /demoVideoEngine/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
});
