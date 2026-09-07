import { BilibiliConfigurationError } from "../../media/bilibili-config";
import {
  MediaServiceUnavailableError,
  requestMediaService,
} from "../../media/media-service-client";
import { positiveInteger, runtimeValue } from "../../config/app-env";

const DEFAULT_EXTRACT_TIMEOUT_MS = 20_000;
const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
const MAX_DOCUMENT_CHARACTERS = 180_000;

export interface ExtractedWebDocument {
  url: string;
  finalUrl: string;
  title?: string;
  publishedAt?: string;
  contentType?: string;
  text: string;
  method: "trafilatura" | "pypdf" | "browser-run";
}

export type WebDocumentExtractionResult =
  | { ok: true; document: ExtractedWebDocument }
  | { ok: false; code: string; message: string };

interface MediaExtractResponse {
  status?: unknown;
  url?: unknown;
  finalUrl?: unknown;
  title?: unknown;
  publishedAt?: unknown;
  contentType?: unknown;
  text?: unknown;
  method?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
}

export async function extractWebDocument(
  url: string,
  signal?: AbortSignal,
): Promise<WebDocumentExtractionResult> {
  let mediaServiceUnavailable = false;
  try {
    const response = await requestMediaService(
      "/v1/web/extract",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
        signal,
      },
      positiveInteger(
        runtimeValue("WEB_CONTENT_EXTRACT_TIMEOUT_MS"),
        DEFAULT_EXTRACT_TIMEOUT_MS,
      ),
    );
    const body = (await response.json().catch(() => null)) as
      | MediaExtractResponse
      | null;
    if (response.ok && body?.status === "ok") {
      const text = stringValue(body.text);
      const finalUrl = publicHttpUrl(stringValue(body.finalUrl) ?? url);
      const method = body.method;
      if (
        text &&
        finalUrl &&
        (method === "trafilatura" || method === "pypdf")
      ) {
        return {
          ok: true,
          document: {
            url,
            finalUrl,
            ...(stringValue(body.title) ? { title: stringValue(body.title) } : {}),
            ...(stringValue(body.publishedAt)
              ? { publishedAt: stringValue(body.publishedAt) }
              : {}),
            ...(stringValue(body.contentType)
              ? { contentType: stringValue(body.contentType) }
              : {}),
            text: text.slice(0, MAX_DOCUMENT_CHARACTERS),
            method,
          },
        };
      }
      return {
        ok: false,
        code: "INVALID_EXTRACT_RESPONSE",
        message: "媒体核心返回了无法使用的网页正文。",
      };
    }
    if (body?.status !== "requires_browser") {
      return {
        ok: false,
        code: stringValue(body?.errorCode) ?? `HTTP_${response.status}`,
        message:
          stringValue(body?.errorMessage) ??
          `网页正文读取失败（HTTP ${response.status}）。`,
      };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    if (
      error instanceof BilibiliConfigurationError ||
      error instanceof MediaServiceUnavailableError
    ) {
      mediaServiceUnavailable = true;
    } else {
      return {
        ok: false,
        code: "WEB_EXTRACT_REQUEST_FAILED",
        message: safeErrorMessage(error, "网页正文读取请求失败。"),
      };
    }
  }

  const browserResult = await extractWithBrowserRun(url, signal);
  if (browserResult.ok) return browserResult;
  if (mediaServiceUnavailable) {
    return {
      ok: false,
      code: "MEDIA_SERVICE_UNAVAILABLE",
      message: `媒体核心不可用；${browserResult.message}`,
    };
  }
  return browserResult;
}

async function extractWithBrowserRun(
  url: string,
  signal?: AbortSignal,
): Promise<WebDocumentExtractionResult> {
  const accountId = runtimeValue("CLOUDFLARE_ACCOUNT_ID");
  const apiToken =
    runtimeValue("CLOUDFLARE_BROWSER_RUN_API_TOKEN") ??
    runtimeValue("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
  const publicUrl = publicHttpUrl(url);
  if (!publicUrl) {
    return {
      ok: false,
      code: "INVALID_PUBLIC_URL",
      message: "搜索结果不是可访问的公开网页地址。",
    };
  }
  if (!accountId || !apiToken) {
    return {
      ok: false,
      code: "BROWSER_FALLBACK_NOT_CONFIGURED",
      message: "网页需要浏览器渲染，但尚未配置浏览器渲染服务。",
    };
  }

  const timeoutSignal = AbortSignal.timeout(
    positiveInteger(
      runtimeValue("CLOUDFLARE_BROWSER_RUN_TIMEOUT_MS"),
      DEFAULT_BROWSER_TIMEOUT_MS,
    ),
  );
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        accountId,
      )}/browser-rendering/markdown`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          url: publicUrl,
          gotoOptions: { waitUntil: "networkidle0", timeout: 20_000 },
        }),
        signal: requestSignal,
      },
    );
    const body = (await response.json().catch(() => null)) as
      | Record<string, unknown>
      | null;
    if (!response.ok || !body || body.success !== true) {
      return {
        ok: false,
        code: `BROWSER_RENDER_HTTP_${response.status}`,
        message: `浏览器渲染没有取得网页正文（HTTP ${response.status}）。`,
      };
    }
    const result = body.result;
    const markdown =
      typeof result === "string"
        ? result
        : result &&
            typeof result === "object" &&
            typeof (result as Record<string, unknown>).markdown === "string"
          ? ((result as Record<string, unknown>).markdown as string)
          : undefined;
    const text = markdown?.trim();
    if (!text || text.length < 160) {
      return {
        ok: false,
        code: "BROWSER_RENDER_NO_TEXT",
        message: "浏览器渲染完成，但没有取得足够的网页正文。",
      };
    }
    return {
      ok: true,
      document: {
        url: publicUrl,
        finalUrl: publicUrl,
        text: text.slice(0, MAX_DOCUMENT_CHARACTERS),
        method: "browser-run",
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      ok: false,
      code: "BROWSER_RENDER_FAILED",
      message: safeErrorMessage(error, "浏览器渲染请求失败。"),
    };
  }
}

function safeErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim().slice(0, 500)
    : fallback;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function publicHttpUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      isPrivateHostname(url.hostname)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".local") ||
    normalized === "::1"
  ) {
    return true;
  }
  if (/^127\./.test(normalized) || /^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  const private172 = normalized.match(/^172\.(\d{1,3})\./);
  if (private172) {
    const second = Number(private172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return normalized === "0.0.0.0" || normalized === "[::1]";
}
