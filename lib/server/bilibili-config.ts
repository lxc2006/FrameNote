import { positiveInteger, runtimeValue } from "./runtime-env";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface BilibiliServiceConfig {
  baseURL: string;
  token: string;
  timeoutMs: number;
}

export class BilibiliConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BilibiliConfigurationError";
  }
}

export function getBilibiliServiceConfig(): BilibiliServiceConfig {
  const rawBaseURL = runtimeValue("BILIBILI_MEDIA_SERVICE_URL") ?? "";
  let baseURL = "";

  if (rawBaseURL) {
    try {
      const parsed = new URL(rawBaseURL);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
      if (
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new Error("the service URL must be an origin");
      }
      if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
        throw new Error("remote media services must use HTTPS");
      }
      baseURL = parsed.origin;
    } catch {
      throw new BilibiliConfigurationError(
        "BILIBILI_MEDIA_SERVICE_URL 不是有效的 HTTP(S) 服务地址。",
      );
    }
  }

  return {
    baseURL,
    token: runtimeValue("BILIBILI_MEDIA_SERVICE_TOKEN") ?? "",
    timeoutMs: positiveInteger(
      runtimeValue("BILIBILI_MEDIA_REQUEST_TIMEOUT_MS"),
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
  };
}
