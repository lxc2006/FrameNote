import type {
  ConversationDetail,
  ConversationListItem,
  ConversationMessage,
  ConversationMessageInput,
  ConversationWebSource,
  CreateConversationInput,
} from "../conversation";
import type {
  SourceKind,
  VideoTranscript,
  VideoSourceDescriptor,
  VideoSummary,
} from "../video-engine";
import {
  QwenResponseError,
  parseVideoSummary,
} from "./qwen-video-engine";
import { runtimeBinding } from "./runtime-env";
import {
  parseConversationUsageRecord,
  type ConversationUsageRecord,
} from "../model-usage";

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const LOCAL_OWNER_ID = "local-development-user";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES_PER_WRITE = 20;
const MAX_MESSAGE_CHARACTERS = 12_000;
const MAX_REASONING_CHARACTERS = 80_000;
const MAX_MESSAGE_WEB_SOURCES = 12;
const MAX_SUMMARY_BYTES = 512 * 1024;
// 读取层保留旧记录兼容余量；新生成的总结已在 Qwen 解析器中限制为 24 个。
const MAX_KEY_POINTS = 32;
const MAX_CHAPTERS = 256;
const MAX_EVIDENCE = 24;
const MAX_AUDIO_CHANGES = 16;
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;

const CONVERSATION_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS conversations (
     id TEXT PRIMARY KEY NOT NULL,
     owner_id TEXT NOT NULL,
     title TEXT NOT NULL,
     source_kind TEXT NOT NULL,
     source_json TEXT NOT NULL,
     summary_json TEXT NOT NULL,
     active_model TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS conversations_owner_updated_idx
   ON conversations (owner_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS conversation_messages (
     id TEXT PRIMARY KEY NOT NULL,
     conversation_id TEXT NOT NULL,
     sequence INTEGER NOT NULL,
     role TEXT NOT NULL,
     content TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_sequence_idx
   ON conversation_messages (conversation_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS conversation_message_details (
     message_id TEXT PRIMARY KEY NOT NULL,
     conversation_id TEXT NOT NULL,
     reasoning_content TEXT,
     reasoning_duration_seconds INTEGER,
     web_sources_json TEXT,
     usage_json TEXT,
     stopped INTEGER NOT NULL DEFAULT 0,
     FOREIGN KEY (message_id) REFERENCES conversation_messages(id) ON DELETE CASCADE,
     FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE IF NOT EXISTS conversation_transcripts (
     conversation_id TEXT PRIMARY KEY NOT NULL,
     transcript_json TEXT NOT NULL,
     FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
   )`,
] as const;

const initializedConversationDatabases = new WeakMap<
  D1Database,
  Promise<void>
>();

const SOURCE_KEYS = [
  "kind",
  "title",
  "subtitle",
  "durationLabel",
  "bvid",
  "sourceUrl",
  "description",
  // 兼容旧记录：允许读取这些字段，但 parseSource 会主动丢弃。
  "downloadFirst",
  "persistedVideo",
] as const;

interface ConversationRow {
  id: string;
  title: string;
  source_kind: string;
  source_json: string;
  summary_json: string;
  active_model: string | null;
  created_at: number;
  updated_at: number;
}

interface ConversationListRow {
  id: string;
  title: string;
  source_kind: string;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

interface MessageDetailRow {
  message_id: string;
  reasoning_content: string | null;
  reasoning_duration_seconds: number | null;
  web_sources_json: string | null;
  usage_json: string | null;
  stopped: number;
}

interface AppendMessagesInput {
  messages: ConversationMessageInput[];
}

interface TruncateMessagesInput {
  fromMessageId: string;
}

export class ConversationRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConversationRouteError";
    this.status = status;
    this.code = code;
  }
}

export async function readConversationJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw invalidInput("请求必须使用 application/json。");
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    throw invalidInput("请求体过大；视频、音轨、关键帧或 Base64 媒体不能写入 D1。");
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw invalidInput("请求体过大；视频、音轨、关键帧或 Base64 媒体不能写入 D1。");
  }

  try {
    return JSON.parse(body);
  } catch {
    throw invalidInput("请求体不是有效 JSON。");
  }
}

export function ownerIdFromRequest(request: Request): string {
  const email = request.headers.get(USER_EMAIL_HEADER)?.trim().toLowerCase();
  if (email) {
    if (
      email.length > 320 ||
      email.includes("\n") ||
      email.includes("\r") ||
      !email.includes("@")
    ) {
      throw new ConversationRouteError(
        401,
        "INVALID_USER_IDENTITY",
        "登录身份无效，请重新登录后再试。",
      );
    }
    return email;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  ) {
    return LOCAL_OWNER_ID;
  }

  throw new ConversationRouteError(
    401,
    "AUTHENTICATION_REQUIRED",
    "需要登录后才能读取或保存视频对话。",
  );
}

export function parseCreateConversationInput(
  value: unknown,
): CreateConversationInput {
  const object = recordValue(value, "请求体");
  assertOnlyKeys(
    object,
    ["source", "summary", "messages", "activeModel", "transcript"],
    "请求体",
  );
  const source = parseSource(object.source);
  const summary = parseSummary(object.summary, source.title);
  const messages = parseMessageInputs(object.messages, "messages", true);
  const activeModel = nullableOptionalString(
    object.activeModel,
    "activeModel",
    200,
  );
  const transcript = object.transcript === undefined
    ? undefined
    : parseTranscript(object.transcript);

  return {
    source,
    summary,
    messages,
    ...(object.activeModel !== undefined ? { activeModel: activeModel ?? null } : {}),
    ...(transcript ? { transcript } : {}),
  };
}

export function parseRenameConversationInput(value: unknown): { title: string } {
  const object = recordValue(value, "请求体");
  assertOnlyKeys(object, ["title"], "请求体");
  return { title: stringValue(object.title, "title", 300) };
}

export function parseUpdateTranscriptInput(value: unknown): {
  transcript: VideoTranscript;
} {
  const object = recordValue(value, "请求体");
  assertOnlyKeys(object, ["transcript"], "请求体");
  return { transcript: parseTranscript(object.transcript) };
}

export function parseAppendMessagesInput(value: unknown): AppendMessagesInput {
  const object = recordValue(value, "请求体");
  assertOnlyKeys(object, ["messages"], "请求体");
  return {
    messages: parseMessageInputs(object.messages, "messages", false),
  };
}

export function parseTruncateMessagesInput(
  value: unknown,
): TruncateMessagesInput {
  const object = recordValue(value, "请求体");
  assertOnlyKeys(object, ["fromMessageId"], "请求体");
  return {
    fromMessageId: parseConversationId(
      stringValue(object.fromMessageId, "fromMessageId", 36),
    ),
  };
}

export function parseConversationId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized,
    )
  ) {
    throw invalidInput("conversationId 格式无效。");
  }
  return normalized;
}

export async function listConversations(
  ownerId: string,
): Promise<ConversationListItem[]> {
  const databaseBinding = await database();
  const result = await databaseBinding.prepare(
    `SELECT id, title, source_kind, created_at, updated_at
     FROM conversations
     WHERE owner_id = ?
     ORDER BY updated_at DESC, id DESC`,
  )
    .bind(ownerId)
    .all<ConversationListRow>();

  return result.results.map(listItemFromRow);
}

export async function createConversation(
  ownerId: string,
  input: CreateConversationInput,
): Promise<ConversationDetail> {
  const databaseBinding = await database();
  const conversationId = crypto.randomUUID();
  const now = Date.now();
  const updatedAt = now + Math.max(0, input.messages.length - 1);
  const sourceJson = JSON.stringify(input.source);
  const summaryJson = JSON.stringify(input.summary);
  const messageRecords = input.messages.map((message, index) => ({
    id: crypto.randomUUID(),
    role: message.role,
    content: message.content,
    createdAt: now + index,
    ...messageMetadata(message),
  }));

  const statements: D1PreparedStatement[] = [
    databaseBinding
      .prepare(
        `INSERT INTO conversations (
           id, owner_id, title, source_kind, source_json, summary_json,
           active_model, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        conversationId,
        ownerId,
        input.source.title,
        input.source.kind,
        sourceJson,
        summaryJson,
        input.activeModel ?? null,
        now,
        updatedAt,
      ),
    ...messageRecords.map((message, index) =>
      databaseBinding
        .prepare(
          `INSERT INTO conversation_messages (
             id, conversation_id, sequence, role, content, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          message.id,
          conversationId,
          index,
          message.role,
          message.content,
          message.createdAt,
        ),
    ),
    ...messageRecords.flatMap((message) => {
      const statement = messageDetailsStatement(
        databaseBinding,
        conversationId,
        message,
      );
      return statement ? [statement] : [];
    }),
    ...(input.transcript
      ? [
          databaseBinding
            .prepare(
              `INSERT INTO conversation_transcripts (
                 conversation_id, transcript_json
               ) VALUES (?, ?)`,
            )
            .bind(conversationId, JSON.stringify(input.transcript)),
        ]
      : []),
  ];

  const results = await databaseBinding.batch(statements);
  assertBatchSucceeded(results);

  return {
    id: conversationId,
    title: input.source.title,
    sourceKind: input.source.kind,
    source: input.source,
    summary: input.summary,
    messages: messageRecords,
    activeModel: input.activeModel ?? null,
    ...(input.transcript ? { transcript: input.transcript } : {}),
    createdAt: now,
    updatedAt,
  };
}

export async function getConversation(
  ownerId: string,
  conversationId: string,
): Promise<ConversationDetail> {
  const databaseBinding = await database();
  const row = await databaseBinding.prepare(
    `SELECT id, title, source_kind, source_json, summary_json, active_model,
            created_at, updated_at
     FROM conversations
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(conversationId, ownerId)
    .first<ConversationRow>();

  if (!row) throw conversationNotFound();

  const messageResult = await databaseBinding.prepare(
    `SELECT id, role, content, created_at
     FROM conversation_messages
     WHERE conversation_id = ?
     ORDER BY sequence ASC`,
  )
    .bind(conversationId)
    .all<MessageRow>();
  const messageDetailResult = await databaseBinding.prepare(
    `SELECT message_id, reasoning_content, reasoning_duration_seconds,
            web_sources_json, usage_json, stopped
     FROM conversation_message_details
     WHERE conversation_id = ?`,
  )
    .bind(conversationId)
    .all<MessageDetailRow>();
  const transcriptRow = await databaseBinding.prepare(
    `SELECT transcript_json
     FROM conversation_transcripts
     WHERE conversation_id = ?`,
  )
    .bind(conversationId)
    .first<{ transcript_json: string }>();

  try {
    const source = parseSource(JSON.parse(row.source_json));
    const summary = parseSummary(JSON.parse(row.summary_json), source.title);
    const detailsByMessageId = new Map(
      messageDetailResult.results.map((detail) => [detail.message_id, detail]),
    );
    return {
      ...listItemFromRow(row),
      source,
      summary,
      messages: messageResult.results.map((message) =>
        messageFromRow(message, detailsByMessageId.get(message.id)),
      ),
      activeModel: row.active_model,
      ...(transcriptRow
        ? { transcript: parseTranscript(JSON.parse(transcriptRow.transcript_json)) }
        : {}),
    };
  } catch (error) {
    if (error instanceof ConversationRouteError) {
      console.error("Invalid persisted conversation data", error);
      throw new Error("D1 中的对话数据格式无效。");
    }
    throw error;
  }
}

export async function renameConversation(
  ownerId: string,
  conversationId: string,
  title: string,
): Promise<ConversationListItem> {
  await requireOwnedConversation(ownerId, conversationId);
  const databaseBinding = await database();
  const updatedAt = Date.now();
  const result = await databaseBinding.prepare(
    `UPDATE conversations
     SET title = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(title, updatedAt, conversationId, ownerId)
    .run();
  assertStatementSucceeded(result);

  const row = await databaseBinding.prepare(
    `SELECT id, title, source_kind, created_at, updated_at
     FROM conversations
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(conversationId, ownerId)
    .first<ConversationListRow>();
  if (!row) throw conversationNotFound();
  return listItemFromRow(row);
}

export async function updateConversationTranscript(
  ownerId: string,
  conversationId: string,
  transcript: VideoTranscript,
): Promise<VideoTranscript> {
  await requireOwnedConversation(ownerId, conversationId);
  const databaseBinding = await database();
  const updatedAt = Date.now();
  const results = await databaseBinding.batch([
    databaseBinding
      .prepare(
        `INSERT INTO conversation_transcripts (
           conversation_id, transcript_json
         ) VALUES (?, ?)
         ON CONFLICT(conversation_id)
         DO UPDATE SET transcript_json = excluded.transcript_json`,
      )
      .bind(conversationId, JSON.stringify(transcript)),
    databaseBinding
      .prepare(
        `UPDATE conversations
         SET updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      )
      .bind(updatedAt, conversationId, ownerId),
  ]);
  assertBatchSucceeded(results);
  return transcript;
}

export async function deleteConversation(
  ownerId: string,
  conversationId: string,
): Promise<void> {
  await requireOwnedConversation(ownerId, conversationId);
  const databaseBinding = await database();
  const results = await databaseBinding.batch([
    databaseBinding
      .prepare(
        `DELETE FROM conversation_transcripts
         WHERE conversation_id IN (
           SELECT id FROM conversations WHERE id = ? AND owner_id = ?
         )`,
      )
      .bind(conversationId, ownerId),
    databaseBinding
      .prepare(
        `DELETE FROM conversation_message_details
         WHERE conversation_id IN (
           SELECT id FROM conversations WHERE id = ? AND owner_id = ?
         )`,
      )
      .bind(conversationId, ownerId),
    databaseBinding
      .prepare(
        `DELETE FROM conversation_messages
         WHERE conversation_id IN (
           SELECT id FROM conversations WHERE id = ? AND owner_id = ?
         )`,
      )
      .bind(conversationId, ownerId),
    databaseBinding
      .prepare("DELETE FROM conversations WHERE id = ? AND owner_id = ?")
      .bind(conversationId, ownerId),
  ]);
  assertBatchSucceeded(results);
}

export async function appendConversationMessages(
  ownerId: string,
  conversationId: string,
  input: AppendMessagesInput,
): Promise<ConversationMessage[]> {
  await requireOwnedConversation(ownerId, conversationId);
  const databaseBinding = await database();
  const now = Date.now();
  const createdMessages = input.messages.map((message, index) => ({
    id: crypto.randomUUID(),
    role: message.role,
    content: message.content,
    createdAt: now + index,
    ...messageMetadata(message),
  }));
  const updatedAt = createdMessages.at(-1)?.createdAt ?? now;
  const statements: D1PreparedStatement[] = [
    ...createdMessages.map((message) =>
      databaseBinding
        .prepare(
          `INSERT INTO conversation_messages (
             id, conversation_id, sequence, role, content, created_at
           )
           SELECT ?, ?, COALESCE(MAX(sequence), -1) + 1, ?, ?, ?
           FROM conversation_messages
           WHERE conversation_id = ?`,
        )
        .bind(
          message.id,
          conversationId,
          message.role,
          message.content,
          message.createdAt,
          conversationId,
        ),
    ),
    ...createdMessages.flatMap((message) => {
      const statement = messageDetailsStatement(
        databaseBinding,
        conversationId,
        message,
      );
      return statement ? [statement] : [];
    }),
    databaseBinding
      .prepare(
        `UPDATE conversations
         SET updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      )
      .bind(updatedAt, conversationId, ownerId),
  ];
  const results = await databaseBinding.batch(statements);
  assertBatchSucceeded(results);
  return createdMessages;
}

export async function truncateConversationMessages(
  ownerId: string,
  conversationId: string,
  input: TruncateMessagesInput,
): Promise<void> {
  await requireOwnedConversation(ownerId, conversationId);
  const databaseBinding = await database();
  const anchor = await databaseBinding
    .prepare(
      `SELECT sequence
       FROM conversation_messages
       WHERE id = ? AND conversation_id = ?`,
    )
    .bind(input.fromMessageId, conversationId)
    .first<{ sequence: number }>();
  if (!anchor) {
    throw new ConversationRouteError(
      404,
      "MESSAGE_NOT_FOUND",
      "要重新发送的消息已不存在，请刷新对话后重试。",
    );
  }

  const updatedAt = Date.now();
  const results = await databaseBinding.batch([
    databaseBinding
      .prepare(
        `DELETE FROM conversation_message_details
         WHERE conversation_id = ?
           AND message_id IN (
             SELECT id
             FROM conversation_messages
             WHERE conversation_id = ? AND sequence >= ?
           )`,
      )
      .bind(conversationId, conversationId, anchor.sequence),
    databaseBinding
      .prepare(
        `DELETE FROM conversation_messages
         WHERE conversation_id = ? AND sequence >= ?`,
      )
      .bind(conversationId, anchor.sequence),
    databaseBinding
      .prepare(
        `UPDATE conversations
         SET updated_at = ?
         WHERE id = ? AND owner_id = ?`,
      )
      .bind(updatedAt, conversationId, ownerId),
  ]);
  assertBatchSucceeded(results);
}

export function conversationErrorResponse(error: unknown): Response {
  if (error instanceof ConversationRouteError) {
    return noStoreJson(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  const combined = errorText(error);
  if (
    combined.includes("no such table") ||
    combined.includes("D1 binding `DB`")
  ) {
    return noStoreJson(
      {
        error: {
          code: "CONVERSATION_STORAGE_UNAVAILABLE",
          message: "对话数据库尚未就绪，请完成 D1 迁移后重试。",
        },
      },
      { status: 503 },
    );
  }

  console.error("Unexpected conversation route error", error);
  return noStoreJson(
    {
      error: {
        code: "CONVERSATION_INTERNAL_ERROR",
        message: "对话服务发生内部错误。",
      },
    },
    { status: 500 },
  );
}

export function conversationJson(data: unknown, init?: ResponseInit): Response {
  return noStoreJson(data, init);
}

async function database(): Promise<D1Database> {
  const binding = runtimeBinding<D1Database>("DB");
  if (!binding) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set .openai/hosting.json d1 to `DB`.",
    );
  }

  let initialization = initializedConversationDatabases.get(binding);
  if (!initialization) {
    initialization = (async () => {
      const results = await binding.batch(
        CONVERSATION_SCHEMA_STATEMENTS.map((statement) =>
          binding.prepare(statement),
        ),
      );
      assertBatchSucceeded(results);
      try {
        const columns = await binding
          .prepare("PRAGMA table_info(conversation_message_details)")
          .all<{ name: string }>();
        if (!columns.results.some((column) => column.name === "usage_json")) {
          await binding
            .prepare(
              "ALTER TABLE conversation_message_details ADD COLUMN usage_json TEXT",
            )
            .run();
        }
      } catch {
        // Some test adapters do not implement PRAGMA. Real D1/SQLite instances do;
        // deployed databases also receive the checked-in migration.
      }
    })().catch((error: unknown) => {
        initializedConversationDatabases.delete(binding);
        throw error;
      });
    initializedConversationDatabases.set(binding, initialization);
  }

  await initialization;
  return binding;
}

export async function requireOwnedConversation(
  ownerId: string,
  conversationId: string,
) {
  const databaseBinding = await database();
  const row = await databaseBinding
    .prepare("SELECT id FROM conversations WHERE id = ? AND owner_id = ?")
    .bind(conversationId, ownerId)
    .first<{ id: string }>();
  if (!row) throw conversationNotFound();
}

function parseSource(value: unknown): VideoSourceDescriptor {
  const object = recordValue(value, "source");
  assertOnlyKeys(object, [...SOURCE_KEYS], "source");
  const kind = object.kind;
  if (kind !== "upload" && kind !== "bilibili" && kind !== "url") {
    throw invalidInput("source.kind 必须是 upload、bilibili 或 url。");
  }

  const title = stringValue(object.title, "source.title", 300);
  const subtitle = stringValue(object.subtitle, "source.subtitle", 1_000);
  const durationLabel = optionalString(
    object.durationLabel,
    "source.durationLabel",
    100,
  );
  const description = optionalString(
    object.description,
    "source.description",
    20_000,
  );
  if (kind === "upload") {
    if (object.bvid !== undefined || object.sourceUrl !== undefined) {
      throw invalidInput("本地上传来源不能保存 bvid 或 sourceUrl。");
    }
    return {
      kind,
      title,
      subtitle,
      ...(durationLabel ? { durationLabel } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (kind === "bilibili") {
    const bvid = stringValue(object.bvid, "source.bvid", 20);
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
      throw invalidInput("source.bvid 格式无效。");
    }
    if (object.sourceUrl !== undefined) {
      const suppliedUrl = stableHttpsUrl(
        stringValue(object.sourceUrl, "source.sourceUrl", 2_048),
        "source.sourceUrl",
      );
      const suppliedBvid = suppliedUrl.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/i)?.[1];
      if (
        suppliedUrl.hostname !== "www.bilibili.com" ||
        suppliedBvid?.toLowerCase() !== bvid.toLowerCase()
      ) {
        throw invalidInput("B站来源只能保存与 BV 号匹配的公开视频页地址。");
      }
    }
    return {
      kind,
      title,
      subtitle,
      bvid,
      sourceUrl: `https://www.bilibili.com/video/${bvid}`,
      ...(durationLabel ? { durationLabel } : {}),
      ...(description ? { description } : {}),
    };
  }

  if (object.bvid !== undefined) {
    throw invalidInput("HTTPS 视频直链来源不能包含 bvid。");
  }
  const sourceUrl = stableHttpsUrl(
    stringValue(object.sourceUrl, "source.sourceUrl", 2_048),
    "source.sourceUrl",
  ).href;
  return {
    kind,
    title,
    subtitle,
    sourceUrl,
    ...(durationLabel ? { durationLabel } : {}),
    ...(description ? { description } : {}),
  };
}

function stableHttpsUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput(`${field} 不是有效 URL。`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw invalidInput(`${field} 必须是没有内嵌凭据的 HTTPS 地址。`);
  }
  const temporaryParameter = [...url.searchParams.keys()].find((name) =>
    /^(?:token|access_token|auth|authorization|signature|sig|expires?|expiry|policy|credential|security-token|x-amz-.+|x-goog-.+|ossaccesskeyid)$/i.test(
      name,
    ),
  );
  if (temporaryParameter) {
    throw invalidInput(
      `${field} 包含临时签名参数 ${temporaryParameter}，不能持久化到 D1。`,
    );
  }
  if (/\/v\d+\/bilibili\/jobs\/[^/]+\/artifact\/?$/i.test(url.pathname)) {
    throw invalidInput(`${field} 是临时下载产物地址，不能持久化到 D1。`);
  }
  url.hash = "";
  return url;
}

function stableWebReferenceUrl(value: string, field: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidInput(`${field} 不是有效 URL。`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw invalidInput(`${field} 必须是没有内嵌凭据的 HTTP(S) 地址。`);
  }
  url.hash = "";
  return url.href;
}

function parseSummary(value: unknown, fallbackTitle: string): VideoSummary {
  const object = recordValue(value, "summary");
  assertOnlyKeys(
    object,
    [
      "title",
      "overview",
      "keyPoints",
      "chapters",
      "takeaway",
      "audioAnalysis",
      "evidence",
    ],
    "summary",
  );
  stringValue(object.title, "summary.title", 300);
  stringValue(object.overview, "summary.overview", 40_000);
  if (optionalString(object.takeaway, "summary.takeaway", 10_000) === undefined) {
    delete object.takeaway;
  }
  validateObjectArray(
    object.keyPoints,
    "summary.keyPoints",
    1,
    MAX_KEY_POINTS,
    ["time", "title", "detail"],
    (item, field) => {
      if (item.time !== undefined) stringValue(item.time, `${field}.time`, 64);
      stringValue(item.title, `${field}.title`, 1_000);
      stringValue(item.detail, `${field}.detail`, 20_000);
    },
  );
  validateObjectArray(
    object.chapters,
    "summary.chapters",
    1,
    MAX_CHAPTERS,
    ["time", "title", "description"],
    (item, field) => {
      stringValue(item.time, `${field}.time`, 64);
      stringValue(item.title, `${field}.title`, 1_000);
      stringValue(item.description, `${field}.description`, 20_000);
    },
  );

  if (object.evidence !== undefined) {
    validateObjectArray(
      object.evidence,
      "summary.evidence",
      0,
      MAX_EVIDENCE,
      ["time", "fact"],
      (item, field) => {
        stringValue(item.time, `${field}.time`, 64);
        stringValue(item.fact, `${field}.fact`, 20_000);
      },
    );
  }
  if (object.audioAnalysis !== undefined) {
    validateAudioAnalysis(object.audioAnalysis);
  }

  const serialized = JSON.stringify(object);
  if (new TextEncoder().encode(serialized).byteLength > MAX_SUMMARY_BYTES) {
    throw invalidInput("summary 超过 D1 存储限制。");
  }
  try {
    return parseVideoSummary(serialized, fallbackTitle);
  } catch (error) {
    if (error instanceof QwenResponseError) {
      throw invalidInput(`summary 格式无效：${error.message}`);
    }
    throw error;
  }
}

function parseTranscript(value: unknown): VideoTranscript {
  const object = recordValue(value, "transcript");
  assertOnlyKeys(
    object,
    ["status", "text", "cues", "language", "error"],
    "transcript",
  );
  if (object.status !== "ready" && object.status !== "unavailable") {
    throw invalidInput("transcript.status 格式无效。");
  }
  const text = typeof object.text === "string" ? object.text : "";
  const language = optionalString(object.language, "transcript.language", 32);
  const error = optionalString(object.error, "transcript.error", 1_000);
  const cues = validateTranscriptCues(object.cues);
  const result: VideoTranscript = {
    status: object.status,
    text,
    cues,
    ...(language ? { language } : {}),
    ...(error ? { error } : {}),
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_TRANSCRIPT_BYTES
  ) {
    throw invalidInput("transcript 超过 D1 存储限制。");
  }
  return result;
}

function validateTranscriptCues(value: unknown) {
  if (!Array.isArray(value) || value.length > 20_000) {
    throw invalidInput("transcript.cues 格式无效。");
  }
  let previous = -1;
  return value.map((item, index) => {
    const cue = recordValue(item, `transcript.cues[${index}]`);
    assertOnlyKeys(
      cue,
      ["startSeconds", "endSeconds", "text"],
      `transcript.cues[${index}]`,
    );
    const startSeconds = finiteNumber(
      cue.startSeconds,
      `transcript.cues[${index}].startSeconds`,
    );
    const endSeconds = finiteNumber(
      cue.endSeconds,
      `transcript.cues[${index}].endSeconds`,
    );
    if (startSeconds < 0 || endSeconds < startSeconds || startSeconds < previous) {
      throw invalidInput(`transcript.cues[${index}] 时间范围无效。`);
    }
    previous = startSeconds;
    return {
      startSeconds,
      endSeconds,
      text: stringValue(cue.text, `transcript.cues[${index}].text`, 4_000),
    };
  });
}

function validateAudioAnalysis(value: unknown) {
  const object = recordValue(value, "summary.audioAnalysis");
  assertOnlyKeys(
    object,
    [
      "status",
      "summary",
      "speech",
      "music",
      "soundscape",
      "temporalChanges",
      "uncertainty",
    ],
    "summary.audioAnalysis",
  );
  stringValue(object.status, "summary.audioAnalysis.status", 20);
  stringValue(object.summary, "summary.audioAnalysis.summary", 20_000);
  // 旧对话可能包含已废弃的 speech 字段；只做兼容校验，规范化后会丢弃。
  if (object.speech !== undefined) {
    nullableStringValue(object.speech, "summary.audioAnalysis.speech", 20_000);
  }
  nullableStringValue(object.music, "summary.audioAnalysis.music", 20_000);
  nullableStringValue(
    object.soundscape,
    "summary.audioAnalysis.soundscape",
    20_000,
  );
  if (object.uncertainty !== undefined && object.uncertainty !== null) {
    stringValue(
      object.uncertainty,
      "summary.audioAnalysis.uncertainty",
      10_000,
    );
  }
  validateObjectArray(
    object.temporalChanges,
    "summary.audioAnalysis.temporalChanges",
    0,
    MAX_AUDIO_CHANGES,
    ["time", "description"],
    (item, field) => {
      stringValue(item.time, `${field}.time`, 64);
      stringValue(item.description, `${field}.description`, 20_000);
    },
  );
}

function parseMessageInputs(
  value: unknown,
  field: string,
  allowEmpty: boolean,
): ConversationMessageInput[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_MESSAGES_PER_WRITE
  ) {
    throw invalidInput(
      `${field} 必须包含 ${allowEmpty ? "0" : "1"} 到 ${MAX_MESSAGES_PER_WRITE} 条消息。`,
    );
  }
  return value.map((item, index) => {
    const itemField = `${field}[${index}]`;
    const message = recordValue(item, itemField);
    assertOnlyKeys(
      message,
      [
        "role",
        "content",
        "reasoningContent",
        "reasoningDurationSeconds",
        "webSources",
        "stopped",
        "usage",
      ],
      itemField,
    );
    if (message.role !== "assistant" && message.role !== "user") {
      throw invalidInput(`${itemField}.role 格式无效。`);
    }
    const reasoningContent = optionalString(
      message.reasoningContent,
      `${itemField}.reasoningContent`,
      MAX_REASONING_CHARACTERS,
    );
    let reasoningDurationSeconds: number | undefined;
    if (message.reasoningDurationSeconds !== undefined) {
      const duration = finiteNumber(
        message.reasoningDurationSeconds,
        `${itemField}.reasoningDurationSeconds`,
      );
      if (!Number.isSafeInteger(duration) || duration < 0 || duration > 3_600) {
        throw invalidInput(
          `${itemField}.reasoningDurationSeconds 必须是 0 到 3600 的整数。`,
        );
      }
      reasoningDurationSeconds = duration;
    }
    const webSources =
      message.webSources === undefined
        ? undefined
        : parseMessageWebSources(message.webSources, `${itemField}.webSources`);
    if (message.stopped !== undefined && typeof message.stopped !== "boolean") {
      throw invalidInput(`${itemField}.stopped 必须是布尔值。`);
    }
    const usage =
      message.usage === undefined
        ? undefined
        : parseConversationUsageRecord(message.usage);
    if (message.usage !== undefined && !usage) {
      throw invalidInput(`${itemField}.usage 格式无效。`);
    }
    return {
      role: message.role,
      content: stringValue(
        message.content,
        `${itemField}.content`,
        MAX_MESSAGE_CHARACTERS,
      ),
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(reasoningDurationSeconds !== undefined
        ? { reasoningDurationSeconds }
        : {}),
      ...(webSources?.length ? { webSources } : {}),
      ...(message.stopped === true ? { stopped: true } : {}),
      ...(usage ? { usage } : {}),
    };
  });
}

function parseMessageWebSources(
  value: unknown,
  field: string,
): ConversationWebSource[] {
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_WEB_SOURCES) {
    throw invalidInput(
      `${field} 必须包含 0 到 ${MAX_MESSAGE_WEB_SOURCES} 个来源。`,
    );
  }
  const usedIndices = new Set<number>();
  return value.map((entry, index) => {
    const itemField = `${field}[${index}]`;
    const item = recordValue(entry, itemField);
    assertOnlyKeys(item, ["index", "title", "url"], itemField);
    const sourceIndex = finiteNumber(item.index, `${itemField}.index`);
    if (
      !Number.isSafeInteger(sourceIndex) ||
      sourceIndex < 1 ||
      sourceIndex > 99 ||
      usedIndices.has(sourceIndex)
    ) {
      throw invalidInput(`${itemField}.index 格式无效或重复。`);
    }
    usedIndices.add(sourceIndex);
    return {
      index: sourceIndex,
      title: stringValue(item.title, `${itemField}.title`, 500),
      url: stableWebReferenceUrl(
        stringValue(item.url, `${itemField}.url`, 2_048),
        `${itemField}.url`,
      ),
    };
  });
}

function validateObjectArray(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  allowedKeys: readonly string[],
  validate: (item: Record<string, unknown>, field: string) => void,
) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw invalidInput(`${field} 必须包含 ${minimum} 到 ${maximum} 项。`);
  }
  value.forEach((entry, index) => {
    const itemField = `${field}[${index}]`;
    const item = recordValue(entry, itemField);
    assertOnlyKeys(item, allowedKeys, itemField);
    validate(item, itemField);
  });
}

function listItemFromRow(
  row: ConversationListRow | ConversationRow,
): ConversationListItem {
  return {
    id: row.id,
    title: row.title,
    sourceKind: sourceKindValue(row.source_kind),
    createdAt: integerValue(row.created_at, "created_at"),
    updatedAt: integerValue(row.updated_at, "updated_at"),
  };
}

function messageFromRow(
  row: MessageRow,
  detail?: MessageDetailRow,
): ConversationMessage {
  if (row.role !== "assistant" && row.role !== "user") {
    throw new Error("D1 中的消息角色无效。");
  }
  const reasoningContent = detail
    ? optionalString(
        detail.reasoning_content,
        "conversation_message_details.reasoning_content",
        MAX_REASONING_CHARACTERS,
      )
    : undefined;
  const reasoningDurationSeconds =
    detail?.reasoning_duration_seconds === null ||
    detail?.reasoning_duration_seconds === undefined
      ? undefined
      : integerValue(
          detail.reasoning_duration_seconds,
          "conversation_message_details.reasoning_duration_seconds",
        );
  const webSources =
    detail?.web_sources_json
      ? parseMessageWebSources(
          JSON.parse(detail.web_sources_json),
          "conversation_message_details.web_sources_json",
        )
      : undefined;
  const usage = detail?.usage_json
    ? parsePersistedUsage(detail.usage_json)
    : undefined;
  const legacySearchMetadata = extractLegacySearchMetadata(row.content);
  const resolvedWebSources = webSources?.length
    ? webSources
    : legacySearchMetadata.webSources;
  if (detail && detail.stopped !== 0 && detail.stopped !== 1) {
    throw new Error("D1 中的 stopped 字段无效。");
  }
  return {
    id: row.id,
    role: row.role,
    content: legacySearchMetadata.content,
    createdAt: integerValue(row.created_at, "created_at"),
    ...(reasoningContent ? { reasoningContent } : {}),
    ...(reasoningDurationSeconds !== undefined
      ? { reasoningDurationSeconds }
      : {}),
    ...(resolvedWebSources?.length ? { webSources: resolvedWebSources } : {}),
    ...(detail?.stopped === 1 ? { stopped: true } : {}),
    ...(usage ? { usage } : {}),
  };
}

function extractLegacySearchMetadata(content: string): {
  content: string;
  webSources?: ConversationWebSource[];
} {
  const marker = "\n\n参考来源：\n";
  const markerIndex = content.lastIndexOf(marker);
  if (markerIndex < 0) return { content };
  const suffix = content.slice(markerIndex + marker.length);
  const visited = suffix.match(/\n\n访问了\s+\d+\s+个网页\s*$/);
  if (!visited || visited.index === undefined) return { content };
  const sourceBlock = suffix.slice(0, visited.index);
  const webSources: ConversationWebSource[] = [];
  for (const match of sourceBlock.matchAll(
    /^-\s+\[(\d{1,2})\s*·\s*([^\]\r\n]+)\]\((https?:\/\/[^)\s]+)\)\s*$/gm,
  )) {
    const index = Number(match[1]);
    if (
      !Number.isSafeInteger(index) ||
      webSources.some((source) => source.index === index)
    ) {
      continue;
    }
    webSources.push({
      index,
      title: match[2].trim(),
      url: match[3],
    });
  }
  return webSources.length
    ? {
        content: content.slice(0, markerIndex).trim(),
        webSources,
      }
    : { content };
}

function messageMetadata(message: ConversationMessageInput) {
  return {
    ...(message.reasoningContent
      ? { reasoningContent: message.reasoningContent }
      : {}),
    ...(message.reasoningDurationSeconds !== undefined
      ? { reasoningDurationSeconds: message.reasoningDurationSeconds }
      : {}),
    ...(message.webSources?.length ? { webSources: message.webSources } : {}),
    ...(message.stopped ? { stopped: true } : {}),
    ...(message.usage ? { usage: message.usage } : {}),
  };
}

function messageDetailsStatement(
  databaseBinding: D1Database,
  conversationId: string,
  message: ConversationMessageInput & { id: string },
) {
  const hasDetails =
    Boolean(message.reasoningContent) ||
    message.reasoningDurationSeconds !== undefined ||
    Boolean(message.webSources?.length) ||
    Boolean(message.stopped) ||
    Boolean(message.usage);
  if (!hasDetails) return null;
  return databaseBinding
    .prepare(
      `INSERT INTO conversation_message_details (
         message_id, conversation_id, reasoning_content,
         reasoning_duration_seconds, web_sources_json, usage_json, stopped
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      message.id,
      conversationId,
      message.reasoningContent ?? null,
      message.reasoningDurationSeconds ?? null,
      message.webSources?.length ? JSON.stringify(message.webSources) : null,
      message.usage ? JSON.stringify(message.usage) : null,
      message.stopped ? 1 : 0,
    );
}

function parsePersistedUsage(value: string): ConversationUsageRecord {
  const usage = parseConversationUsageRecord(JSON.parse(value));
  if (!usage) {
    throw new Error("D1 中的消息 usage_json 格式无效。");
  }
  return usage;
}

function sourceKindValue(value: string): SourceKind {
  if (value !== "upload" && value !== "bilibili" && value !== "url") {
    throw new Error("D1 中的来源类型无效。");
  }
  return value;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(`${field} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  object: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
) {
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(object).find((key) => !allowed.has(key));
  if (unexpected) {
    throw invalidInput(`${field}.${unexpected} 不是允许保存的字段。`);
  }
}

function stringValue(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidInput(`${field} 必须是非空字符串。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw invalidInput(`${field} 超过长度限制。`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return stringValue(value, field, maxLength);
}

function nullableOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return stringValue(value, field, maxLength);
}

function nullableStringValue(value: unknown, field: string, maxLength: number) {
  if (value === null) return;
  stringValue(value, field, maxLength);
}

function integerValue(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`D1 字段 ${field} 不是有效整数。`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidInput(`${field} 必须是有限数字。`);
  }
  return value;
}

function assertBatchSucceeded(results: D1Result[]) {
  if (results.some((result) => !result.success)) {
    throw new Error("D1 批量写入没有完成。");
  }
}

function assertStatementSucceeded(result: D1Result) {
  if (!result.success) throw new Error("D1 写入没有完成。");
}

function invalidInput(message: string) {
  return new ConversationRouteError(400, "INVALID_CONVERSATION_INPUT", message);
}

function conversationNotFound() {
  return new ConversationRouteError(
    404,
    "CONVERSATION_NOT_FOUND",
    "没有找到这个视频对话。",
  );
}

function noStoreJson(data: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "";
  return `${message}\n${cause}`;
}
