import type { AskVideoResponse } from "@/lib/model-api";
import {
  modelErrorResponse,
  noStoreJson,
  parseAskVideoRequest,
  readJsonRequest,
} from "@/lib/server/model-route";
import { getDeepSeekConfig } from "@/lib/server/deepseek-config";
import { DeepSeekConversationEngine } from "@/lib/server/deepseek-conversation-engine";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = parseAskVideoRequest(await readJsonRequest(request));
    const config = getDeepSeekConfig();
    const answer = await new DeepSeekConversationEngine(config).ask(
      payload.question,
      payload.source,
      payload.summary,
      payload.history,
    );
    const body: AskVideoResponse = {
      provider: "deepseek",
      model: config.model,
      answer,
    };
    return noStoreJson(body);
  } catch (error) {
    return modelErrorResponse(error, "deepseek");
  }
}
