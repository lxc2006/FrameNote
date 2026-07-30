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

async function readSseEvents(response) {
  const text = await response.text();
  return text
    .split(/\r?\n\r?\n/)
    .map((frame) =>
      frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n"),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

async function readAskStream(response) {
  const events = await readSseEvents(response);
  const error = events.find((event) => event.type === "error");
  assert.equal(error, undefined, JSON.stringify(error));
  const done = events.findLast((event) => event.type === "done");
  assert.ok(done, `Missing done event: ${JSON.stringify(events)}`);
  return { events, done };
}

function writeOpenAiChatStream(
  response,
  { content, model, reasoningContent = "", usage },
) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (reasoningContent) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-test-stream",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [{
        index: 0,
        delta: { reasoning_content: reasoningContent },
        finish_reason: null,
      }],
    })}\n\n`);
  }
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-test-stream",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: null,
    }],
  })}\n\n`);
  if (usage) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-test-stream",
      object: "chat.completion.chunk",
      created: 0,
      model,
      choices: [],
      usage,
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
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
    this.messageDetails = new Map();
    this.transcripts = new Map();
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
        "select message_id, reasoning_content, reasoning_duration_seconds, web_sources_json, usage_json, stopped from conversation_message_details where conversation_id = ?",
      )
    ) {
      const [conversationId] = parameters;
      return [...this.messageDetails.values()]
        .filter((detail) => detail.conversation_id === conversationId)
        .map((detail) => ({ ...detail }));
    }

    if (
      query ===
      "select transcript_json from conversation_transcripts where conversation_id = ?"
    ) {
      const [conversationId] = parameters;
      const transcript_json = this.transcripts.get(conversationId);
      return transcript_json ? [{ transcript_json }] : [];
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
      query ===
      "select sequence from conversation_messages where id = ? and conversation_id = ?"
    ) {
      const [id, conversationId] = parameters;
      const message = this.messages.find(
        (candidate) =>
          candidate.id === id &&
          candidate.conversation_id === conversationId,
      );
      return message ? [{ sequence: message.sequence }] : [];
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

    if (query.startsWith("insert into conversation_transcripts")) {
      const [conversationId, transcriptJson] = parameters;
      this.transcripts.set(conversationId, transcriptJson);
      return successfulD1Result();
    }

    if (query.startsWith("insert into conversation_message_details")) {
      const [
        message_id,
        conversation_id,
        reasoning_content,
        reasoning_duration_seconds,
        web_sources_json,
        usage_json,
        stopped,
      ] = parameters;
      this.messageDetails.set(message_id, {
        message_id,
        conversation_id,
        reasoning_content,
        reasoning_duration_seconds,
        web_sources_json,
        usage_json,
        stopped,
      });
      return successfulD1Result();
    }
    if (query.startsWith("delete from conversation_message_details where conversation_id in")) {
      const [id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      if (conversation?.owner_id !== ownerId) return successfulD1Result(0);
      let changes = 0;
      for (const [messageId, detail] of this.messageDetails) {
        if (detail.conversation_id === id) {
          this.messageDetails.delete(messageId);
          changes += 1;
        }
      }
      return successfulD1Result(changes);
    }

    if (
      query.startsWith(
        "delete from conversation_message_details where conversation_id = ? and message_id in",
      )
    ) {
      const [conversationId, scopedConversationId, sequence] = parameters;
      assert.equal(conversationId, scopedConversationId);
      const removedIds = new Set(
        this.messages
          .filter(
            (message) =>
              message.conversation_id === conversationId &&
              message.sequence >= sequence,
          )
          .map((message) => message.id),
      );
      let changes = 0;
      for (const messageId of removedIds) {
        if (this.messageDetails.delete(messageId)) changes += 1;
      }
      return successfulD1Result(changes);
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
      query ===
      "delete from conversation_messages where conversation_id = ? and sequence >= ?"
    ) {
      const [conversationId, sequence] = parameters;
      const before = this.messages.length;
      this.messages = this.messages.filter(
        (message) =>
          message.conversation_id !== conversationId ||
          message.sequence < sequence,
      );
      return successfulD1Result(before - this.messages.length);
    }

    if (query.startsWith("delete from conversation_transcripts where conversation_id in")) {
      const [id, ownerId] = parameters;
      const conversation = this.conversations.get(id);
      if (conversation?.owner_id !== ownerId) return successfulD1Result(0);
      return successfulD1Result(this.transcripts.delete(id) ? 1 : 0);
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
  assert.match(prompt, /内容概览/);
  assert.match(prompt, /keyPoints[\s\S]*time/);
  assert.match(prompt, /不要单独写|空泛/);
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
  assert.match(html, /aria-label="隐藏侧边栏"/);
  assert.match(html, /aria-label="隐藏导入板块"/);
  assert.match(html, /aria-label="隐藏记录板块"/);
  assert.doesNotMatch(html, /视频总结对话/);
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
  };
  const legacySource = {
    ...source,
    downloadFirst: false,
    persistedVideo: {
      filename: "station-lofi.mp4",
      mimeType: "video/mp4",
      sizeBytes: 6,
      description: "旧版随对话保存的视频。",
    },
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
  const transcript = {
    status: "ready",
    language: "zh",
    text: "列车即将到站。",
    cues: [
      {
        startSeconds: 12.5,
        endSeconds: 14.2,
        text: "列车即将到站。",
      },
    ],
  };

  const createResponse = await request(
    "/api/conversations",
    {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        source: legacySource,
        summary,
        messages: [
          {
            role: "assistant",
            content:
              "总结已经生成，可以继续追问。\n\n参考来源：\n- [1 · 旧版来源](https://example.com/legacy)\n\n访问了 1 个网页",
          },
        ],
        activeModel: "qwen3.5-omni-plus",
        transcript,
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
  assert.deepEqual(created.transcript, transcript);
  assert.equal(new Set(database.schemaStatements).size, 6);
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
  assert.deepEqual(detail.transcript, transcript);
  assert.deepEqual(
    detail.messages.map(({ role, content }) => ({ role, content })),
    [{ role: "assistant", content: "总结已经生成，可以继续追问。" }],
  );
  assert.deepEqual(detail.messages[0].webSources, [{
    index: 1,
    title: "旧版来源",
    url: "https://example.com/legacy",
  }]);

  const replacementTranscript = {
    status: "unavailable",
    language: "auto",
    text: "",
    cues: [],
    error: "字幕提取超过 22 分钟，暂不可用。",
  };
  const transcriptResponse = await request(
    `/api/conversations/${created.id}/transcript`,
    {
      method: "PUT",
      headers: ownerHeaders,
      body: JSON.stringify({ transcript: replacementTranscript }),
    },
    { DB: database },
  );
  assert.equal(transcriptResponse.status, 200);
  assert.deepEqual(
    (await transcriptResponse.json()).transcript,
    replacementTranscript,
  );

  const appendResponse = await request(
    `/api/conversations/${created.id}/messages`,
    {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        messages: [
          { role: "user", content: "音乐在中段有什么变化？" },
          {
            role: "assistant",
            content: "中段鼓点略微增强，但整体仍然舒缓。[1](https://example.com/music)",
            reasoningContent: "先核对音轨摘要，再组织回答。",
            reasoningDurationSeconds: 3,
            webSources: [{
              index: 1,
              title: "音乐资料",
              url: "https://example.com/music",
            }],
            stopped: true,
          },
        ],
      }),
    },
    { DB: database },
  );
  assert.equal(appendResponse.status, 201);
  const appendedMessages = (await appendResponse.json()).messages;
  assert.equal(appendedMessages.length, 2);

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
      {
        role: "assistant",
        content: "中段鼓点略微增强，但整体仍然舒缓。[1](https://example.com/music)",
      },
    ],
  );
  const detailedMessage = detailAfterAppend.messages.at(-1);
  assert.equal(detailedMessage.reasoningContent, "先核对音轨摘要，再组织回答。");
  assert.equal(detailedMessage.reasoningDurationSeconds, 3);
  assert.equal(detailedMessage.webSources[0].title, "音乐资料");
  assert.equal(detailedMessage.stopped, true);

  const truncateResponse = await request(
    `/api/conversations/${created.id}/messages`,
    {
      method: "DELETE",
      headers: ownerHeaders,
      body: JSON.stringify({ fromMessageId: appendedMessages[0].id }),
    },
    { DB: database },
  );
  assert.equal(truncateResponse.status, 204);
  const detailAfterTruncateResponse = await request(
    `/api/conversations/${created.id}`,
    { headers: { "oai-authenticated-user-email": "viewer@example.com" } },
    { DB: database },
  );
  const detailAfterTruncate =
    (await detailAfterTruncateResponse.json()).conversation;
  assert.deepEqual(
    detailAfterTruncate.messages.map(({ role, content }) => ({
      role,
      content,
    })),
    [{ role: "assistant", content: "总结已经生成，可以继续追问。" }],
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
  assert.equal(database.transcripts.size, 0);

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

test("recalls stored transcript evidence on demand and returns a persistent video time", async (t) => {
  const database = new FakeD1Database();
  const ownerHeaders = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "viewer@example.com",
  };
  const modelRequests = [];
  const provider = createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;
    const body = JSON.parse(rawBody);
    modelRequests.push(body);
    const systemPrompt = body.messages[0]?.content ?? "";
    let content;
    if (systemPrompt.includes("视频回顾规划器")) {
      content = JSON.stringify({
        targets: ["summary", "transcript"],
        query: "列车 到站",
        reason: "用户要求定位视频中的具体内容。",
        timeRange: { startSeconds: 0, endSeconds: 60 },
        fullReview: false,
      });
    } else if (systemPrompt.includes("视频证据重排器")) {
      const input = JSON.parse(body.messages[1].content);
      content = JSON.stringify({
        selected: input.candidates
          .filter((candidate) => candidate.source === "transcript")
          .slice(0, 1)
          .map((candidate) => ({ id: candidate.id, relevance: 0.99 })),
      });
    } else {
      content = "视频在 00:12 提到列车即将到站。";
    }
    if (body.stream) {
      writeOpenAiChatStream(res, { content, model: body.model });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-recall-test",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [{
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      }],
    }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  t.after(() => provider.close());
  const address = provider.address();
  assert.ok(address && typeof address === "object");

  const createResponse = await request(
    "/api/conversations",
    {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        source: {
          kind: "upload",
          title: "站台",
          subtitle: "station.mp4",
          durationLabel: "01:00",
        },
        summary: {
          title: "站台视频",
          overview: "视频记录了站台广播和列车到站。",
          keyPoints: [{
            time: "00:12",
            title: "到站广播",
            detail: "广播提醒乘客注意站台安全。",
          }],
          chapters: [{
            time: "00:00",
            title: "站台等待",
            description: "乘客在站台等待列车。",
          }],
        },
        messages: [{
          role: "assistant",
          content: "总结生成完毕。",
        }],
        transcript: {
          status: "ready",
          language: "zh",
          text: "请站在黄色安全线内，列车即将到站。",
          cues: [{
            startSeconds: 12.5,
            endSeconds: 14.2,
            text: "请站在黄色安全线内，列车即将到站。",
          }],
        },
      }),
    },
    { DB: database },
  );
  assert.equal(createResponse.status, 201);
  const conversation = (await createResponse.json()).conversation;

  const askResponse = await request(
    "/api/model/ask",
    {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({
        conversationId: conversation.id,
        question: "00:13 讲了什么？",
        reasoningMode: "flash",
        fullRecallEnabled: true,
      }),
    },
    {
      DB: database,
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/deepseek`,
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
    },
  );
  const { done: answer, events } = await readAskStream(askResponse);
  assert.equal(askResponse.status, 200, JSON.stringify(answer));
  assert.ok(events.some((event) => event.type === "answer_delta"));
  assert.equal(
    answer.answer,
    "视频在 [[video:12.000|00:12]] 提到列车即将到站。",
  );
  assert.equal(modelRequests.length, 3);
  const planner = modelRequests.find((body) =>
    body.messages[0]?.content?.includes("视频回顾规划器"),
  );
  const reranker = modelRequests.find((body) =>
    body.messages[0]?.content?.includes("视频证据重排器"),
  );
  const finalAnswer = modelRequests.find((body) =>
    body.messages[0]?.content?.includes("后续对话助手"),
  );
  assert.ok(planner);
  assert.ok(reranker);
  assert.ok(finalAnswer);
  assert.doesNotMatch(planner.messages[1].content, /黄色安全线/);
  assert.match(reranker.messages[1].content, /黄色安全线/);
  assert.match(
    finalAnswer.messages.find((message) =>
      message.content?.includes?.("【按需回顾证据"),
    ).content,
    /\[字幕 00:12 ~ 00:14\]/,
  );
});

test("persists new summaries without a legacy takeaway", async () => {
  const database = new FakeD1Database();
  const source = {
    kind: "upload",
    title: "无一句话总结测试",
    subtitle: "summary.mp4",
  };
  const summary = {
    title: "无一句话总结测试",
    overview: "视频依次说明了问题背景、主要步骤和后续建议。",
    keyPoints: [
      {
        time: "00:00",
        title: "问题背景",
        detail: "开头交代问题背景，并通过旁白说明分析目标。",
      },
    ],
    chapters: [
      {
        time: "00:00",
        title: "开场",
        description: "介绍问题和分析目标。",
      },
    ],
    takeaway: "",
    evidence: [],
  };

  const response = await request(
    "/api/conversations",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-email": "viewer@example.com",
      },
      body: JSON.stringify({
        source,
        summary,
        messages: [{ role: "assistant", content: "总结已经生成。" }],
        activeModel: "qwen3.5-omni-plus",
      }),
    },
    { DB: database },
  );

  assert.equal(response.status, 201);
  const created = (await response.json()).conversation;
  assert.equal("takeaway" in created.summary, false);
  assert.equal(database.conversations.size, 1);
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
      body: JSON.stringify({ bvid: "BV1nx411u79K", variant: "preview" }),
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
          playbackUrl: `http://127.0.0.1/media/${jobId}?download=0`,
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
      body: JSON.stringify({ bvid: "BV1nx411u79K", variant: "analysis" }),
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
  assert.match(statusPayload.artifact.playbackUrl, /download=0/);
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
  assert.deepEqual(upstreamRequests[0].body, {
    bvid: "BV1nx411u79K",
    variant: "analysis",
  });
  assert.ok(upstreamRequests.every(
    ({ authorization }) => authorization === "Bearer media-service-test-token",
  ));
});

