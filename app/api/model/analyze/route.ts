import type { AnalyzeVideoResponse } from "@/lib/model-api";
import {
  modelErrorResponse,
  noStoreJson,
  parseAnalyzeVideoRequest,
  readJsonRequest,
} from "@/lib/server/model-route";
import { getQwenConfig } from "@/lib/server/qwen-config";
import { QwenVideoEngine } from "@/lib/server/qwen-video-engine";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = parseAnalyzeVideoRequest(await readJsonRequest(request));
    const config = getQwenConfig();
    const summary = await new QwenVideoEngine(config).analyze(
      payload.source,
      payload.context,
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
