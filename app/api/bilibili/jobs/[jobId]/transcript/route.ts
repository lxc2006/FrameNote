import {
  bilibiliRouteErrorResponse,
  proxyBilibiliJson,
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
    const response = await requestBilibiliService(
      `/v1/bilibili/jobs/${jobId}/transcript`,
      {
        method: "POST",
        signal: request.signal,
      },
    );
    return proxyBilibiliJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
