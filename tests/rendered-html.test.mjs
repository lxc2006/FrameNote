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

function normalizeSql(sql) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function successfulD1Result(changes = 1) {
  return {
    success: true,
    meta: { changes },
    results: [],
  };
}

class FakeD1PreparedStatement {
  constructor(database, sql, parameters = []) {
    this.database = database;
    this.sql = sql;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new FakeD1PreparedStatement(this.database, this.sql, parameters);
  }

  async all() {
    return {
      success: true,
      meta: {},
      results: this.database.select(this.sql, this.parameters),
    };
  }

  async first(column) {
    const row = this.database.select(this.sql, this.parameters)[0] ?? null;
    if (column === undefined || row === null) return row;
    return row[column] ?? null;
  }

  async run() {
    return this.database.mutate(this.sql, this.parameters);
  }
}

class FakeD1Database {
  constructor() {
    this.conversations = new Map();
    this.messages = [];
    this.schemaStatements = [];
  }

  prepare(sql) {
    return new FakeD1PreparedStatement(this, sql);
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  select(sql, parameters) {
    const query = normalizeSql(sql);

    if (
      query.startsWith(
        "select id, title, source_kind, created_at, updated_at from conversations where owner_id = ? order by",
      )
    ) {
      const [ownerId] = parameters;
      return [...this.conversations.values()]
        .filter((conversation) => conversation.owner_id === ownerId)
        .sort(
          (left, right) =>
            right.updated_at - left.updated_at || right.id.localeCompare(left.id),
        )
        .map(({ id, title, source_kind, created_at, updated_at }) => ({
          id,
          title,
          source_kind,
          created_at,
          updated_at,
        }));
    }

    if (
      query.startsWith(
        "select id, title, source_kind, source_json, summary_json, active_model, created_at, updated_at from conversations where id = ? and owner_id = ?",
      )
    ) {
      const [id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      return conversation?.owner_id === ownerId ? [{ ...conversation }] : [];
    }

    if (
      query.startsWith(
        "select id, role, content, created_at from conversation_messages where conversation_id = ? order by sequence asc",
      )
    ) {
      const [conversationId] = parameters;
      return this.messages
        .filter((message) => message.conversation_id === conversationId)
        .sort((left, right) => left.sequence - right.sequence)
        .map(({ id, role, content, created_at }) => ({
          id,
          role,
          content,
          created_at,
        }));
    }

    if (
      query.startsWith(
        "select coalesce(max(sequence), -1) + 1 as next_sequence from conversation_messages where conversation_id = ?",
      )
    ) {
      const [conversationId] = parameters;
      const next_sequence =
        this.messages
          .filter((message) => message.conversation_id === conversationId)
          .reduce((maximum, message) => Math.max(maximum, message.sequence), -1) + 1;
      return [{ next_sequence }];
    }

    if (
      query ===
      "select id from conversations where id = ? and owner_id = ?"
    ) {
      const [id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      return conversation?.owner_id === ownerId ? [{ id }] : [];
    }

    if (
      query.startsWith(
        "select id, title, source_kind, created_at, updated_at from conversations where id = ? and owner_id = ?",
      )
    ) {
      const [id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      if (conversation?.owner_id !== ownerId) return [];
      const { title, source_kind, created_at, updated_at } = conversation;
      return [{ id, title, source_kind, created_at, updated_at }];
    }

    throw new Error(`Fake D1 does not support SELECT: ${query}`);
  }

  mutate(sql, parameters) {
    const query = normalizeSql(sql);

    if (
      query.startsWith("create table if not exists") ||
      query.startsWith("create index if not exists") ||
      query.startsWith("create unique index if not exists")
    ) {
      this.schemaStatements.push(query);
      return successfulD1Result(0);
    }

    if (query.startsWith("insert into conversations")) {
      const [
        id,
        owner_id,
        title,
        source_kind,
        source_json,
        summary_json,
        active_model,
        created_at,
        updated_at,
      ] = parameters;
      this.conversations.set(id, {
        id,
        owner_id,
        title,
        source_kind,
        source_json,
        summary_json,
        active_model,
        created_at,
        updated_at,
      });
      return successfulD1Result();
    }

    if (
      query.startsWith("insert into conversation_messages") &&
      query.includes("values (?, ?, ?, ?, ?, ?)")
    ) {
      const [id, conversation_id, sequence, role, content, created_at] = parameters;
      this.messages.push({
        id,
        conversation_id,
        sequence,
        role,
        content,
        created_at,
      });
      return successfulD1Result();
    }

    if (
      query.startsWith("insert into conversation_messages") &&
      query.includes("coalesce(max(sequence), -1) + 1")
    ) {
      const [id, conversation_id, role, content, created_at, scopedConversationId] =
        parameters;
      assert.equal(conversation_id, scopedConversationId);
      const sequence = this.messages
        .filter((message) => message.conversation_id === conversation_id)
        .reduce((maximum, message) => Math.max(maximum, message.sequence), -1) + 1;
      this.messages.push({
        id,
        conversation_id,
        sequence,
        role,
        content,
        created_at,
      });
      return successfulD1Result();
    }

    if (
      query.startsWith(
        "update conversations set title = ?, updated_at = ? where id = ? and owner_id = ?",
      )
    ) {
      const [title, updatedAt, id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      if (conversation?.owner_id !== ownerId) return successfulD1Result(0);
      conversation.title = title;
      conversation.updated_at = updatedAt;
      return successfulD1Result();
    }

    if (
      query.startsWith(
        "update conversations set updated_at = ? where id = ? and owner_id = ?",
      )
    ) {
      const [updatedAt, id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      if (conversation?.owner_id !== ownerId) return successfulD1Result(0);
      conversation.updated_at = updatedAt;
      return successfulD1Result();
    }

    if (query.startsWith("delete from conversation_messages where conversation_id in")) {
      const [id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      if (conversation?.owner_id !== ownerId) return successfulD1Result(0);
      const before = this.messages.length;
      this.messages = this.messages.filter(
        (message) => message.conversation_id !== id,
      );
      return successfulD1Result(before - this.messages.length);
    }

    if (
      query === "delete from conversations where id = ? and owner_id = ?"
    ) {
      const [id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      if (conversation?.owner_id !== ownerId) return successfulD1Result(0);
      this.conversations.delete(id);
      return successfulD1Result();
    }

    throw new Error(`Fake D1 does not support mutation: ${query}`);
  }
}

function assertAudioAnalysisPrompt(providerRequest) {
  const prompt = JSON.stringify(providerRequest.body.messages);
  assert.match(prompt, /audioAnalysis/);
  assert.match(prompt, /声音|音轨/);
  assert.match(prompt, /音乐/);
  assert.match(prompt, /环境声/);
  assert.match(prompt, /随时间|时间变化|时间演变/);
}

test("server-renders the FrameNote video workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>帧记 FrameNote｜B站视频 AI 总结<\/title>/i);
  assert.match(
    html,
    /<header class="topbar">[\s\S]*<h1 class="topbar-title">让一段视频，变成一次可继续的对话。<\/h1>[\s\S]*设置[\s\S]*<\/header>/,
  );
  assert.doesNotMatch(html, /新建任务/);
  assert.equal((html.match(/<h1\b/gi) ?? []).length, 1);
  assert.match(html, /上传视频/);
  assert.match(html, /B站链接/);
  assert.match(html, /设置/);
  assert.match(html, /视频对话/);
  assert.match(html, /新建/);
  assert.match(html, /视频总结对话/);
  assert.doesNotMatch(html, /architecture-note/);
  assert.doesNotMatch(html, /Qwen 视频理解 \+ DeepSeek V4 Pro 对话/);
  assert.doesNotMatch(
    html,
    /完成左侧设置后，你会先得到一份带章节的总结，然后可以像聊天一样继续追问。/,
  );
  assert.doesNotMatch(html, /VIDEO INTELLIGENCE|正在检查模型/);
  assert.doesNotMatch(
    html,
    /上传本地视频、粘贴 B站公开视频或 HTTPS 视频直链/,
  );
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("persists owner-scoped video conversations through their D1 lifecycle", async () => {
  const database = new FakeD1Database();
  const ownerHeaders = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "Viewer@Example.com",
  };
  const otherOwnerHeaders = {
    "oai-authenticated-user-email": "someone-else@example.com",
  };
  const source = {
    kind: "upload",
    title: "站台 Lofi",
    subtitle: "station-lofi.mp4 · 7:00",
    durationLabel: "07:00",
    downloadFirst: false,
  };
  const summary = {
    title: "站台 Lofi 总结",
    overview: "画面与舒缓音乐共同营造出安静的站台氛围。",
    keyPoints: [
      {
        title: "稳定氛围",
        detail: "视觉主体与低保真音乐共同保持平静节奏。",
      },
    ],
    chapters: [
      {
        time: "00:00",
        title: "开场",
        description: "站台画面与音乐同步出现。",
      },
    ],
    takeaway: "这是一段以画面和音乐共同塑造氛围的视频。",
    evidence: [],
    audioAnalysis: {
      status: "analyzed",
      summary: "舒缓的低保真音乐贯穿全片。",
      speech: null,
      music: "节奏平稳的低保真爵士乐。",
      soundscape: "轻微的站台环境声。",
      temporalChanges: [
        {
          time: "03:30",
          description: "中段鼓点略微增强。",
        },
      ],
    },
  };

  const createResponse = await request(
    "/api/conversations",
    {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        source,
        summary,
        messages: [
          {
            role: "assistant",
            content: "总结已经生成，可以继续追问。",
          },
        ],
        activeModel: "qwen3.5-omni-plus",
      }),
    },
    { DB: database },
  );
  assert.equal(createResponse.status, 201);
  assert.match(createResponse.headers.get("cache-control") ?? "", /no-store/i);
  const created = (await createResponse.json()).conversation;
  assert.match(
    created.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(created.title, source.title);
  assert.deepEqual(created.source, source);
  assert.deepEqual(created.summary, summary);
  assert.equal(created.messages.length, 1);
  assert.equal(created.activeModel, "qwen3.5-omni-plus");
  assert.equal(new Set(database.schemaStatements).size, 4);
  assert.ok(
    database.schemaStatements.every((statement) =>
      statement.includes("if not exists"),
    ),
  );

  const listResponse = await request(
    "/api/conversations",
    { headers: { "oai-authenticated-user-email": "viewer@example.com" } },
    { DB: database },
  );
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).conversations;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].sourceKind, "upload");

  const detailResponse = await request(
    `/api/conversations/${created.id}`,
    { headers: { "oai-authenticated-user-email": "viewer@example.com" } },
    { DB: database },
  );
  assert.equal(detailResponse.status, 200);
  const detail = (await detailResponse.json()).conversation;
  assert.deepEqual(detail.source, source);
  assert.deepEqual(detail.summary, summary);
  assert.deepEqual(
    detail.messages.map(({ role, content }) => ({ role, content })),
    [{ role: "assistant", content: "总结已经生成，可以继续追问。" }],
  );

  const appendResponse = await request(
    `/api/conversations/${created.id}/messages`,
    {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        messages: [
          { role: "user", content: "音乐在中段有什么变化？" },
          { role: "assistant", content: "中段鼓点略微增强，但整体仍然舒缓。" },
        ],
      }),
    },
    { DB: database },
  );
  assert.equal(appendResponse.status, 201);
  assert.equal((await appendResponse.json()).messages.length, 2);

  const detailAfterAppendResponse = await request(
    `/api/conversations/${created.id}`,
    { headers: { "oai-authenticated-user-email": "viewer@example.com" } },
    { DB: database },
  );
  const detailAfterAppend = (await detailAfterAppendResponse.json()).conversation;
  assert.deepEqual(
    detailAfterAppend.messages.map(({ role, content }) => ({ role, content })),
    [
      { role: "assistant", content: "总结已经生成，可以继续追问。" },
      { role: "user", content: "音乐在中段有什么变化？" },
      { role: "assistant", content: "中段鼓点略微增强，但整体仍然舒缓。" },
    ],
  );

  const renameResponse = await request(
    `/api/conversations/${created.id}`,
    {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ title: "夜间站台音乐分析" }),
    },
    { DB: database },
  );
  assert.equal(renameResponse.status, 200);
  assert.equal((await renameResponse.json()).conversation.title, "夜间站台音乐分析");

  const crossOwnerResponse = await request(
    `/api/conversations/${created.id}`,
    { headers: otherOwnerHeaders },
    { DB: database },
  );
  assert.equal(crossOwnerResponse.status, 404);
  assert.equal(
    (await crossOwnerResponse.json()).error.code,
    "CONVERSATION_NOT_FOUND",
  );

  const deleteResponse = await request(
    `/api/conversations/${created.id}`,
    {
      method: "DELETE",
      headers: { "oai-authenticated-user-email": "viewer@example.com" },
    },
    { DB: database },
  );
  assert.equal(deleteResponse.status, 204);

  const missingResponse = await request(
    `/api/conversations/${created.id}`,
    { headers: { "oai-authenticated-user-email": "viewer@example.com" } },
    { DB: database },
  );
  assert.equal(missingResponse.status, 404);

  const emptyListResponse = await request(
    "/api/conversations",
    { headers: { "oai-authenticated-user-email": "viewer@example.com" } },
    { DB: database },
  );
  assert.deepEqual((await emptyListResponse.json()).conversations, []);
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
    audioAnalysis: {
      status: "analyzed",
      summary: "低保真爵士乐与站台环境声共同营造出安静的夜间氛围。",
      speech: null,
      music: "持续的低保真爵士乐，节奏舒缓。",
      soundscape: "能够听到轻微的列车站台环境声。",
      temporalChanges: [{
        time: "00:12",
        description: "鼓点逐渐清晰，整体音量略有提升。",
      }],
      uncertainty: "无法仅凭当前素材确认具体曲名或艺人。",
    },
  };
  const summaryWithoutAudioAnalysis = { ...summary };
  delete summaryWithoutAudioAnalysis.audioAnalysis;
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

