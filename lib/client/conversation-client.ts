import type {
  ConversationDetail,
  ConversationListItem,
  ConversationMessage,
  CreateConversationInput,
} from "@/lib/conversation";
import type {
  PersistedVideoDescriptor,
  VideoSourceDescriptor,
} from "@/lib/video-engine";

const VIDEO_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

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

export async function deleteConversation(id: string) {
  await conversationRequest<void>(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function appendConversationMessages(
  id: string,
  messages: Array<Pick<ConversationMessage, "role" | "content">>,
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

export async function storeConversationVideo(
  id: string,
  file: File,
  video: PersistedVideoDescriptor,
  signal?: AbortSignal,
): Promise<VideoSourceDescriptor> {
  const path = `/api/conversations/${encodeURIComponent(id)}/video`;
  const initialized = await conversationRequest<{
    uploadId: string;
    chunkBytes: number;
  }>(path, {
    method: "POST",
    body: JSON.stringify({ video }),
    signal,
  });
  const chunkBytes = initialized.chunkBytes || VIDEO_UPLOAD_CHUNK_BYTES;
  const parts: Array<{ partNumber: number; etag: string }> = [];

  try {
    for (let offset = 0, partNumber = 1; offset < file.size; partNumber += 1) {
      const chunk = file.slice(offset, Math.min(file.size, offset + chunkBytes));
      const query = new URLSearchParams({
        uploadId: initialized.uploadId,
        partNumber: String(partNumber),
      });
      const response = await conversationRequest<{
        partNumber: number;
        etag: string;
      }>(`${path}?${query}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-video-part-bytes": String(chunk.size),
        },
        body: chunk,
        signal,
      });
      parts.push(response);
      offset += chunk.size;
    }

    const completed = await conversationRequest<{ source: VideoSourceDescriptor }>(
      path,
      {
        method: "PATCH",
        body: JSON.stringify({
          uploadId: initialized.uploadId,
          parts,
          video,
        }),
        signal,
      },
    );
    return completed.source;
  } catch (error) {
    const query = new URLSearchParams({ uploadId: initialized.uploadId });
    void fetch(`${path}?${query}`, { method: "DELETE", keepalive: true }).catch(
      () => undefined,
    );
    throw error;
  }
}

export function conversationVideoUrl(id: string) {
  return `/api/conversations/${encodeURIComponent(id)}/video`;
}
