interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  meta: Record<string, unknown>;
  results: T[];
}

interface D1ExecResult {
  count: number;
  duration: number;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
  dump(): Promise<ArrayBuffer>;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    DASHSCOPE_API_KEY?: string;
    DASHSCOPE_BASE_URL?: string;
    QWEN_VIDEO_MODEL?: string;
    QWEN_REQUEST_TIMEOUT_MS?: string;
    DEEPSEEK_API_KEY?: string;
    DEEPSEEK_BASE_URL?: string;
    DEEPSEEK_CHAT_MODEL?: string;
    DEEPSEEK_REQUEST_TIMEOUT_MS?: string;
    BILIBILI_MEDIA_SERVICE_URL?: string;
    BILIBILI_MEDIA_SERVICE_TOKEN?: string;
    BILIBILI_MEDIA_REQUEST_TIMEOUT_MS?: string;
  };
}
