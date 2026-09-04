import type {
  ConversationMessageInput,
  CreateConversationInput,
} from "@/shared/conversation-types";
import type { VideoTranscript } from "@/shared/media-types";
import type { DesktopIpcResult } from "@/shared/ipc-contract";
import {
  desktopBridge,
  throwIfDesktopAborted,
  unwrapDesktopResult,
} from "./desktop-bridge";

function conversationApi() {
  const api = desktopBridge()?.conversations;
  if (!api) throw new Error("FrameNote 桌面对话桥接不可用，请重新启动应用。");
  return api;
}

export async function listConversations(signal?: AbortSignal) {
  return desktopConversationResult(conversationApi().list(), signal);
}

export async function createConversation(input: CreateConversationInput) {
  return desktopConversationResult(conversationApi().create(input));
}

export async function getConversation(id: string, signal?: AbortSignal) {
  return desktopConversationResult(conversationApi().get(id), signal);
}

export async function renameConversation(id: string, title: string) {
  return desktopConversationResult(conversationApi().rename(id, title));
}

export async function updateConversationTranscript(
  id: string,
  transcript: VideoTranscript,
) {
  return desktopConversationResult(
    conversationApi().updateTranscript(id, transcript),
  );
}

export async function deleteConversation(id: string) {
  await desktopConversationResult(conversationApi().delete(id));
}

export async function appendConversationMessages(
  id: string,
  messages: ConversationMessageInput[],
) {
  return desktopConversationResult(
    conversationApi().appendMessages(id, messages),
  );
}

export async function truncateConversationMessages(
  id: string,
  fromMessageId: string,
) {
  await desktopConversationResult(
    conversationApi().truncateMessages(id, fromMessageId),
  );
}

async function desktopConversationResult<T>(
  request: Promise<DesktopIpcResult<T>>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfDesktopAborted(signal);
  const result = await request;
  throwIfDesktopAborted(signal);
  return unwrapDesktopResult(result);
}
