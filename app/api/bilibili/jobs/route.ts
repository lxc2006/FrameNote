import {
  bilibiliRouteErrorResponse,
  proxyBilibiliJson,
  readCreateBilibiliJobRequest,
  requestBilibiliService,
} from "@/lib/server/bilibili-route";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await readCreateBilibiliJobRequest(request);
    const response = await requestBilibiliService("/v1/bilibili/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: request.signal,
    });
    return proxyBilibiliJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
