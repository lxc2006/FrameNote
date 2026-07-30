import {
  conversationErrorResponse,
  conversationJson,
  ownerIdFromRequest,
  parseConversationId,
  parseUpdateTranscriptInput,
  readConversationJson,
  updateConversationTranscript,
} from "@/lib/server/conversation-store";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }> | { conversationId: string };
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const { conversationId } = await context.params;
    const { transcript } = parseUpdateTranscriptInput(
      await readConversationJson(request),
    );
    const saved = await updateConversationTranscript(
      ownerId,
      parseConversationId(conversationId),
      transcript,
    );
    return conversationJson({ transcript: saved });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}