    const responseSummary = JSON.stringify(providerRequest.body.messages).includes(
      "缺少声音分析字段",
    )
      ? summaryWithoutAudioAnalysis
      : summary;
    const content = `${JSON.stringify(responseSummary)}\n\`\`\``;
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
          kind: "url",
          title: "测试视频",
          subtitle: "HTTPS 视频直链",
          sourceUrl: "https://media.example.com/test.mp4",
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
  assertAudioAnalysisPrompt(providerRequest);

  const extractedMediaResponse = await request(
    "/api/model/analyze",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          kind: "bilibili",
          title: "B站预处理视频",
          subtitle: "BV1nx411u79K",
          bvid: "BV1nx411u79K",
          sourceUrl: "https://www.bilibili.com/video/BV1nx411u79K",
          downloadFirst: true,
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
  const extractedMediaPayload = await extractedMediaResponse.json();
  assert.deepEqual(extractedMediaPayload.summary.audioAnalysis, summary.audioAnalysis);
  const extractedMediaRequest = providerRequests[1];
  const extractedParts = extractedMediaRequest.body.messages[1].content;
  assert.equal(extractedParts[0].type, "video");
  assert.equal(extractedParts[0].video.length, 2);
  assert.equal(extractedParts[1].type, "input_audio");
  assert.equal(extractedParts[1].input_audio.format, "mp3");
  assert.equal(extractedParts[1].input_audio.data, "data:audio/mpeg;base64,CCCC");
  assert.match(extractedParts[2].text, /第2帧=12\.50秒/);
  assertAudioAnalysisPrompt(extractedMediaRequest);

  const providerRequestCountBeforeMissingBvAudio = providerRequests.length;
  const missingBvAudioResponse = await request(
    "/api/model/analyze",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          kind: "bilibili",
          title: "缺少音轨的 B 站视频",
          subtitle: "BV1nx411u79K",
          bvid: "BV1nx411u79K",
          downloadFirst: true,
        },
        context: {
          frameUrls: ["data:image/jpeg;base64,AAAA"],
          frameTimestamps: [0],
        },
      }),
    },
    {
      DASHSCOPE_API_KEY: "local-test-key",
      DASHSCOPE_BASE_URL: `http://127.0.0.1:${address.port}/compatible-mode/v1`,
      QWEN_VIDEO_MODEL: "qwen3.5-omni-plus",
    },
  );
  assert.equal(missingBvAudioResponse.status, 400);
  const missingBvAudioPayload = await missingBvAudioResponse.json();
  assert.equal(missingBvAudioPayload.error.code, "INVALID_MODEL_INPUT");
  assert.match(missingBvAudioPayload.error.message, /音轨|音频|audioUrl/i);
  assert.equal(providerRequests.length, providerRequestCountBeforeMissingBvAudio);

  const incompleteSummaryResponse = await request(
    "/api/model/analyze",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: {
          kind: "url",
          title: "缺少声音分析字段",
          subtitle: "HTTPS 视频直链",
          sourceUrl: "https://media.example.com/incomplete.mp4",
          downloadFirst: false,
        },
        context: {
          videoUrl: "https://media.example.com/incomplete.mp4",
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
  assert.equal(incompleteSummaryResponse.status, 502);
  assert.equal(
    (await incompleteSummaryResponse.json()).error.code,
    "INVALID_MODEL_RESPONSE",
  );

  const askProviderRequestIndex = providerRequests.length;
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
  const askProviderRequest = providerRequests[askProviderRequestIndex];
  assert.equal(askProviderRequest.authorization, "Bearer deepseek-test-key");
  assert.equal(askProviderRequest.url, "/deepseek/chat/completions");
  assert.equal(askProviderRequest.body.stream, false);
  const askPrompt = askProviderRequest.body.messages.at(-1).content;
  assert.match(askPrompt, /结论是什么/);
  assert.match(askPrompt, /audioAnalysis/);
  assert.match(askPrompt, /低保真爵士乐/);

  const legacyAskResponse = await request(
    "/api/model/ask",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "旧总结还能继续问吗？",
        source: {
          kind: "upload",
          title: "旧版测试视频",
          subtitle: "legacy.mp4",
          downloadFirst: false,
        },
        summary: summaryWithoutAudioAnalysis,
      }),
    },
    {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/deepseek`,
      DEEPSEEK_CHAT_MODEL: "deepseek-v4-pro",
    },
  );
  assert.equal(legacyAskResponse.status, 200);
});

test("removes disposable starter assets and keeps model choice decoupled", async () => {
  const [
    page,
    layout,
    packageJson,
    engine,
    workbench,
    bilibiliClient,
    conversationClient,
    settingsMenu,
    styles,
    hostingJson,
    databaseSchema,
    databaseMigration,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/video-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/VideoWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/bilibili-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/conversation-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/UserSettingsMenu.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_first_darkhawk.sql", import.meta.url), "utf8"),
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
  assert.match(workbench, /requireAudio:\s*true/);
  assert.match(workbench, /声音与音乐/);
  assert.doesNotMatch(
    workbench,
    /engine-badge|VIDEO INTELLIGENCE|intro-block|setup-title|architecture-note|getModelStatus|ModelStatusResponse/,
  );
  assert.doesNotMatch(workbench, /Qwen 视频理解 \+ DeepSeek V4 Pro 对话/);
  assert.doesNotMatch(
    workbench,
    /完成左侧设置后，你会先得到一份带章节的总结，然后可以像聊天一样继续追问。/,
  );
  assert.match(workbench, /aria-label="视频预览与下载"/);
  assert.match(workbench, /download=\{videoPreview\.filename\}/);
  assert.match(workbench, /"下载视频"/);
  assert.match(workbench, /"打开\/下载原视频"/);
  assert.match(bilibiliClient, /\/api\/bilibili\/jobs/);
  for (const clientOperation of [
    "listConversations",
    "createConversation",
    "getConversation",
    "renameConversation",
    "deleteConversation",
    "appendConversationMessages",
  ]) {
    assert.match(conversationClient, new RegExp(`function ${clientOperation}\\b`));
    assert.match(workbench, new RegExp(`\\b${clientOperation}\\b`));
  }
  assert.match(settingsMenu, /localStorage\.getItem/);
  assert.match(settingsMenu, /localStorage\.setItem/);
  assert.match(settingsMenu, /root\.dataset\.theme/);
  assert.match(settingsMenu, /uiFontSize:\s*DEFAULT_FONT_SIZE/);
  assert.match(settingsMenu, /textFontSize:\s*DEFAULT_FONT_SIZE/);
  assert.match(settingsMenu, /DEFAULT_FONT_SIZE\s*=\s*16/);
  assert.match(settingsMenu, /value="youyuan">幼圆/);
  assert.match(settingsMenu, /value="kaiti">楷体/);
  assert.match(settingsMenu, /value="microsoft-yahei">微软雅黑/);
  assert.match(settingsMenu, /value="consolas">Consolas/);
  assert.match(settingsMenu, /type="number"/);
  assert.match(settingsMenu, /--ui-font-size/);
  assert.match(settingsMenu, /--text-font-size/);
  assert.match(styles, /html\[data-theme="dark"\]/);
  assert.match(styles, /--ui-font-zh:/);
  assert.match(styles, /--ui-font-en:/);
  assert.match(styles, /--text-font-zh:/);
  assert.match(styles, /--text-font-en:/);
  assert.match(styles, /html\[data-theme="dark"\] \.primary-action/);
  assert.doesNotMatch(workbench, /new-task-button|新建任务/);
  assert.doesNotMatch(workbench, /download-option|switch-wrap|下载公开视频，再进行总结/);
  assert.match(styles, /\.conversation-library\s*\{[^}]*display:\s*flex/s);
  assert.match(styles, /\.conversation-list\s*\{[^}]*flex:\s*1/s);
  assert.equal(JSON.parse(hostingJson).d1, "DB");
  assert.match(databaseSchema, /sqliteTable\(\s*"conversations"/);
  assert.match(databaseSchema, /sqliteTable\(\s*"conversation_messages"/);
  assert.match(databaseSchema, /conversations_owner_updated_idx/);
  assert.match(databaseSchema, /conversation_messages_sequence_idx/);
  assert.match(databaseMigration, /CREATE TABLE `conversations`/);
  assert.match(databaseMigration, /CREATE TABLE `conversation_messages`/);
  assert.doesNotMatch(workbench, /demoVideoEngine/);

  await assert.rejects(
    access(new URL("../app/_sites-preview/SkeletonPreview.tsx", import.meta.url)),
  );
});