test("uses Qwen for analysis and selects the requested DeepSeek follow-up model", async (t) => {
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
  const ordinalFrameSummary = {
    ...summary,
    keyPoints: [1, 2, 3, 4].map((number) => ({
      time: `KF_00${number}`,
      title: `画面 ${number}`,
      detail: `第 ${number} 个关键帧。`,
    })),
    chapters: [
      { time: "KF_001", title: "前段", description: "前段内容。" },
      { time: "KF_002", title: "后段", description: "后段内容。" },
    ],
    evidence: [{ time: "KF_003", fact: "第三个关键帧证据。" }],
    audioAnalysis: {
      ...summary.audioAnalysis,
      temporalChanges: [{ time: "00:04", description: "第四帧附近声音变化。" }],
    },
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
    if (
      providerRequest.body.model === "deepseek-v4-pro" ||
      providerRequest.body.model === "deepseek-v4-flash"
    ) {
      const systemPrompt = providerRequest.body.messages[0]?.content ?? "";
      const plannerInput = providerRequest.body.messages[1]?.content ?? "";
      let content = "结论：模型调用链路可用。";
      if (systemPrompt.includes("视频回顾规划器")) {
        const plannerContext = JSON.parse(plannerInput);
        content = plannerContext.userQuestion.includes("00:08")
          ? JSON.stringify({
              targets: ["transcript"],
              query: "完成调用验证",
              reason: "用户询问明确视频时间。",
              timeRange: { startSeconds: 0, endSeconds: 53 },
              fullReview: false,
            })
          : JSON.stringify({
              targets: [],
              query: plannerContext.userQuestion,
              reason: "精简视频记忆足以回答。",
              timeRange: null,
              fullReview: false,
            });
      } else if (systemPrompt.includes("视频证据重排器")) {
        const rerankContext = JSON.parse(plannerInput);
        const selected = rerankContext.candidates
          .filter((candidate) => candidate.source === "transcript")
          .slice(0, 1)
          .map((candidate) => ({ id: candidate.id, relevance: 0.98 }));
        content = JSON.stringify({ selected });
      } else if (
        providerRequest.body.messages.slice(1).some((message) =>
          message.content?.includes?.("【按需回顾证据"),
        )
      ) {
        content = "调用验证发生在 00:08。";
      }
      if (providerRequest.body.stream) {
        writeOpenAiChatStream(res, {
          content,
          model: providerRequest.body.model,
          ...(providerRequest.body.model === "deepseek-v4-pro"
            ? { reasoningContent: "先核对视频记忆，再形成结论。" }
            : {}),
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-deepseek-test",
        object: "chat.completion",
        created: 0,
        model: providerRequest.body.model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        }],
      }));
      return;
    }

    const serializedMessages = JSON.stringify(providerRequest.body.messages);
    const responseSummary = serializedMessages.includes("缺少声音分析字段")
      ? summaryWithoutAudioAnalysis
      : providerRequest.body.messages[1]?.content?.some(
          (part) => part.type === "image_url",
        )
        ? ordinalFrameSummary
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

  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(payload.summary, summary);
  const providerRequest = providerRequests[0];
  assert.equal(providerRequest.authorization, "Bearer local-test-key");
  assert.equal(providerRequest.url, "/compatible-mode/v1/chat/completions");
  assert.equal(providerRequest.body.stream, true);
  assert.equal(providerRequest.body.response_format.type, "json_object");
  const videoPart = providerRequest.body.messages[1].content[0];
  assert.equal(videoPart.type, "video_url");
  assert.equal(videoPart.video_url.url, "https://media.example.com/test.mp4");
  assert.equal(videoPart.fps, 1);
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
        },
        context: {
          frameUrls: [
            "data:image/jpeg;base64,AAAA",
            "data:image/jpeg;base64,BBBB",
            "data:image/jpeg;base64,CCCC",
            "data:image/jpeg;base64,DDDD",
          ],
          frameTimestamps: [0, 12.5, 25, 37.5],
          durationSeconds: 40,
          audioUrl: "data:audio/mpeg;base64,EEEE",
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
  assert.deepEqual(
    extractedMediaPayload.summary.keyPoints.map(({ time }) => time),
    ["00:00", "00:13", "00:25", "00:38"],
  );
  assert.equal(
    extractedMediaPayload.summary.audioAnalysis.temporalChanges[0].time,
    "00:04",
  );
  const extractedMediaRequest = providerRequests[1];
  const extractedParts = extractedMediaRequest.body.messages[1].content;
  const extractedFrameParts = extractedParts.filter(
    (part) => part.type === "image_url",
  );
  assert.equal(extractedFrameParts.length, 4);
  assert.equal(
    extractedFrameParts[1].image_url.url,
    "data:image/jpeg;base64,BBBB",
  );
  assert.match(
    extractedParts.find(
      (part) => part.type === "text" && part.text.includes("KF_002"),
    ).text,
    /KF_002，对应原视频 00:12\.500/,
  );
  const extractedAudioPart = extractedParts.find(
    (part) => part.type === "input_audio",
  );
  assert.equal(extractedAudioPart.input_audio.format, "mp3");
  assert.equal(
    extractedAudioPart.input_audio.data,
    "data:audio/mpeg;base64,EEEE",
  );
  assert.match(
    extractedParts.find(
      (part) =>
        part.type === "text" &&
        part.text.includes("原视频总时长为 40.00 秒"),
    ).text,
    /原视频总时长为 40\.00 秒/,
  );
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
        },
        summary,
        context: {
          transcript:
            "[00:00] 视频介绍模型接口。\n[00:08] 随后完成调用验证。",
        },
        history: [{ role: "user", content: "它讲了什么？" }],
        reasoningMode: "pro",
        webSearchEnabled: false,
      }),
    },
    {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/deepseek`,
      DEEPSEEK_CHAT_MODEL: "deepseek-v4-pro",
    },
  );
  assert.equal(askResponse.status, 200);
  const { done: askPayload, events: askEvents } =
    await readAskStream(askResponse);
  assert.equal(askPayload.provider, "deepseek");
  assert.equal(askPayload.model, "deepseek-v4-pro");
  assert.equal(askPayload.answer, "结论：模型调用链路可用。");
  assert.equal(askPayload.reasoningContent, "先核对视频记忆，再形成结论。");
  assert.ok(askEvents.some((event) => event.type === "reasoning_delta"));
  const askProviderRequest = providerRequests
    .slice(askProviderRequestIndex)
    .find((request) =>
      request.body.messages[0]?.content?.includes("后续对话助手"),
    );
  assert.ok(askProviderRequest);
  assert.equal(askProviderRequest.authorization, "Bearer deepseek-test-key");
  assert.equal(askProviderRequest.url, "/deepseek/chat/completions");
  assert.equal(askProviderRequest.body.stream, true);
  assert.deepEqual(askProviderRequest.body.thinking, { type: "enabled" });
  const askPrompt = askProviderRequest.body.messages.at(-1).content;
  const askBaseContext = askProviderRequest.body.messages[1].content;
  const askSystemPrompt = askProviderRequest.body.messages[0].content;
  assert.match(askPrompt, /结论是什么/);
  assert.match(askBaseContext, /audioOverview/);
  assert.match(askBaseContext, /低保真爵士乐/);
  assert.doesNotMatch(askBaseContext, /\[00:08\] 随后完成调用验证/);
  assert.match(askBaseContext, /精简视频记忆|overview|keyPoints/);
  assert.match(askSystemPrompt, /不可遗忘但精简/);
  assert.match(askSystemPrompt, /按需回顾证据/);
  assert.match(askSystemPrompt, /视频之外/);
  assert.match(askSystemPrompt, /系统提示词|API Key|隐私/);

  const timedAskResponse = await request(
    "/api/model/ask",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "00:08 讲了什么？",
        source: {
          kind: "upload",
          title: "测试视频",
          subtitle: "test.mp4",
        },
        summary,
        context: {
          transcript:
            "[00:00] 视频介绍模型接口。\n[00:08] 随后完成调用验证。",
        },
        history: [{ role: "user", content: "它讲了什么？" }],
        reasoningMode: "pro",
        fullRecallEnabled: true,
      }),
    },
    {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/deepseek`,
      DEEPSEEK_CHAT_MODEL: "deepseek-v4-pro",
    },
  );
  assert.equal(timedAskResponse.status, 200);
  const { done: timedAskPayload } = await readAskStream(timedAskResponse);
  assert.equal(
    timedAskPayload.answer,
    "调用验证发生在 [[video:8.000|00:08]]。",
  );

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
        },
        summary: summaryWithoutAudioAnalysis,
        reasoningMode: "pro",
      }),
    },
    {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/deepseek`,
      DEEPSEEK_CHAT_MODEL: "deepseek-v4-pro",
    },
  );
  assert.equal(legacyAskResponse.status, 200);
  await readAskStream(legacyAskResponse);

  const flashAskResponse = await request(
    "/api/model/ask",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "快速回答。",
        source: {
          kind: "upload",
          title: "快速模型测试",
          subtitle: "flash.mp4",
        },
        summary,
        reasoningMode: "flash",
        webSearchEnabled: false,
      }),
    },
    {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}/deepseek`,
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
      DEEPSEEK_PRO_MODEL: "deepseek-v4-pro",
    },
  );
  assert.equal(flashAskResponse.status, 200);
  const { done: flashAskPayload, events: flashEvents } =
    await readAskStream(flashAskResponse);
  assert.equal(flashAskPayload.model, "deepseek-v4-flash");
  assert.equal(flashAskPayload.reasoningContent, undefined);
  assert.equal(
    flashEvents.some((event) => event.type === "reasoning_delta"),
    false,
  );
  const flashProviderRequest = providerRequests.findLast((request) =>
    request.body.messages?.[0]?.content?.includes("后续对话助手"),
  );
  assert.deepEqual(flashProviderRequest.body.thinking, { type: "disabled" });
});

