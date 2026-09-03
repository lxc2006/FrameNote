import {
  bilibiliRouteErrorResponse,
  proxyBilibiliPreviewJson,
  readBilibiliPreviewRequest,
  requestBilibiliService,
} from "@/lib/server/bilibili-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await readBilibiliPreviewRequest(request);
    const response = await requestBilibiliService(
      "/v1/bilibili/preview",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: request.signal,
      },
      45_000,
    );
    return proxyBilibiliPreviewJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
