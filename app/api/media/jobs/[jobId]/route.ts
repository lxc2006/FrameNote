import {
  bilibiliRouteErrorResponse,
  proxyMediaJson,
  requestBilibiliService,
  validateBilibiliJobId,
} from "@/lib/server/bilibili-route";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ jobId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  return proxyJobRequest(request, context, "GET");
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxyJobRequest(request, context, "DELETE");
}

async function proxyJobRequest(
  request: Request,
  context: RouteContext,
  method: "GET" | "DELETE",
) {
  try {
    const { jobId } = await context.params;
    const validatedJobId = validateBilibiliJobId(jobId);
    const response = await requestBilibiliService(
      `/v1/media/jobs/${validatedJobId}`,
      { method, signal: request.signal },
    );
    return proxyMediaJson(response);
  } catch (error) {
    return bilibiliRouteErrorResponse(error);
  }
}
