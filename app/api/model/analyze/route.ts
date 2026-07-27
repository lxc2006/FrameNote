import type { AnalyzeVideoResponse } from "@/lib/model-api";
import {
  modelErrorResponse,
  noStoreJson,
  parseAnalyzeVideoRequest,
  readJsonRequest,
} from "@/lib/server/model-route";
import { getQwenConfig } from "@/lib/server/qwen-config";
import { QwenVideoEngine } from "@/lib/server/qwen-video-engine";
import { resolveQwenVideoContext } from "@/lib/server/dashscope-video-upload";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = parseAnalyzeVideoRequest(await readJsonRequest(request));
    const config = getQwenConfig();
    const context = await resolveQwenVideoContext(
      payload.source,
      payload.context,
      request.signal,
    );
    const summary = await new QwenVideoEngine(config).analyze(
      payload.source,
      context,
    );
    const body: AnalyzeVideoResponse = {
      provider: "qwen",
      model: config.model,
      summary,
    };
    return noStoreJson(body);
  } catch (error) {
    return modelErrorResponse(error);
  }
}
