import type {
  AskVideoRequest,
  AskVideoStreamEvent,
  ModelApiErrorBody,
} from "@/lib/model-api";
import {
  modelErrorResponse,
  parseAskVideoRequest,
  readJsonRequest,
} from "@/lib/server/model-route";
import {
  ConversationRouteError,
  conversationErrorResponse,
  getConversation,
  ownerIdFromRequest,
} from "@/lib/server/conversation-store";
import { getDeepSeekConfig } from "@/lib/server/deepseek-config";
import {
  DeepSeekConversationEngine,
  DeepSeekInputError,
} from "@/lib/server/deepseek-conversation-engine";
import { prepareWebSearch } from "@/lib/server/web-search";
import {
  compactSummaryForPlanning,
  prepareVideoRecall,
  recallEvidenceText,
  recentConversation,
} from "@/lib/server/video-recall";
import type { VideoConversationMessage } from "@/lib/video-engine";
import {
  conversationUsageRecord,
  type ModelCallUsage,
} from "@/lib/model-usage";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let payload: AskVideoRequest;
  try {
    payload = parseAskVideoRequest(await readJsonRequest(request));
  } catch (error) {
    if (error instanceof ConversationRouteError) {
      return conversationErrorResponse(error);
    }
    return modelErrorResponse(error, "deepseek");
  }

  const encoder = new TextEncoder();
  const upstreamAbort = new AbortController();
  const abortUpstream = () => upstreamAbort.abort();
  request.signal.addEventListener("abort", abortUpstream, { once: true });
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AskVideoStreamEvent) => {
        if (closed || upstreamAbort.signal.aborted) return;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      void (async () => {
        try {
          const config = getDeepSeekConfig();
          const usageCalls: ModelCallUsage[] = [];
          let searchCount = 0;
          const conversation = payload.conversationId
            ? await getConversation(
                ownerIdFromRequest(request),
                payload.conversationId,
              )
            : null;
          const source = conversation?.source ?? payload.source;
          const summary = conversation?.summary ?? payload.summary;
          if (!source || !summary) {
            throw new DeepSeekInputError(
              "当前对话缺少可用的视频记忆。",
            );
          }
          const storedHistory: VideoConversationMessage[] =
            conversation?.messages.map(({ role, content }) => ({
              role,
              content,
            })) ?? [];
          const recentHistory =
            payload.history?.length
              ? payload.history
              : recentConversation(storedHistory);
          const archiveHistory = storedHistory.length
            ? storedHistory
            : payload.history ?? [];
          const transcript =
            conversation?.transcript ?? payload.context?.transcript;
          const recall = payload.fullRecallEnabled
            ? await (async () => {
                send({
                  type: "phase",
                  phase: "recall",
                  label: "正在完整回顾视频内容",
                });
                return prepareVideoRecall(
                  {
                    question: payload.question,
                    source,
                    summary,
                    transcript,
                    history: archiveHistory,
                  },
                  upstreamAbort.signal,
                  config,
                  (usage) => usageCalls.push(usage),
                );
              })()
            : undefined;

          const locale =
            payload.searchContext?.locale ??
            request.headers.get("accept-language")?.split(",")[0]?.trim() ??
            "zh-CN";
          const region =
            request.headers.get("cf-ipcountry") ??
            request.headers.get("x-vercel-ip-country") ??
            "CN";
          const timeZone =
            payload.searchContext?.timeZone ?? "Asia/Shanghai";
          if (payload.webSearchEnabled) {
            send({
              type: "phase",
              phase: "search",
              label: "正在检索并核对网页",
            });
          }
          const webSearch = payload.webSearchEnabled
            ? await prepareWebSearch(
                {
                  question: payload.question,
                  source,
                  summary: compactSummaryForPlanning(summary),
                  transcript: recall
                    ? recallEvidenceText(recall)
                    : undefined,
                  history: recentHistory,
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
                upstreamAbort.signal,
                {
                  onModelUsage: (usage) => usageCalls.push(usage),
                  onSearchRequest: () => {
                    searchCount += 1;
                  },
                },
              )
            : undefined;

          send({ type: "phase", phase: "answer", label: "正在生成回答" });
          const result = await new DeepSeekConversationEngine(config).ask(
            payload.question,
            source,
            summary,
            recentHistory,
            {
              reasoningMode: payload.reasoningMode,
              ...(recall ? { recall } : {}),
              signal: upstreamAbort.signal,
              onReasoningDelta: (delta) =>
                send({ type: "reasoning_delta", delta }),
              onAnswerDelta: (delta) =>
                send({ type: "answer_delta", delta }),
              ...(webSearch ? { webSearch } : {}),
            },
          );
          if (result.usage) usageCalls.push(result.usage);
          send({
            type: "done",
            provider: "deepseek",
            model: result.model,
            answer: result.answer,
            ...(result.reasoningContent
              ? { reasoningContent: result.reasoningContent }
              : {}),
            ...(result.reasoningDurationSeconds !== undefined
              ? {
                  reasoningDurationSeconds:
                    result.reasoningDurationSeconds,
                }
              : {}),
            ...(result.webSources?.length
              ? { webSources: result.webSources }
              : {}),
            ...(webSearch?.status === "searched"
              ? {
                  webSearchUsed: true,
                  visitedPageCount: webSearch.visitedPageCount,
                }
              : {}),
            usage: conversationUsageRecord(
              "answer",
              usageCalls,
              searchCount,
            ),
          });
        } catch (error) {
          if (!upstreamAbort.signal.aborted) {
            send({
              type: "error",
              error: await streamErrorPayload(error),
            });
          }
        } finally {
          request.signal.removeEventListener("abort", abortUpstream);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              // The browser can close the response before the upstream abort settles.
            }
          }
        }
      })();
    },
    cancel() {
      closed = true;
      upstreamAbort.abort();
      request.signal.removeEventListener("abort", abortUpstream);
    },
  });

  return new Response(stream, {
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

async function streamErrorPayload(
  error: unknown,
): Promise<ModelApiErrorBody["error"]> {
  const response =
    error instanceof ConversationRouteError
      ? conversationErrorResponse(error)
      : modelErrorResponse(error, "deepseek");
  const payload = (await response.json()) as {
    error?: Partial<ModelApiErrorBody["error"]>;
  };
  return {
    code: payload.error?.code ?? "MODEL_INTERNAL_ERROR",
    message: payload.error?.message ?? "模型服务发生内部错误。",
    retryable:
      payload.error?.retryable ?? response.status >= 500,
  };
}
