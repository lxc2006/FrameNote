import type { ConversationDetail } from "../../shared/conversation-types";
import type {
  AnalyzeVideoRequest,
  AnalyzeVideoResponse,
  AskVideoRequest,
  AskVideoResponse,
  AskVideoStreamEvent,
} from "../../shared/model-types";
import {
  conversationUsageRecord,
  type ModelCallUsage,
} from "../../shared/model-usage";
import type { VideoConversationMessage } from "../../shared/media-types";
import {
  assessAnswerReadiness,
  requiresMandatoryRecall,
  requiresMandatoryWebSearch,
  unableDecision,
} from "../model/answer-readiness";
import { getDeepSeekConfig } from "../model/deepseek-config";
import {
  DeepSeekConversationEngine,
  DeepSeekInputError,
} from "../model/deepseek-conversation-engine";
import { resolveQwenVideoContext } from "../model/dashscope-video-upload";
import { getQwenConfig } from "../model/qwen-config";
import { QwenVideoEngine } from "../model/qwen-video-engine";
import {
  prepareVideoRecall,
  recentConversation,
  type VideoRecallEvidence,
} from "../model/video-recall";

export interface AskVideoServiceOptions {
  signal: AbortSignal;
  getConversation?: (conversationId: string) => Promise<ConversationDetail>;
  onEvent?: (event: AskVideoStreamEvent) => void;
}

export async function analyzeVideoService(
  payload: AnalyzeVideoRequest,
  signal?: AbortSignal,
): Promise<AnalyzeVideoResponse> {
  const config = getQwenConfig();
  const context = await resolveQwenVideoContext(
    payload.source,
    payload.context,
    signal,
  );
  const result = await new QwenVideoEngine(config).analyzeWithUsage(
    payload.source,
    context,
    signal,
  );
  return {
    provider: "qwen",
    model: config.model,
    summary: result.summary,
    usage: conversationUsageRecord(
      "summary",
      result.usage ? [result.usage] : [],
    ),
  };
}

export async function askVideoService(
  payload: AskVideoRequest,
  options: AskVideoServiceOptions,
): Promise<AskVideoResponse> {
  const send = options.onEvent ?? (() => undefined);
  const config = getDeepSeekConfig();
  const usageCalls: ModelCallUsage[] = [];
  const conversation =
    payload.conversationId && options.getConversation
      ? await options.getConversation(payload.conversationId)
      : null;
  const source = conversation?.source ?? payload.source;
  const summary = conversation?.summary ?? payload.summary;
  if (!source || !summary) {
    throw new DeepSeekInputError("当前对话缺少可用的视频记忆。");
  }

  const storedHistory: VideoConversationMessage[] =
    conversation?.messages.map(({ role, content }) => ({ role, content })) ?? [];
  const recentHistory = recentConversation(
    payload.history?.length ? payload.history : storedHistory,
  );
  const archiveHistory = storedHistory.length
    ? storedHistory
    : payload.history ?? [];
  const previousWebSources = conversation?.messages
    .slice()
    .reverse()
    .flatMap((message) => message.webSources ?? [])
    .filter(
      (source, index, sources) =>
        sources.findIndex((candidate) => candidate.url === source.url) === index,
    )
    .slice(0, 12);
  const transcript = conversation?.transcript ?? payload.context?.transcript;
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
    options.signal,
    config,
    (usage) => usageCalls.push(usage),
  );

  let recall: VideoRecallEvidence | undefined;
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
        options.signal,
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
        options.signal,
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
      readiness = unableDecision(
        "initial",
        mustRecall
          ? "用户要求查看字幕或完整回顾，但完整回顾功能未开启。"
          : "准确回答需要完整视频资料，但完整回顾功能未开启。",
        readiness,
      );
      if (mustSearch) {
        readiness = { ...readiness, decision: "web" };
      }
    }
  }

  if (readiness.decision === "web" && !payload.webSearchEnabled) {
    readiness = unableDecision(
      readiness.stage,
      mustSearch
        ? "问题明确需要联网资料，但联网搜索功能未开启。"
        : "准确回答需要外部资料，但联网搜索功能未开启。",
      readiness,
    );
  }

  send({ type: "phase", phase: "answer", label: "正在生成回答" });
  let searchPhaseActive = false;
  const result = await new DeepSeekConversationEngine(config).ask(
    payload.question,
    source,
    summary,
    recentHistory,
    {
      reasoningMode: payload.reasoningMode,
      ...(recall ? { recall } : {}),
      readiness,
      signal: options.signal,
      webSearchEnabled: payload.webSearchEnabled === true,
      forceWebSearch:
        payload.webSearchEnabled === true &&
        (mustSearch || readiness.decision === "web"),
      ...(previousWebSources.length ? { previousWebSources } : {}),
      onWebSearch: () => {
        searchPhaseActive = true;
        send({
          type: "phase",
          phase: "search",
          label: "DeepSeek 正在联网检索并核对来源",
        });
      },
      onReasoningDelta: (delta) => {
        if (searchPhaseActive) {
          searchPhaseActive = false;
          send({ type: "phase", phase: "answer", label: "正在生成回答" });
        }
        send({ type: "reasoning_delta", delta });
      },
      onAnswerDelta: (delta) => {
        if (searchPhaseActive) {
          searchPhaseActive = false;
          send({ type: "phase", phase: "answer", label: "正在生成回答" });
        }
        send({ type: "answer_delta", delta });
      },
    },
  );
  if (result.usage) usageCalls.push(result.usage);

  const response: AskVideoResponse = {
    provider: "deepseek",
    model: result.model,
    answer: result.answer,
    ...(result.reasoningContent
      ? { reasoningContent: result.reasoningContent }
      : {}),
    ...(result.reasoningDurationSeconds !== undefined
      ? { reasoningDurationSeconds: result.reasoningDurationSeconds }
      : {}),
    ...(result.webSources?.length ? { webSources: result.webSources } : {}),
    ...(result.webSearch ? { webSearch: result.webSearch } : {}),
    ...(result.webSearch?.requestIssued
      ? {
          webSearchUsed: true,
          visitedPageCount: result.webSources?.length ?? 0,
        }
      : {}),
    usage: conversationUsageRecord("answer", usageCalls, result.searchCount),
  };
  send({ type: "done", ...response });
  return response;
}
