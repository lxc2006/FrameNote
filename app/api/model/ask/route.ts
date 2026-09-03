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
import {
  answeredDecision,
  assessAnswerReadiness,
  requiresMandatoryRecall,
  requiresMandatoryWebSearch,
  unableDecision,
} from "@/lib/server/answer-readiness";
import {
  prepareWebSearch,
  type WebSearchEvidence,
} from "@/lib/server/web-search";
import {
  compactSummaryForPlanning,
  prepareVideoRecall,
  recentConversation,
  type VideoRecallEvidence,
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
          const recentHistory = recentConversation(
            payload.history?.length ? payload.history : storedHistory,
          );
          const archiveHistory = storedHistory.length
            ? storedHistory
            : payload.history ?? [];
          const transcript =
            conversation?.transcript ?? payload.context?.transcript;
          const mustRecall = requiresMandatoryRecall(payload.question);
          const mustSearch = requiresMandatoryWebSearch(payload.question);
          send({
            type: "phase",
            phase: "assess",
            label: "正在理解问题并检查现有资料",
          });
          let readiness = await assessAnswerReadiness(
            {
              stage: "initial",
              question: payload.question,
              source,
              summary,
              history: recentHistory,
              recallEnabled: payload.fullRecallEnabled === true,
              webSearchEnabled: payload.webSearchEnabled === true,
            },
            upstreamAbort.signal,
            config,
            (usage) => usageCalls.push(usage),
          );

          let recall: VideoRecallEvidence | undefined;
          let mandatoryRecallUnavailable = false;
          if (readiness.decision === "recall") {
            if (payload.fullRecallEnabled) {
              send({
                type: "phase",
                phase: "recall",
                label: "正在回顾完整视频资料",
              });
              recall = await prepareVideoRecall(
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
              send({
                type: "phase",
                phase: "reassess",
                label: "正在核对回顾证据",
              });
              readiness = await assessAnswerReadiness(
                {
                  stage: "after_recall",
                  question: payload.question,
                  source,
                  summary,
                  history: recentHistory,
                  recall,
                  recallEnabled: true,
                  webSearchEnabled: payload.webSearchEnabled === true,
                },
                upstreamAbort.signal,
                config,
                (usage) => usageCalls.push(usage),
              );
              if (mustSearch) {
                readiness = {
                  ...readiness,
                  decision: "web",
                  reason: "问题还明确要求联网或依赖外部、时效、官方资料。",
                };
              }
            } else {
              mandatoryRecallUnavailable = mustRecall;
              readiness = unableDecision(
                "initial",
                mustRecall
                  ? "用户要求查看字幕或完整回顾，但完整回顾功能未开启。"
                  : "准确回答需要完整视频资料，但完整回顾功能未开启。",
                readiness,
              );
              if (mustSearch) {
                readiness = {
                  ...readiness,
                  decision: "web",
                };
              }
            }
          }

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
          let webSearch: WebSearchEvidence | undefined;
          if (readiness.decision === "web") {
            if (payload.webSearchEnabled) {
              send({
                type: "phase",
                phase: "search",
                label: "正在检索并核对网页",
              });
              webSearch = await prepareWebSearch(
                {
                  question: payload.question,
                  source,
                  summary: compactSummaryForPlanning(summary),
                  history: recentHistory,
                  locale,
                  region,
                  timeZone,
                  currentDate: new Date().toISOString(),
                  routeReason: readiness.reason,
                  missingFacts: readiness.missingFacts,
                  forceSearch: mustSearch,
                },
                upstreamAbort.signal,
                {
                  onModelUsage: (usage) => usageCalls.push(usage),
                  onSearchRequest: () => {
                    searchCount += 1;
                  },
                },
              );
              readiness =
                webSearch.status === "searched"
                  ? mandatoryRecallUnavailable
                    ? unableDecision(
                        readiness.stage,
                        "已取得联网资料，但用户要求的字幕或完整回顾未开启。",
                        readiness,
                      )
                    : answeredDecision(
                        readiness,
                        "已取得可用于回答的联网证据。",
                      )
                  : unableDecision(
                      readiness.stage,
                      webSearch.note ??
                        "联网检索没有取得可用于回答的公开资料。",
                      readiness,
                    );
            } else {
              readiness = unableDecision(
                readiness.stage,
                mustSearch
                  ? "问题明确需要联网资料，但联网搜索功能未开启。"
                  : "准确回答需要外部资料，但联网搜索功能未开启。",
                readiness,
              );
            }
          }

          send({ type: "phase", phase: "answer", label: "正在生成回答" });
          const result = await new DeepSeekConversationEngine(config).ask(
            payload.question,
            source,
            summary,
            recentHistory,
            {
              reasoningMode: payload.reasoningMode,
              ...(recall ? { recall } : {}),
              readiness,
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
