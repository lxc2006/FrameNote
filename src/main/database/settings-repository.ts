import type { DatabaseSync } from "node:sqlite";
import {
  normalizeUserPreferences,
  type UserPreferences,
} from "../../shared/preference-types";

export class SettingsRepository {
  constructor(private readonly database: DatabaseSync) {
    database.exec(
      `CREATE TABLE IF NOT EXISTS desktop_settings (
         key TEXT PRIMARY KEY NOT NULL,
         value_json TEXT NOT NULL,
         updated_at INTEGER NOT NULL
       )`,
    );
  }

  getUserPreferences(): UserPreferences | null {
    const row = this.database
      .prepare(
        `SELECT value_json
         FROM desktop_settings
         WHERE key = ?`,
      )
      .get("user-preferences") as { value_json: string } | undefined;
    if (!row) return null;

    try {
      return normalizeUserPreferences(JSON.parse(row.value_json));
    } catch {
      return null;
    }
  }

  setUserPreferences(value: unknown): UserPreferences {
    const preferences = normalizeUserPreferences(value);
    this.database
      .prepare(
        `INSERT INTO desktop_settings (key, value_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run("user-preferences", JSON.stringify(preferences), Date.now());
    return preferences;
  }
}
