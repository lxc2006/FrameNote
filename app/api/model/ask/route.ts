import type { AskVideoResponse } from "@/lib/model-api";
import {
  modelErrorResponse,
  noStoreJson,
  parseAskVideoRequest,
  readJsonRequest,
} from "@/lib/server/model-route";
import { getDeepSeekConfig } from "@/lib/server/deepseek-config";
import { DeepSeekConversationEngine } from "@/lib/server/deepseek-conversation-engine";
import { prepareWebSearch } from "@/lib/server/web-search";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = parseAskVideoRequest(await readJsonRequest(request));
    const config = getDeepSeekConfig();
    const locale =
      payload.searchContext?.locale ??
      request.headers.get("accept-language")?.split(",")[0]?.trim() ??
      "zh-CN";
    const region =
      request.headers.get("cf-ipcountry") ??
      request.headers.get("x-vercel-ip-country") ??
      "CN";
    const timeZone = payload.searchContext?.timeZone ?? "Asia/Shanghai";
    const webSearch = payload.webSearchEnabled
      ? await prepareWebSearch(
          {
            question: payload.question,
            source: payload.source,
            summary: payload.summary,
            transcript: payload.context?.transcript,
            history: payload.history,
            locale,
            region,
            timeZone,
            ...(payload.searchContext?.transcriptLanguage
              ? {
                  transcriptLanguage:
                    payload.searchContext.transcriptLanguage,
                }
              : {}),
            currentDate: new Date().toISOString(),
          },
          request.signal,
        )
      : undefined;
    const result = await new DeepSeekConversationEngine(config).ask(
      payload.question,
      payload.source,
      payload.summary,
      payload.context?.transcript,
      payload.history,
      {
        reasoningMode: payload.reasoningMode,
        ...(webSearch ? { webSearch } : {}),
      },
    );
    const body: AskVideoResponse = {
      provider: "deepseek",
      model: result.model,
      answer: result.answer,
      ...(webSearch?.status === "searched" ? { webSearchUsed: true } : {}),
      ...(webSearch?.status === "searched"
        ? { visitedPageCount: webSearch.visitedPageCount }
        : {}),
    };
    return noStoreJson(body);
  } catch (error) {
    return modelErrorResponse(error, "deepseek");
  }
}
