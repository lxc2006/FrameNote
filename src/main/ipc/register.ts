import { app, clipboard, ipcMain, type IpcMainInvokeEvent } from "electron";
import type { AnalyzeVideoResponse, AskVideoResponse } from "../../shared/model-types";
import { ConversationService } from "../services/conversation-service";
import {
  analyzeVideoService,
  askVideoService,
} from "../services/model-service";
import { conversationErrorDetails } from "../database/conversation-repository";
import {
  modelErrorDetails,
  parseAnalyzeVideoRequest,
  parseAskVideoRequest,
} from "../model/model-validation";
import type { UserPreferences } from "../../shared/preference-types";
import {
  DESKTOP_CHANNELS,
  type DesktopIpcError,
  type DesktopIpcResult,
  type DesktopModelEvent,
  type DesktopTranscriptionProgress,
} from "../../shared/ipc-contract";
import type { DesktopDatabase } from "../database/database";
import type { MediaSidecarManager } from "../media/media-sidecar";
import type { DouyinCookieSession } from "../media/douyin-cookie-session";
import type { CredentialStore } from "../security/credential-store";
import type { ModelCredentialUpdate } from "../../shared/credential-types";
import {
  QwenAsrError,
  transcribeMediaJob,
} from "../model/qwen-asr-service";
import type {
  TranscriptLanguage,
  VideoTranscript,
} from "../../shared/media-types";

const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const activeModelRequests = new Map<string, AbortController>();

function success<T>(value: T): DesktopIpcResult<T> {
  return { ok: true, value };
}

function failure<T>(error: DesktopIpcError): DesktopIpcResult<T> {
  return { ok: false, error };
}

function requestKey(event: IpcMainInvokeEvent, requestId: string) {
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new TypeError("桌面请求标识无效。");
  }
  return `${event.sender.id}:${requestId.toLowerCase()}`;
}

