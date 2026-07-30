import type {
  ConversationDetail,
  ConversationListItem,
  ConversationMessage,
  ConversationMessageInput,
  CreateConversationInput,
} from "@/lib/conversation";
import type { VideoTranscript } from "@/lib/video-engine";

interface ConversationErrorPayload {
  error?: {
    message?: string;
  };
}

async function conversationRequest<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    let message = "对话历史服务暂时不可用。";
    try {
      const payload = (await response.json()) as ConversationErrorPayload;
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // Keep the stable user-facing fallback for non-JSON failures.
    }
    throw new Error(message);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function listConversations(signal?: AbortSignal) {
  const payload = await conversationRequest<{
    conversations: ConversationListItem[];
  }>("/api/conversations", { signal });
  return payload.conversations;
}

export async function createConversation(input: CreateConversationInput) {
  const payload = await conversationRequest<{ conversation: ConversationDetail }>(
    "/api/conversations",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return payload.conversation;
}

export async function getConversation(id: string, signal?: AbortSignal) {
  const payload = await conversationRequest<{ conversation: ConversationDetail }>(
    `/api/conversations/${encodeURIComponent(id)}`,
    { signal },
  );
  return payload.conversation;
}

export async function renameConversation(id: string, title: string) {
  const payload = await conversationRequest<{ conversation: ConversationListItem }>(
    `/api/conversations/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ title }),
    },
  );
  return payload.conversation;
}

export async function updateConversationTranscript(
  id: string,
  transcript: VideoTranscript,
) {
  const payload = await conversationRequest<{ transcript: VideoTranscript }>(
    `/api/conversations/${encodeURIComponent(id)}/transcript`,
    {
      method: "PUT",
      body: JSON.stringify({ transcript }),
    },
  );
  return payload.transcript;
}

export async function deleteConversation(id: string) {
  await conversationRequest<void>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function appendConversationMessages(
  id: string,
  messages: ConversationMessageInput[],
) {
  const payload = await conversationRequest<{ messages: ConversationMessage[] }>(
    `/api/conversations/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ messages }),
    },
  );
  return payload.messages;
}

export async function truncateConversationMessages(
  id: string,
  fromMessageId: string,
) {
  await conversationRequest<void>(
    `/api/conversations/${encodeURIComponent(id)}/messages`,
    {
      method: "DELETE",
      body: JSON.stringify({ fromMessageId }),
    },
  );
}
