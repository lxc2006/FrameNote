import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    title: text("title").notNull(),
    sourceKind: text("source_kind", {
      enum: ["upload", "bilibili", "url"],
    }).notNull(),
    sourceJson: text("source_json").notNull(),
    summaryJson: text("summary_json").notNull(),
    activeModel: text("active_model"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("conversations_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt,
    ),
  ],
);

export const conversationMessages = sqliteTable(
  "conversation_messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    role: text("role", { enum: ["assistant", "user"] }).notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("conversation_messages_sequence_idx").on(
      table.conversationId,
      table.sequence,
    ),
  ],
);

export const conversationMessageDetails = sqliteTable(
  "conversation_message_details",
  {
    messageId: text("message_id")
      .primaryKey()
      .references(() => conversationMessages.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    reasoningContent: text("reasoning_content"),
    reasoningDurationSeconds: integer("reasoning_duration_seconds"),
    webSourcesJson: text("web_sources_json"),
    usageJson: text("usage_json"),
    stopped: integer("stopped", { mode: "boolean" }).notNull().default(false),
  },
);

export const conversationTranscripts = sqliteTable(
  "conversation_transcripts",
  {
    conversationId: text("conversation_id")
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    transcriptJson: text("transcript_json").notNull(),
  },
);