test("plans a search, reads four pages and returns persistent citations", async (t) => {
  const modelRequests = [];
  const extractedUrls = [];
  const providerUsage = {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
    prompt_cache_hit_tokens: 40,
    prompt_cache_miss_tokens: 60,
    completion_tokens_details: { reasoning_tokens: 0 },
  };
  const upstream = createServer(async (req, res) => {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;

    if (req.url?.startsWith("/search.json")) {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      assert.equal(requestUrl.searchParams.get("q"), "测试作品 官方资料 最新版本");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        organic_results: [1, 2, 3, 4].map((index) => ({
          title: `可信来源 ${index}`,
          link: `https://source${index}.example/article`,
          snippet: `第 ${index} 个搜索摘要`,
        })),
      }));
      return;
    }

    if (req.url === "/v1/web/extract") {
      assert.equal(req.headers.authorization, "Bearer media-search-token");
      const body = JSON.parse(rawBody);
      extractedUrls.push(body.url);
      const index = Number(body.url.match(/source(\d+)/)?.[1] ?? 0);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        url: body.url,
        finalUrl: body.url,
        title: `正文来源 ${index}`,
        contentType: "text/html",
        method: "trafilatura",
        text: [
          `测试作品的官方资料显示，第 ${index} 个来源记录了当前版本以及发布日期。这一段包含用于验证搜索正文的有效信息，也明确列出了版本标识、适用地区、更新时间和发布主体。`,
          `该来源还解释了测试作品的版本变化，并提供可以和其他独立网页交叉核验的事实内容。为了让相关段落选择器能够稳定工作，这里继续补充来源背景与核验范围。`,
        ].join("\n\n"),
      }));
      return;
    }

    if (req.url === "/deepseek/chat/completions") {
      const body = JSON.parse(rawBody);
      modelRequests.push(body);
      const systemPrompt = body.messages[0]?.content ?? "";
      const content = systemPrompt.includes("视频回顾规划器")
        ? JSON.stringify({
            targets: [],
            query: "测试作品 最新版本",
            reason: "精简视频记忆已经足够规划联网检索。",
            timeRange: null,
            fullReview: false,
          })
        : systemPrompt.includes("联网检索规划器")
          ? JSON.stringify({
            decision: "search",
            query: "测试作品 官方资料 最新版本",
            reason: "用户要求核实当前资料。",
            searchLanguage: "zh-CN",
            countryCode: "CN",
          })
          : "官方资料显示当前版本已经更新。[1] 第二个独立来源给出了相同结论。[2]";
      if (body.stream) {
        writeOpenAiChatStream(res, {
          content,
          model: body.model,
          usage: providerUsage,
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-web-search-test",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        }],
        usage: providerUsage,
      }));
      return;
    }

    res.writeHead(404).end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const response = await request(
    "/api/model/ask",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-language": "zh-CN",
      },
      body: JSON.stringify({
        question: "请联网核实这个作品的最新版本。",
        source: {
          kind: "bilibili",
          title: "测试作品",
          subtitle: "BV1nx411u79K",
          bvid: "BV1nx411u79K",
          description: "作者发布的测试作品。",
        },
        summary: {
          title: "测试作品总结",
          overview: "视频讨论了一个作品版本。",
          keyPoints: [{
            time: "00:10",
            title: "作品版本",
            detail: "作者提到作品可能已经更新。",
          }],
          chapters: [{
            time: "00:10",
            title: "版本讨论",
            description: "视频讨论了作品版本变化。",
          }],
        },
        context: {
          transcript: "[00:10] 作者提到作品最近可能更新。",
        },
        history: [{ role: "user", content: "刚才说的是哪个作品？" }],
        webSearchEnabled: true,
        fullRecallEnabled: true,
        reasoningMode: "flash",
        searchContext: {
          locale: "zh-CN",
          timeZone: "Asia/Shanghai",
          transcriptLanguage: "zh",
        },
      }),
    },
    {
      DEEPSEEK_API_KEY: "deepseek-test-key",
      DEEPSEEK_BASE_URL: `${origin}/deepseek`,
      DEEPSEEK_FLASH_MODEL: "deepseek-v4-flash",
      SERPAPI_API_KEY: "serp-test-key",
      SERPAPI_ENDPOINT: `${origin}/search.json`,
      BILIBILI_MEDIA_SERVICE_URL: origin,
      BILIBILI_MEDIA_SERVICE_TOKEN: "media-search-token",
    },
  );

  const { done: payload, events } = await readAskStream(response);
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.webSearchUsed, true);
  assert.equal(payload.visitedPageCount, 4);
  assert.equal(payload.usage.totalTokens, 360);
  assert.equal(payload.usage.searchCount, 1);
  assert.equal(payload.usage.calls.length, 3);
  assert.deepEqual(
    payload.usage.calls.map((call) => call.operation),
    ["recall_plan", "web_search_plan", "chat_answer"],
  );
  assert.match(payload.answer, /\[1\]\(https:\/\/source1\.example\/article\)/);
  assert.doesNotMatch(payload.answer, /参考来源|访问了 4 个网页/);
  assert.deepEqual(
    payload.webSources.map(({ index, title }) => ({ index, title })),
    [1, 2, 3, 4].map((index) => ({
      index,
      title: `正文来源 ${index}`,
    })),
  );
  assert.ok(events.some((event) => event.type === "answer_delta"));
  assert.equal(extractedUrls.length, 4);
  assert.equal(modelRequests.length, 3);
  const recallPlannerRequest = modelRequests.find((item) =>
    item.messages[0]?.content?.includes("视频回顾规划器"),
  );
  const searchPlannerRequest = modelRequests.find((item) =>
    item.messages[0]?.content?.includes("联网检索规划器"),
  );
  const finalAnswerRequest = modelRequests.find((item) =>
    item.messages[0]?.content?.includes("后续对话助手"),
  );
  assert.ok(recallPlannerRequest);
  assert.ok(searchPlannerRequest);
  assert.ok(finalAnswerRequest);
  assert.match(searchPlannerRequest.messages[1].content, /测试作品/);
  assert.doesNotMatch(
    searchPlannerRequest.messages[1].content,
    /作者提到作品最近可能更新/,
  );
  assert.match(
    finalAnswerRequest.messages.find((message) =>
      message.content?.includes?.("联网搜索资料"),
    ).content,
    /passages/,
  );
});

