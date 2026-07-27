import {
  bilibiliRouteErrorResponse,
  proxyBilibiliJson,
  readTranscriptOptionsRequest,
  requestBilibiliService,
  validateBilibiliJobId,
} from "@/lib/server/bilibili-route";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ jobId: string }> | { jobId: string };
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const params = await context.params;
    const jobId = validateBilibiliJobId(params.jobId);
    const body = await readTranscriptOptionsRequest(request);
    const response = await requestBilibiliService(
      `/v1/bilibili/jobs/${jobId}/transcript`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: request.signal,
      },
    );
    return proxyBilibiliJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
