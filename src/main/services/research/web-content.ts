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
): Promise<ExtractedWebDocument | null> {
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
        };
      }
      return null;
    }
    if (body?.status !== "requires_browser") return null;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (
      error instanceof BilibiliConfigurationError ||
      error instanceof MediaServiceUnavailableError
    ) {
      mediaServiceUnavailable = true;
    } else {
      return null;
    }
  }

  const browserResult = await extractWithBrowserRun(url, signal);
  if (browserResult) return browserResult;
  if (mediaServiceUnavailable) return null;
  return null;
}

async function extractWithBrowserRun(
  url: string,
  signal?: AbortSignal,
): Promise<ExtractedWebDocument | null> {
  const accountId = runtimeValue("CLOUDFLARE_ACCOUNT_ID");
  const apiToken =
    runtimeValue("CLOUDFLARE_BROWSER_RUN_API_TOKEN") ??
    runtimeValue("CLOUDFLARE_BROWSER_RENDERING_API_TOKEN");
  const publicUrl = publicHttpUrl(url);
  if (!accountId || !apiToken || !publicUrl) return null;

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
    if (!response.ok || !body || body.success !== true) return null;
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
    if (!text || text.length < 160) return null;
    return {
      url: publicUrl,
      finalUrl: publicUrl,
      text: text.slice(0, MAX_DOCUMENT_CHARACTERS),
      method: "browser-run",
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
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
