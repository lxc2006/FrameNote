import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  DESKTOP_CHANNELS,
  type DesktopClipboardCandidate,
  type DesktopModelEvent,
  type DesktopTranscriptionProgress,
  type FrameNoteDesktopApi,
} from "../shared/ipc-contract";

const clipboardCandidateSubscriptions = new Set<
  (candidate: DesktopClipboardCandidate) => void
>();
ipcRenderer.on(
  DESKTOP_CHANNELS.clipboardCandidate,
  (_event, candidate: DesktopClipboardCandidate) => {
    for (const listener of clipboardCandidateSubscriptions) listener(candidate);
  },
);

const modelSubscriptions = new Map<
  string,
  (event: DesktopModelEvent["event"]) => void
>();
ipcRenderer.on(
  DESKTOP_CHANNELS.modelEvent,
  (_event, message: DesktopModelEvent) => {
    modelSubscriptions.get(message.requestId)?.(message.event);
  },
);

const transcriptionSubscriptions = new Map<
  string,
  (progress: Omit<DesktopTranscriptionProgress, "requestId">) => void
>();
ipcRenderer.on(
  DESKTOP_CHANNELS.transcriptionProgress,
  (_event, message: DesktopTranscriptionProgress) => {
    transcriptionSubscriptions.get(message.requestId)?.({
      completedChunks: message.completedChunks,
      totalChunks: message.totalChunks,
    });
  },
);

const modelApi: FrameNoteDesktopApi["model"] = Object.freeze({
  analyzeVideo: (requestId, payload) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.modelAnalyze, requestId, payload),
  askVideo: (requestId, payload) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.modelAsk, requestId, payload),
  cancelRequest: (requestId) =>
    ipcRenderer.send(DESKTOP_CHANNELS.modelCancel, requestId),
  subscribe: (requestId, listener) => {
    modelSubscriptions.set(requestId, listener);
  },
  unsubscribe: (requestId) => {
    modelSubscriptions.delete(requestId);
  },
});

const conversationApi: FrameNoteDesktopApi["conversations"] = Object.freeze({
  list: () => ipcRenderer.invoke(DESKTOP_CHANNELS.conversationsList),
  create: (input) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.conversationsCreate, input),
  get: (conversationId) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.conversationsGet, conversationId),
  rename: (conversationId, title) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.conversationsRename,
      conversationId,
      title,
    ),
  updateTranscript: (conversationId, transcript) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.conversationsUpdateTranscript,
      conversationId,
      transcript,
    ),
  delete: (conversationId) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.conversationsDelete, conversationId),
  appendMessages: (conversationId, messages) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.conversationsAppendMessages,
      conversationId,
      messages,
    ),
  truncateMessages: (conversationId, fromMessageId) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.conversationsTruncateMessages,
      conversationId,
      fromMessageId,
    ),
});

const settingsApi: FrameNoteDesktopApi["settings"] = Object.freeze({
  getUserPreferences: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.settingsGetUserPreferences),
  setUserPreferences: (preferences) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.settingsSetUserPreferences,
      preferences,
    ),
});

const credentialApi: FrameNoteDesktopApi["credentials"] = Object.freeze({
  getStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.credentialsGetStatus),
  update: (update) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.credentialsUpdate, update),
});

const mediaApi: FrameNoteDesktopApi["media"] = Object.freeze({
  getConnection: () => ipcRenderer.invoke(DESKTOP_CHANNELS.mediaGetConnection),
  prepareDouyinSession: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.mediaPrepareDouyinSession),
});

const transcriptionApi: FrameNoteDesktopApi["transcription"] = Object.freeze({
  extract: (requestId, input) =>
    ipcRenderer.invoke(
      DESKTOP_CHANNELS.transcriptionExtract,
      requestId,
      input,
    ),
  cancelRequest: (requestId) =>
    ipcRenderer.send(DESKTOP_CHANNELS.modelCancel, requestId),
  subscribe: (requestId, listener) => {
    transcriptionSubscriptions.set(requestId, listener);
  },
  unsubscribe: (requestId) => {
    transcriptionSubscriptions.delete(requestId);
  },
});

const desktopApi: FrameNoteDesktopApi = Object.freeze({
  getRuntimeInfo: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getRuntimeInfo),
  openExternal: (url: string) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openExternal, url),
  clipboard: Object.freeze({
    writeText: (text: string) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.clipboardWriteText, text),
    subscribeCandidate: (listener: (candidate: DesktopClipboardCandidate) => void) => {
      clipboardCandidateSubscriptions.add(listener);
    },
    unsubscribeCandidate: (listener: (candidate: DesktopClipboardCandidate) => void) => {
      clipboardCandidateSubscriptions.delete(listener);
    },
  }),
  media: mediaApi,
  videoFiles: Object.freeze({
    pathForFile: (file: File) => webUtils.getPathForFile(file),
    openLocal: (path: string) => ipcRenderer.invoke(DESKTOP_CHANNELS.videoOpenLocal, path),
    releaseLocal: (url: string) => ipcRenderer.send(DESKTOP_CHANNELS.videoReleaseLocal, url),
    download: (requestId: string, input: Parameters<FrameNoteDesktopApi["videoFiles"]["download"]>[1]) =>
      ipcRenderer.invoke(DESKTOP_CHANNELS.videoDownload, requestId, input),
    cancelDownload: (requestId: string) => ipcRenderer.send(DESKTOP_CHANNELS.videoCancelDownload, requestId),
  }),
  transcription: transcriptionApi,
  model: modelApi,
  conversations: conversationApi,
  settings: settingsApi,
  credentials: credentialApi,
});

contextBridge.exposeInMainWorld("framenoteDesktop", desktopApi);
