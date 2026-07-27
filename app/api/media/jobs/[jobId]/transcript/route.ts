import {
  bilibiliRouteErrorResponse,
  proxyMediaJson,
  readTranscriptOptionsRequest,
  requestBilibiliService,
  validateBilibiliJobId,
} from "@/lib/server/bilibili-route";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { jobId } = await context.params;
    const validatedJobId = validateBilibiliJobId(jobId);
    const body = await readTranscriptOptionsRequest(request);
    const response = await requestBilibiliService(
      `/v1/media/jobs/${validatedJobId}/transcript`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: request.signal,
      },
    );
    return proxyMediaJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
