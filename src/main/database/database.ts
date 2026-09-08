import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  ConversationDatabase,
  ConversationQueryResult,
  ConversationStatement,
} from "./conversation-repository";
import { SettingsRepository } from "./settings-repository";
import { WebContentCacheRepository } from "./web-content-cache-repository";

type SQLiteValue = string | number | bigint | Uint8Array | null;

function sqliteValue(value: unknown): SQLiteValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  throw new TypeError("SQLite parameters must be scalar values.");
}

function successfulResult<T>(results: T[] = []): ConversationQueryResult<T> {
  return { success: true, results };
}

class LocalPreparedStatement implements ConversationStatement {
  private readonly values: SQLiteValue[];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
    values: SQLiteValue[] = [],
  ) {
    this.values = values;
  }

  bind(...values: unknown[]): ConversationStatement {
    return new LocalPreparedStatement(
      this.database,
      this.query,
      values.map(sqliteValue),
    );
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.statement().get(...this.values) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T | null;
  }

  async run<T = Record<string, unknown>>(): Promise<ConversationQueryResult<T>> {
    this.runSynchronously();
    return successfulResult<T>();
  }

  async all<T = Record<string, unknown>>(): Promise<ConversationQueryResult<T>> {
    const rows = this.statement().all(...this.values) as T[];
    return successfulResult(rows);
  }

  runSynchronously() {
    this.statement().run(...this.values);
  }

  private statement(): StatementSync {
    return this.database.prepare(this.query);
  }
}

export class DesktopDatabase implements ConversationDatabase {
  private readonly database: DatabaseSync;
  readonly settings: SettingsRepository;
  readonly webContentCache: WebContentCacheRepository;
  private closed = false;

  constructor(readonly filePath: string) {
    this.database = new DatabaseSync(filePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.settings = new SettingsRepository(this.database);
    this.webContentCache = new WebContentCacheRepository(this.database);
  }

  prepare(query: string): ConversationStatement {
    return new LocalPreparedStatement(this.database, query);
  }

  async batch<T = Record<string, unknown>>(
    statements: ConversationStatement[],
  ): Promise<ConversationQueryResult<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof LocalPreparedStatement)) {
          throw new TypeError("The SQLite transaction contains an unknown statement.");
        }
        statement.runSynchronously();
        return successfulResult<T>();
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
