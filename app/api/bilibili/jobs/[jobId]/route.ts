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

async function jobIdFrom(context: RouteContext) {
  const params = await context.params;
  return validateBilibiliJobId(params.jobId);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const jobId = await jobIdFrom(context);
    const response = await requestBilibiliService(`/v1/bilibili/jobs/${jobId}`, {
      method: "GET",
      signal: request.signal,
    });
    return proxyBilibiliJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const jobId = await jobIdFrom(context);
    const response = await requestBilibiliService(`/v1/bilibili/jobs/${jobId}`, {
      method: "DELETE",
      signal: request.signal,
    });
    return proxyBilibiliJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
