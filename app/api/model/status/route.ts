import type { ModelStatusResponse } from "@/lib/model-api";
import { getDeepSeekConfig } from "@/lib/server/deepseek-config";
import { getQwenConfig } from "@/lib/server/qwen-config";
import { noStoreJson } from "@/lib/server/model-route";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getQwenConfig();
  const conversationConfig = getDeepSeekConfig();
  const body: ModelStatusResponse = {
    provider: "qwen",
    configured: Boolean(config.apiKey),
    model: config.model,
    acceptedInputs: ["video_url", "frames", "audio", "transcript"],
    conversation: {
      provider: "deepseek",
      configured: Boolean(conversationConfig.apiKey),
      model: conversationConfig.model,
    },
  };
  return noStoreJson(body);
}