test("removes disposable starter assets and keeps model choice decoupled", async () => {
  const [
    page,
    layout,
    packageJson,
    engine,
    qwenEngine,
    deepseekEngine,
    videoRecall,
    workbench,
    bilibiliClient,
    conversationClient,
    settingsMenu,
    styles,
    hostingJson,
    databaseSchema,
    databaseMigration,
    nextConfig,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../lib/video-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/qwen-video-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/deepseek-conversation-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/video-recall.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/VideoWorkbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/bilibili-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/client/conversation-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/UserSettingsMenu.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0000_first_darkhawk.sql", import.meta.url), "utf8"),
    readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<VideoWorkbench \/>/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(layout, /suppressHydrationWarning/);
  assert.match(layout, /framenote\.user-preferences\.v1/);
  assert.match(layout, /document\.documentElement\.dataset\.theme/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /tailwindcss/);
  assert.match(packageJson, /"react-markdown"/);
  assert.match(packageJson, /"remark-gfm"/);
  assert.match(engine, /interface VideoEngine/);
  assert.doesNotMatch(engine, /demoVideoEngine|mode:\s*"demo"/);
  assert.match(workbench, /analyzeVideo/);
  assert.match(workbench, /askVideo/);
  assert.match(workbench, /downloadBilibiliVideo/);
  assert.match(workbench, /prepareBilibiliVideoDownload/);
  assert.doesNotMatch(workbench, /\bisPreparingVideo\b/);
  assert.doesNotMatch(workbench, /variant:\s*"preview"/);
  assert.match(bilibiliClient, /variant: BILIBILI_ANALYSIS_DOWNLOAD_VARIANT/);
  assert.match(workbench, /prepareMediaAnalysis/);
  assert.match(workbench, /MAX_MEDIA_ANALYSIS_BYTES/);
  assert.match(workbench, /summaryTimeline/);
  assert.match(workbench, /<h4>时间线<\/h4>/);
  assert.match(workbench, /timelineItems\.length/);
  assert.doesNotMatch(workbench, /声音与音乐|一句话结论|章节时间线|takeaway-block|audio-analysis|key-point-list/);
  assert.doesNotMatch(qwenEngine, /QA_SYSTEM_PROMPT|async ask\(/);
  assert.match(qwenEngine, /keyPoints: 最多 24 个按时间排序的 \{time, title, detail\}/);
  assert.match(deepseekEngine, /不可遗忘但精简/);
  assert.match(deepseekEngine, /字幕可能出现错字、漏字或不合理断句/);
  assert.match(deepseekEngine, /仍然尽力回答/);
  assert.match(deepseekEngine, /系统提示词、开发者消息、API Key/);
  assert.match(videoRecall, /视频回顾规划器/);
  assert.match(videoRecall, /recallByKeywords/);
  assert.match(videoRecall, /rerankCandidates/);
  assert.match(videoRecall, /applyVideoTimeReferences/);
  assert.doesNotMatch(videoRecall, /normalizeOutlinePlan|summaryOutlineCandidates/);
  assert.doesNotMatch(
    workbench,
    /engine-badge|VIDEO INTELLIGENCE|intro-block|setup-title|architecture-note|getModelStatus|ModelStatusResponse/,
  );
  assert.doesNotMatch(workbench, /Qwen 视频理解 \+ DeepSeek V4 Pro 对话/);
  assert.doesNotMatch(
    workbench,
    /完成左侧设置后，你会先得到一份带章节的总结，然后可以像聊天一样继续追问。/,
  );
  assert.match(workbench, /aria-label="视频预览"/);
  assert.match(workbench, /handleFetchVideo/);
  assert.match(workbench, /获取视频/);
  assert.match(workbench, /showBilibiliVideo/);
  assert.doesNotMatch(workbench, /showDownloadedVideo/);
  assert.doesNotMatch(workbench, /isReusableBilibiliDownload/);
  assert.doesNotMatch(workbench, /URL\.createObjectURL\(result\.file\)/);
  assert.doesNotMatch(workbench, /bilibiliPlayerUrl|player\.bilibili\.com|<iframe/);
  assert.match(workbench, /<video/);
  assert.match(workbench, /preload="metadata"/);
  assert.match(workbench, /src=\{videoPreview\.playbackUrl\}/);
  assert.match(workbench, /\$\{result\.width\}x\$\{result\.height\}/);
  assert.match(workbench, /videoPreview\.resolutionLabel/);
  assert.doesNotMatch(
    workbench,
    /下载最高画质 MP4|打开 B站原页面|边播放边缓存|最高画质浏览器预览已就绪|最高兼容清晰度|以下内容由真实 Qwen|查看源视频/,
  );
  assert.match(workbench, /downloaded\.context/);
  assert.match(workbench, /preservesConversation/);
  assert.match(workbench, /if \(conversation\.source\.kind === "bilibili"\)/);
  assert.match(workbench, /conversation\.source\.kind === "url"/);
  assert.doesNotMatch(
    workbench,
    /persistedVideo|showStoredVideo|storeConversationVideo|conversationVideoUrl/,
  );
  assert.match(workbench, /loadBilibiliConversationPreview/);
  assert.match(workbench, /"first-summary"/);
  assert.match(workbench, /video-preview-description/);
  assert.match(workbench, /fetchVideoAbortRef\.current !== controller/);
  assert.match(workbench, /runTokenRef\.current !== runToken/);
  assert.doesNotMatch(workbench, /bilibiliVideo\?\.file \?\? null/);
  assert.match(workbench, /总结生成完毕，我还可以继续和你讨论相关内容 : \)/);
  assert.match(workbench, /function stopReply\(\)/);
  assert.match(
    workbench,
    /async function handleFetchVideo[\s\S]+stopReply\(\);[\s\S]+async function handleAnalyze[\s\S]+stopReply\(\);/,
  );
  assert.match(
    workbench,
    /async function handleSelectConversation[\s\S]+stopReply\(\);/,
  );
  assert.match(workbench, /aria-label=\{isReplying \? "停止生成" : "发送问题"\}/);
  assert.doesNotMatch(workbench, /transcriptForConversationContext/);
  assert.match(workbench, /conversationId:\s*activeConversationId/);
  assert.match(workbench, /message-video-time/);
  assert.match(workbench, /跳转到视频/);
  assert.doesNotMatch(workbench, /可以继续输入；停止当前回答后即可发送/);
  assert.match(workbench, /480p 等价分析素材/);
  assert.doesNotMatch(workbench, /不设网页文件大小上限/);
  assert.doesNotMatch(workbench, /自动生成低分辨率分析素材/);
  assert.doesNotMatch(workbench, /MP4、MOV、WebM、MKV、M4V ·/);
  assert.match(workbench, /aria-label="选择文件"/);
  assert.match(workbench, />\s*选择文件\s*<\/button>/);
  assert.doesNotMatch(workbench, /浏览器处理上限/);
  assert.doesNotMatch(workbench, /BILIBILI_VIDEO_QUALITIES|最高 \{height\}p/);
  assert.doesNotMatch(workbench, /download=\{videoPreview\.filename\}/);
  assert.match(
    workbench,
    /phase === "ready" && videoPreview[\s\S]+side-video-context/,
  );
  assert.match(workbench, /isRestoredLocalConversation/);
  assert.match(workbench, /videoPreview\.kind === "local"[\s\S]+更改/);
  assert.match(workbench, /字幕提取/);
  assert.match(workbench, /提取字幕/);
  assert.match(workbench, /TRANSCRIPT_TIMEOUT_MESSAGE/);
  assert.match(workbench, /saveConversationTranscript/);
  assert.match(workbench, /ReactMarkdown/);
  assert.match(workbench, /remarkGfm/);
  assert.match(workbench, /prepareMarkdownContent/);
  assert.doesNotMatch(workbench, /parseMarkdownBlocks|renderTextMarkdown|renderInlineMarkdown/);
  assert.match(workbench, /FunASR Nano＋CT-Punc/);
  assert.match(workbench, /transcriptExtractionEnabled/);
  assert.match(workbench, /语言选择/);
  assert.match(workbench, /自动识别中、日、英/);
  assert.match(workbench, /深度思考/);
  assert.match(workbench, /联网搜索/);
  assert.match(workbench, /reasoningMode:\s*deepThinkingEnabled \? "pro" : "flash"/);
  assert.doesNotMatch(workbench, /这个视频的核心观点是什么/);
  assert.doesNotMatch(workbench, /按时间线梳理章节/);
  assert.doesNotMatch(workbench, /给我三个行动建议/);
  assert.match(workbench, /framenote\.workspace-layout\.v1/);
  assert.match(workbench, /beginResize\("columns", event\)/);
  assert.match(workbench, /beginResize\("rows", event\)/);
  assert.match(workbench, /beginResize\("diagonal-source", event\)/);
  assert.match(workbench, /beginResize\("diagonal-history", event\)/);
  assert.match(workbench, /斜向调整导入板块大小/);
  assert.match(workbench, /斜向调整记录板块大小/);
  assert.match(workbench, /role="separator"/);
  assert.match(workbench, /aria-orientation="vertical"/);
  assert.match(workbench, /aria-orientation="horizontal"/);
  assert.match(workbench, /function toggleSourcePane\(\)/);
  assert.match(workbench, /function toggleHistoryPane\(\)/);
  assert.match(workbench, /MIN_SIDEBAR_WIDTH\s*=\s*340/);
  assert.match(workbench, /MIN_CONVERSATION_WIDTH\s*=\s*560/);
  assert.match(workbench, /MIN_SOURCE_PANE_HEIGHT\s*=\s*260/);
  assert.match(workbench, /MIN_HISTORY_PANE_HEIGHT\s*=\s*220/);
  const restoreStart = workbench.indexOf(
    "async function loadBilibiliConversationPreview",
  );
  const restoreEnd = workbench.indexOf(
    "\n  async function handleFetchVideo",
    restoreStart,
  );
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  const restoreBody = workbench.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(
    restoreBody,
    /setSummary\(null\)|setMessages\(\[\]\)|setActiveConversationId\(null\)|setPhase\("error"\)/,
  );
  assert.match(workbench, /MarkdownMessage/);
  assert.match(workbench, /\/\^\\d\{1,2\}\$\/\.test\(label\) \? `\[\$\{label\}\]` : children/);
  assert.match(workbench, /timeline-seek/);
  assert.match(workbench, /seekToTimeline/);
  assert.doesNotMatch(workbench, /summary-mode|>结构化</);
  assert.doesNotMatch(workbench, /"下载视频"|"打开\/下载原视频"/);
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
  assert.match(settingsMenu, /DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS\s*=\s*360/);
  assert.match(settingsMenu, /MAX_QWEN_DIRECT_SUMMARY_MAX_SECONDS\s*=\s*900/);
  assert.match(settingsMenu, /设为 0/);
  assert.match(settingsMenu, /value="youyuan">幼圆/);
  assert.match(settingsMenu, /value="kaiti">楷体/);
  assert.match(settingsMenu, /value="microsoft-yahei">微软雅黑/);
  assert.match(settingsMenu, /value="consolas">Consolas/);
  assert.match(settingsMenu, /type="number"/);
  assert.match(settingsMenu, /--ui-font-size/);
  assert.match(settingsMenu, /--text-font-size/);
  assert.match(settingsMenu, /--ui-font/);
  assert.match(settingsMenu, /--text-font/);
  assert.doesNotMatch(settingsMenu, />中文字体<|>英文字体</);
  assert.match(settingsMenu, /<option value="dark">深色<\/option>/);
  assert.doesNotMatch(settingsMenu, /深色（黑灰）/);
  assert.match(styles, /html\[data-theme="dark"\]/);
  assert.match(styles, /--ui-font:/);
  assert.match(styles, /--text-font:/);
  assert.match(styles, /html\[data-theme="dark"\] \.primary-action/);
  assert.doesNotMatch(styles, /video-download-action|video-source-action|video-ready-label|demo-disclaimer/);
  assert.match(
    styles,
    /html\[data-theme="dark"\] \.timeline-seek\s*\{[^}]*background:\s*transparent;[^}]*color:\s*#43adf5;/s,
  );
  assert.match(
    styles,
    /html\[data-theme="dark"\] \.transcript-row button\s*\{[^}]*color:\s*#6cc1fb;/s,
  );
  assert.match(
    styles,
    /html\[data-theme="dark"\]\s*\{[^}]*--switch-active:\s*#6cc1fb;/s,
  );
  assert.match(
    styles,
    /\.analysis-setting-row input:checked \+ i\s*\{[^}]*background:\s*var\(--switch-active\);/s,
  );
  assert.match(
    styles,
    /\.transcript-language-settings fieldset label:active span\s*\{[^}]*transform:\s*scale\(0\.96\);/s,
  );
  assert.match(
    styles,
    /\.conversation-tool-row button:active\s*\{[^}]*transform:\s*scale\(0\.96\);/s,
  );
  assert.match(
    styles,
    /\.video-preview-details > strong\s*\{[^}]*var\(--ui-font-size\)/s,
  );
  assert.match(
    styles,
    /\.video-preview-meta\s*\{[^}]*var\(--ui-font-size\)/s,
  );
  assert.doesNotMatch(workbench, /message-avatar|帧记 AI/);
  assert.doesNotMatch(styles, /\.message-avatar/);
  assert.equal(workbench.includes("is-actions-visible"), true);
  assert.equal(workbench.includes("onPointerEnter"), true);
  assert.equal(
    styles.includes(".message.is-actions-visible .message-answer-footer"),
    true,
  );
  assert.match(styles, /\.message\.assistant > \.message-body/);
  assert.equal(styles.includes("gap: 34px;"), true);
  assert.equal(styles.includes("width: min(80%, 1100px);"), true);
  assert.equal(
    styles.includes(
      'html[data-theme="dark"] .message-answer-card > .stream-status',
    ),
    true,
  );
  assert.match(
    styles,
    /\.message-video-time\s*\{[^}]*background:\s*#ffffff;[^}]*color:\s*#1684d8;/s,
  );
  assert.match(
    styles,
    /html\[data-theme="dark"\] \.message-video-time\s*\{[^}]*background:\s*#2a2a2d;[^}]*color:\s*#6cc1fb;/s,
  );
  assert.doesNotMatch(workbench, /new-task-button|新建任务/);
  assert.doesNotMatch(workbench, /download-option|switch-wrap|下载公开视频，再进行总结/);
  assert.match(styles, /\.conversation-library\s*\{[^}]*display:\s*flex/s);
  assert.match(styles, /\.conversation-list\s*\{[^}]*flex:\s*1/s);
  assert.match(
    styles,
    /\.workspace\s*\{[^}]*width:\s*min\(1880px,[^}]*grid-template-columns:/s,
  );
  assert.match(styles, /\.workspace-resizer\s*\{[^}]*cursor:\s*col-resize;/s);
  assert.match(styles, /\.pane-resizer\s*\{[^}]*cursor:\s*row-resize;/s);
  assert.match(
    styles,
    /\.source-diagonal-resizer\s*\{[^}]*cursor:\s*nwse-resize;/s,
  );
  assert.match(
    styles,
    /\.history-diagonal-resizer\s*\{[^}]*cursor:\s*nesw-resize;/s,
  );
  assert.match(
    styles,
    /\.video-preview-card\.side \.video-preview-player video\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;[^}]*max-height:\s*none;[^}]*aspect-ratio:\s*auto;/s,
  );
  assert.doesNotMatch(
    styles,
    /\.workspace-resizer::before|\.pane-resizer::before|\.diagonal-resizer::before/,
  );
  assert.match(styles, /transition:\s*grid-template-columns 240ms/);
  assert.match(styles, /grid-template-rows 240ms/);
  assert.match(
    styles,
    /\.source-card\s*\{[^}]*scrollbar-color:\s*var\(--line-strong\) transparent;/s,
  );
  assert.match(styles, /\.source-card::-webkit-scrollbar,/);
  assert.match(styles, /\.setup-column\.source-collapsed/);
  assert.match(styles, /\.setup-column\.history-collapsed/);
  const parsedHostingConfig = JSON.parse(hostingJson);
  assert.equal(parsedHostingConfig.d1, "DB");
  assert.equal(typeof parsedHostingConfig.project_id, "string");
  assert.equal("r2" in parsedHostingConfig, false);
  assert.match(nextConfig, /bodySizeLimit:\s*"501mb"/);
  assert.match(databaseSchema, /sqliteTable\(\s*"conversations"/);
  assert.match(databaseSchema, /sqliteTable\(\s*"conversation_messages"/);
  assert.match(databaseSchema, /conversations_owner_updated_idx/);
  assert.match(databaseSchema, /conversation_messages_sequence_idx/);
  assert.match(databaseMigration, /CREATE TABLE `conversations`/);
  assert.match(databaseMigration, /CREATE TABLE `conversation_messages`/);
  for (const deletedPath of [
    "../app/_sites-preview/SkeletonPreview.tsx",
    "../app/api/conversations/[conversationId]/video/route.ts",
    "../lib/server/conversation-video-store.ts",
    "../app/api/model/status/route.ts",
    "../app/chatgpt-auth.ts",
    "../db/index.ts",
    "../examples/d1/app/api/notes/route.ts",
    "../examples/d1/db/schema.ts",
  ]) {
    await assert.rejects(access(new URL(deletedPath, import.meta.url)));
  }
});
