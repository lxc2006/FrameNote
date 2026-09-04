import type {
  ConversationDetail,
  ConversationListItem,
  ConversationMessage,
  ConversationMessageInput,
  CreateConversationInput,
} from "./conversation-types";
import type {
  AnalyzeVideoRequest,
  AnalyzeVideoResponse,
  AskVideoRequest,
  AskVideoResponse,
  AskVideoStreamEvent,
} from "./model-types";
import type { UserPreferences } from "./preference-types";
import type { VideoTranscript } from "./media-types";
import type {
  ModelCredentialStatus,
  ModelCredentialUpdate,
} from "./credential-types";

export const DESKTOP_CHANNELS = {
  getRuntimeInfo: "desktop:get-runtime-info",
  openExternal: "desktop:open-external",
  mediaGetConnection: "desktop:media-get-connection",
  modelAnalyze: "desktop:model-analyze",
  modelAsk: "desktop:model-ask",
  modelCancel: "desktop:model-cancel",
  modelEvent: "desktop:model-event",
  conversationsList: "desktop:conversations-list",
  conversationsCreate: "desktop:conversations-create",
  conversationsGet: "desktop:conversations-get",
  conversationsRename: "desktop:conversations-rename",
  conversationsUpdateTranscript: "desktop:conversations-update-transcript",
  conversationsDelete: "desktop:conversations-delete",
  conversationsAppendMessages: "desktop:conversations-append-messages",
  conversationsTruncateMessages: "desktop:conversations-truncate-messages",
  settingsGetUserPreferences: "desktop:settings-get-user-preferences",
  settingsSetUserPreferences: "desktop:settings-set-user-preferences",
  credentialsGetStatus: "desktop:credentials-get-status",
  credentialsUpdate: "desktop:credentials-update",
  subtitlesGetStatus: "desktop:subtitles-get-status",
  subtitlesCheckForUpdates: "desktop:subtitles-check-for-updates",
  subtitlesInstall: "desktop:subtitles-install",
  subtitlesUninstall: "desktop:subtitles-uninstall",
  subtitlesStatus: "desktop:subtitles-status",
} as const;

export interface DesktopRuntimeInfo {
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}

export interface DesktopMediaConnection {
  baseUrl: string;
  authorizationToken: string;
  capabilities: {
    transcription: boolean;
  };
}

export interface DesktopIpcError {
  code: string;
  message: string;
  retryable?: boolean;
}

export type DesktopIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopIpcError };

export interface SubtitleExtensionStatus {
  state:
    | "not-installed"
    | "installed"
    | "update-available"
    | "installing"
    | "uninstalling"
    | "error";
  installedVersion?: string;
  availableVersion?: string;
  progress?: number;
  downloadedBytes?: number;
  expectedDownloadBytes?: number;
  message?: string;
}

export interface DesktopModelEvent {
  requestId: string;
  event: AskVideoStreamEvent;
}

export interface FrameNoteDesktopApi {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  openExternal(url: string): Promise<void>;
  media: {
    getConnection(): Promise<DesktopIpcResult<DesktopMediaConnection>>;
  };
  subtitles: {
    getStatus(): Promise<DesktopIpcResult<SubtitleExtensionStatus>>;
    checkForUpdates(): Promise<DesktopIpcResult<SubtitleExtensionStatus>>;
    install(): Promise<DesktopIpcResult<SubtitleExtensionStatus>>;
    uninstall(): Promise<DesktopIpcResult<SubtitleExtensionStatus>>;
    subscribe(listener: (status: SubtitleExtensionStatus) => void): void;
    unsubscribe(listener: (status: SubtitleExtensionStatus) => void): void;
  };
  model: {
    analyzeVideo(
      requestId: string,
      payload: AnalyzeVideoRequest,
    ): Promise<DesktopIpcResult<AnalyzeVideoResponse>>;
    askVideo(
      requestId: string,
      payload: AskVideoRequest,
    ): Promise<DesktopIpcResult<AskVideoResponse>>;
    cancelRequest(requestId: string): void;
    subscribe(requestId: string, listener: (event: AskVideoStreamEvent) => void): void;
    unsubscribe(requestId: string): void;
  };
  conversations: {
    list(): Promise<DesktopIpcResult<ConversationListItem[]>>;
    create(
      input: CreateConversationInput,
    ): Promise<DesktopIpcResult<ConversationDetail>>;
    get(conversationId: string): Promise<DesktopIpcResult<ConversationDetail>>;
    rename(
      conversationId: string,
      title: string,
    ): Promise<DesktopIpcResult<ConversationListItem>>;
    updateTranscript(
      conversationId: string,
      transcript: VideoTranscript,
    ): Promise<DesktopIpcResult<VideoTranscript>>;
    delete(conversationId: string): Promise<DesktopIpcResult<void>>;
    appendMessages(
      conversationId: string,
      messages: ConversationMessageInput[],
    ): Promise<DesktopIpcResult<ConversationMessage[]>>;
    truncateMessages(
      conversationId: string,
      fromMessageId: string,
    ): Promise<DesktopIpcResult<void>>;
  };
  settings: {
    getUserPreferences(): Promise<DesktopIpcResult<UserPreferences | null>>;
    setUserPreferences(
      preferences: UserPreferences,
    ): Promise<DesktopIpcResult<UserPreferences>>;
  };
  credentials: {
    getStatus(): Promise<DesktopIpcResult<ModelCredentialStatus>>;
    update(
      update: ModelCredentialUpdate,
    ): Promise<DesktopIpcResult<ModelCredentialStatus>>;
  };
}

declare global {
  interface Window {
    framenoteDesktop?: FrameNoteDesktopApi;
  }
}
