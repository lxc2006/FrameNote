import {
  bilibiliRouteErrorResponse,
  proxyMediaJson,
  requestBilibiliService,
} from "@/lib/server/bilibili-route";

export const dynamic = "force-dynamic";

const MAX_MEDIA_REQUEST_BYTES = 501 * 1024 * 1024;
const MEDIA_UPLOAD_TIMEOUT_MS = 22 * 60 * 1_000;

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_MEDIA_INPUT",
            message: "视频分析请求必须使用 multipart/form-data。",
            retryable: false,
          },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_MEDIA_REQUEST_BYTES
    ) {
      return new Response(
        JSON.stringify({
          error: {
            code: "VIDEO_TOO_LARGE",
            message: "视频超过 500 MB 分析上限。",
            retryable: false,
          },
        }),
        {
          status: 413,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
    const response = await requestBilibiliService(
      "/v1/media/jobs",
      {
        method: "POST",
        headers: { "content-type": contentType },
        body: request.body,
        signal: request.signal,
      },
      MEDIA_UPLOAD_TIMEOUT_MS,
    );
    return proxyMediaJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
