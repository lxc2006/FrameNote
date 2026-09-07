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
import type { TranscriptLanguage, VideoTranscript } from "./media-types";
import type { LocalVideoFile, VideoDownloadInput, VideoDownloadResult } from "./video-files";
import type {
  ModelCredentialStatus,
  ModelCredentialUpdate,
} from "./credential-types";

export const DESKTOP_CHANNELS = {
  getRuntimeInfo: "desktop:get-runtime-info",
  openExternal: "desktop:open-external",
  clipboardWriteText: "desktop:clipboard-write-text",
  mediaGetConnection: "desktop:media-get-connection",
  videoOpenLocal: "desktop:video-open-local",
  videoReleaseLocal: "desktop:video-release-local",
  videoDownload: "desktop:video-download",
  videoCancelDownload: "desktop:video-cancel-download",
  modelAnalyze: "desktop:model-analyze",
  modelAsk: "desktop:model-ask",
  modelCancel: "desktop:model-cancel",
  modelEvent: "desktop:model-event",
  transcriptionProgress: "desktop:transcription-progress",
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
  transcriptionExtract: "desktop:transcription-extract",
} as const;

export interface DesktopRuntimeInfo {
  appVersion: string;
  isPackaged: boolean;
  platform: NodeJS.Platform;
}

export interface DesktopMediaConnection {
  baseUrl: string;
  authorizationToken: string;
}

export interface DesktopIpcError {
  code: string;
  message: string;
  retryable?: boolean;
}

export type DesktopIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DesktopIpcError };

export interface DesktopModelEvent {
  requestId: string;
  event: AskVideoStreamEvent;
}

export interface DesktopTranscriptionProgress {
  requestId: string;
  completedChunks: number;
  totalChunks: number;
}

export interface FrameNoteDesktopApi {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  openExternal(url: string): Promise<void>;
  clipboard: {
    writeText(text: string): Promise<DesktopIpcResult<void>>;
  };
  media: {
    getConnection(): Promise<DesktopIpcResult<DesktopMediaConnection>>;
  };
  videoFiles: {
    pathForFile(file: File): string;
    openLocal(path: string): Promise<DesktopIpcResult<LocalVideoFile>>;
    releaseLocal(playbackUrl: string): void;
    download(requestId: string, input: VideoDownloadInput): Promise<DesktopIpcResult<VideoDownloadResult>>;
    cancelDownload(requestId: string): void;
  };
  transcription: {
    extract(
      requestId: string,
      input: {
        jobId: string;
        jobKind: "media" | "bilibili";
        languages: TranscriptLanguage[];
      },
    ): Promise<DesktopIpcResult<VideoTranscript>>;
    cancelRequest(requestId: string): void;
    subscribe(
      requestId: string,
      listener: (progress: Omit<DesktopTranscriptionProgress, "requestId">) => void,
    ): void;
    unsubscribe(requestId: string): void;
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
