import type { DatabaseSync } from "node:sqlite";

const MAX_CACHE_ENTRIES = 12;
const MAX_BODY_CHARACTERS = 100_000;

export interface CachedWebContent {
  originalUrl: string;
  finalUrl: string;
  title?: string;
  publishedAt?: string;
  contentType?: string;
  text: string;
  method: "trafilatura" | "pypdf" | "browser-run";
}

interface CachedWebContentRow {
  canonical_url: string;
  original_url: string;
  title: string | null;
  published_at: string | null;
  content_type: string | null;
  body_text: string;
  extraction_method: CachedWebContent["method"];
}

export class WebContentCacheRepository {
  constructor(private readonly database: DatabaseSync) {
    database.exec(
      `CREATE TABLE IF NOT EXISTS web_content_cache (
         canonical_url TEXT PRIMARY KEY NOT NULL,
         original_url TEXT NOT NULL,
         title TEXT,
         published_at TEXT,
         content_type TEXT,
         body_text TEXT NOT NULL,
         extraction_method TEXT NOT NULL,
         fetched_at INTEGER NOT NULL,
         last_accessed_at INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS web_content_cache_original_url_idx
       ON web_content_cache (original_url);`,
    );
  }

  get(url: string): CachedWebContent | null {
    const canonicalUrl = canonicalizeUrl(url);
    if (!canonicalUrl) return null;
    const row = this.database
      .prepare(
        `SELECT canonical_url, original_url, title, published_at,
                content_type, body_text, extraction_method
         FROM web_content_cache
         WHERE canonical_url = ? OR original_url = ?
         ORDER BY last_accessed_at DESC
         LIMIT 1`,
      )
      .get(canonicalUrl, canonicalUrl) as CachedWebContentRow | undefined;
    if (!row || !isExtractionMethod(row.extraction_method)) return null;
    this.database
      .prepare(
        `UPDATE web_content_cache
         SET last_accessed_at = ?
         WHERE canonical_url = ?`,
      )
      .run(Date.now(), row.canonical_url);
    return {
      originalUrl: row.original_url,
      finalUrl: row.canonical_url,
      ...(row.title ? { title: row.title } : {}),
      ...(row.published_at ? { publishedAt: row.published_at } : {}),
      ...(row.content_type ? { contentType: row.content_type } : {}),
      text: row.body_text,
      method: row.extraction_method,
    };
  }

  put(content: CachedWebContent) {
    const canonicalUrl = canonicalizeUrl(content.finalUrl);
    const originalUrl = canonicalizeUrl(content.originalUrl);
    const text = content.text.slice(0, MAX_BODY_CHARACTERS);
    if (!canonicalUrl || !originalUrl || !text) return;
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO web_content_cache (
           canonical_url, original_url, title, published_at, content_type,
           body_text, extraction_method, fetched_at, last_accessed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(canonical_url) DO UPDATE SET
           original_url = excluded.original_url,
           title = excluded.title,
           published_at = excluded.published_at,
           content_type = excluded.content_type,
           body_text = excluded.body_text,
           extraction_method = excluded.extraction_method,
           fetched_at = excluded.fetched_at,
           last_accessed_at = excluded.last_accessed_at`,
      )
      .run(
        canonicalUrl,
        originalUrl,
        content.title?.slice(0, 240) ?? null,
        content.publishedAt?.slice(0, 80) ?? null,
        content.contentType?.slice(0, 120) ?? null,
        text,
        content.method,
        now,
        now,
      );
    this.database
      .prepare(
        `DELETE FROM web_content_cache
         WHERE canonical_url NOT IN (
           SELECT canonical_url
           FROM web_content_cache
           ORDER BY last_accessed_at DESC
           LIMIT ?
         )`,
      )
      .run(MAX_CACHE_ENTRIES);
  }
}

function canonicalizeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.href;
  } catch {
    return null;
  }
}

function isExtractionMethod(
  value: string,
): value is CachedWebContent["method"] {
  return (
    value === "trafilatura" || value === "pypdf" || value === "browser-run"
  );
}