async function runModelRequest<T>(
  event: IpcMainInvokeEvent,
  requestId: string,
  provider: "qwen" | "deepseek",
  work: (signal: AbortSignal) => Promise<T>,
): Promise<DesktopIpcResult<T>> {
  let key: string;
  try {
    key = requestKey(event, requestId);
  } catch (error) {
    return failure({
      code: "INVALID_DESKTOP_REQUEST",
      message: error instanceof Error ? error.message : "桌面请求无效。",
      retryable: false,
    });
  }
  if (activeModelRequests.has(key)) {
    return failure({
      code: "DUPLICATE_DESKTOP_REQUEST",
      message: "这个桌面模型请求正在执行。",
      retryable: false,
    });
  }

  const controller = new AbortController();
  const abortWhenRendererCloses = () => controller.abort();
  activeModelRequests.set(key, controller);
  event.sender.once("destroyed", abortWhenRendererCloses);
  try {
    return success(await work(controller.signal));
  } catch (error) {
    if (controller.signal.aborted) {
      return failure({
        code: "MODEL_REQUEST_ABORTED",
        message: "模型请求已取消。",
        retryable: true,
      });
    }
    if (error instanceof QwenAsrError) {
      return failure({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    }
    const details = modelErrorDetails(error, provider);
    return failure({
      code: details.code,
      message: details.message,
      retryable: details.retryable,
    });
  } finally {
    event.sender.removeListener("destroyed", abortWhenRendererCloses);
    activeModelRequests.delete(key);
  }
}

async function runConversationRequest<T>(
  work: () => Promise<T>,
): Promise<DesktopIpcResult<T>> {
  try {
    return success(await work());
  } catch (error) {
    const details = conversationErrorDetails(error);
    return failure({
      code: details.code,
      message: details.message,
      retryable: details.retryable,
    });
  }
}

function runSettingsRequest<T>(work: () => T): DesktopIpcResult<T> {
  try {
    return success(work());
  } catch (error) {
    console.error("Unexpected desktop settings error", error);
    return failure({
      code: "DESKTOP_SETTINGS_ERROR",
      message: "无法读写桌面设置。",
      retryable: true,
    });
  }
}

export function registerDesktopIpc(
  database: DesktopDatabase,
  conversations: ConversationService,
  mediaSidecar: MediaSidecarManager,
  credentialStore: CredentialStore,
  douyinCookieSession: DouyinCookieSession,
) {
  process.env.FRAMENOTE_WEB_SEARCH_PROVIDER =
    database.settings.getUserPreferences()?.webSearchProvider ?? "serpapi";

  ipcMain.handle(DESKTOP_CHANNELS.getRuntimeInfo, () => ({
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
  }));

  ipcMain.handle(
    DESKTOP_CHANNELS.clipboardWriteText,
    (_event, value: unknown): DesktopIpcResult<void> => {
      if (typeof value !== "string" || value.length > 1_000_000) {
        return failure({
          code: "INVALID_CLIPBOARD_TEXT",
          message: "要复制的文本无效或过长。",
          retryable: false,
        });
      }
      try {
        clipboard.writeText(value);
        return success(undefined);
      } catch (error) {
        console.error("Unable to write desktop clipboard", error);
        return failure({
          code: "CLIPBOARD_WRITE_FAILED",
          message: "无法写入系统剪贴板。",
          retryable: true,
        });
      }
    },
  );

  ipcMain.handle(DESKTOP_CHANNELS.mediaGetConnection, () => {
    try {
      return success(mediaSidecar.getConnection());
    } catch (error) {
      return failure({
        code: "MEDIA_SIDECAR_UNAVAILABLE",
        message:
          error instanceof Error
            ? error.message
            : "媒体核心 sidecar 尚未就绪。",
        retryable: true,
      });
    }
  });

  ipcMain.handle(DESKTOP_CHANNELS.mediaPrepareDouyinSession, async () => {
    try {
      await douyinCookieSession.prepare();
      return success(undefined);
    } catch (error) {
      return failure({
        code: "DOUYIN_COOKIE_SESSION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "无法建立抖音匿名会话。",
        retryable: true,
      });
    }
  });

  ipcMain.handle(
    DESKTOP_CHANNELS.modelAnalyze,
    (event, requestId: string, value: unknown) =>
      runModelRequest<AnalyzeVideoResponse>(
        event,
        requestId,
        "qwen",
        (signal) => analyzeVideoService(parseAnalyzeVideoRequest(value), signal),
      ),
  );

  ipcMain.handle(
    DESKTOP_CHANNELS.modelAsk,
    (event, requestId: string, value: unknown) =>
      runModelRequest<AskVideoResponse>(
        event,
        requestId,
        "deepseek",
        (signal) =>
          askVideoService(parseAskVideoRequest(value), {
            signal,
            getConversation: (conversationId) =>
              conversations.get(conversationId),
            locale: app.getLocale() || "zh-CN",
            region: "CN",
            timeZone:
              Intl.DateTimeFormat().resolvedOptions().timeZone ||
              "Asia/Shanghai",
            webContentCache: database.webContentCache,
            onEvent: (modelEvent) => {
              if (event.sender.isDestroyed()) return;
              const message: DesktopModelEvent = {
                requestId,
                event: modelEvent,
              };
              event.sender.send(DESKTOP_CHANNELS.modelEvent, message);
            },
          }),
      ),
  );

  ipcMain.handle(
    DESKTOP_CHANNELS.transcriptionExtract,
    (
      event,
      requestId: string,
      input: {
        jobId: string;
        jobKind: "media" | "bilibili";
        languages: TranscriptLanguage[];
      },
    ) =>
      runModelRequest<VideoTranscript>(
        event,
        requestId,
        "qwen",
        (signal) =>
          transcribeMediaJob(input, signal, (progress) => {
            if (event.sender.isDestroyed()) return;
            const message: DesktopTranscriptionProgress = {
              requestId,
              ...progress,
            };
            event.sender.send(DESKTOP_CHANNELS.transcriptionProgress, message);
          }),
      ),
  );

  ipcMain.on(
    DESKTOP_CHANNELS.modelCancel,
    (event, requestId: string) => {
      try {
        activeModelRequests.get(requestKey(event, requestId))?.abort();
      } catch {
        // Invalid cancellation identifiers cannot affect active requests.
      }
    },
  );

  ipcMain.handle(DESKTOP_CHANNELS.conversationsList, () =>
    runConversationRequest(() => conversations.list()),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.conversationsCreate,
    (_event, value: unknown) =>
      runConversationRequest(() => conversations.create(value)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.conversationsGet,
    (_event, conversationId: string) =>
      runConversationRequest(() => conversations.get(conversationId)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.conversationsRename,
    (_event, conversationId: string, title: string) =>
      runConversationRequest(() => conversations.rename(conversationId, { title })),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.conversationsUpdateTranscript,
    (_event, conversationId: string, transcript: unknown) =>
      runConversationRequest(() =>
        conversations.updateTranscript(conversationId, { transcript }),
      ),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.conversationsDelete,
    (_event, conversationId: string) =>
      runConversationRequest(() => conversations.delete(conversationId)),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.conversationsAppendMessages,
    (_event, conversationId: string, messages: unknown) =>
      runConversationRequest(() =>
        conversations.appendMessages(conversationId, { messages }),
      ),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.conversationsTruncateMessages,
    (_event, conversationId: string, fromMessageId: string) =>
      runConversationRequest(() =>
        conversations.truncateMessages(conversationId, { fromMessageId }),
      ),
  );

  ipcMain.handle(DESKTOP_CHANNELS.settingsGetUserPreferences, () =>
    runSettingsRequest(() => database.settings.getUserPreferences()),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.settingsSetUserPreferences,
    (_event, preferences: UserPreferences) =>
    runSettingsRequest(() => {
      const saved = database.settings.setUserPreferences(preferences);
      process.env.FRAMENOTE_WEB_SEARCH_PROVIDER = saved.webSearchProvider;
      return saved;
    }),
  );
  ipcMain.handle(DESKTOP_CHANNELS.credentialsGetStatus, () =>
    runSettingsRequest(() => credentialStore.getStatus()),
  );
  ipcMain.handle(
    DESKTOP_CHANNELS.credentialsUpdate,
    async (_event, update: ModelCredentialUpdate) => {
      try {
        return success(await credentialStore.update(update));
      } catch (error) {
        console.error("Unable to update encrypted API credentials", error);
        return failure({
          code: "CREDENTIAL_UPDATE_ERROR",
          message: error instanceof Error ? error.message : "无法保存 API Key。",
          retryable: true,
        });
      }
    },
  );

}

export function abortDesktopModelRequests() {
  for (const controller of activeModelRequests.values()) controller.abort();
  activeModelRequests.clear();
}
