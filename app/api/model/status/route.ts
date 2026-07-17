import type { ModelStatusResponse } from "@/lib/model-api";
import { getQwenConfig } from "@/lib/server/qwen-config";
import { noStoreJson } from "@/lib/server/model-route";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getQwenConfig();
  const body: ModelStatusResponse = {
    provider: "qwen",
    configured: Boolean(config.apiKey),
    model: config.model,
    acceptedInputs: ["video_url", "frames", "transcript"],
  };
  return noStoreJson(body);
}
