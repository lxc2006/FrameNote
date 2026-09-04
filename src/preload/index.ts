import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_CHANNELS,
  type DesktopModelEvent,
  type FrameNoteDesktopApi,
  type SubtitleExtensionStatus,
} from "../shared/ipc-contract";

const modelSubscriptions = new Map<
  string,
  (event: DesktopModelEvent["event"]) => void
>();
const subtitleSubscriptions = new Set<
  (status: SubtitleExtensionStatus) => void
>();

ipcRenderer.on(
  DESKTOP_CHANNELS.modelEvent,
  (_event, message: DesktopModelEvent) => {
    modelSubscriptions.get(message.requestId)?.(message.event);
  },
);

ipcRenderer.on(
  DESKTOP_CHANNELS.subtitlesStatus,
  (_event, status: SubtitleExtensionStatus) => {
    for (const listener of subtitleSubscriptions) listener(status);
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
});

const subtitleApi: FrameNoteDesktopApi["subtitles"] = Object.freeze({
  getStatus: () => ipcRenderer.invoke(DESKTOP_CHANNELS.subtitlesGetStatus),
  checkForUpdates: () =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.subtitlesCheckForUpdates),
  install: () => ipcRenderer.invoke(DESKTOP_CHANNELS.subtitlesInstall),
  uninstall: () => ipcRenderer.invoke(DESKTOP_CHANNELS.subtitlesUninstall),
  subscribe: (listener) => {
    subtitleSubscriptions.add(listener);
  },
  unsubscribe: (listener) => {
    subtitleSubscriptions.delete(listener);
  },
});

const desktopApi: FrameNoteDesktopApi = Object.freeze({
  getRuntimeInfo: () => ipcRenderer.invoke(DESKTOP_CHANNELS.getRuntimeInfo),
  openExternal: (url: string) =>
    ipcRenderer.invoke(DESKTOP_CHANNELS.openExternal, url),
  media: mediaApi,
  subtitles: subtitleApi,
  model: modelApi,
  conversations: conversationApi,
  settings: settingsApi,
  credentials: credentialApi,
});

contextBridge.exposeInMainWorld("framenoteDesktop", desktopApi);
