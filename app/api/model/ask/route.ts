import type { AskVideoResponse } from "@/lib/model-api";
import {
  modelErrorResponse,
  noStoreJson,
  parseAskVideoRequest,
  readJsonRequest,
} from "@/lib/server/model-route";
import { getQwenConfig } from "@/lib/server/qwen-config";
import { QwenVideoEngine } from "@/lib/server/qwen-video-engine";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = parseAskVideoRequest(await readJsonRequest(request));
    const config = getQwenConfig();
    const answer = await new QwenVideoEngine(config).ask(
      payload.question,
      payload.source,
      payload.summary,
      payload.context,
      payload.history,
    );
    const body: AskVideoResponse = {
      provider: "qwen",
      model: config.model,
      answer,
    };
    return noStoreJson(body);
  } catch (error) {
    return modelErrorResponse(error);
  }
}
