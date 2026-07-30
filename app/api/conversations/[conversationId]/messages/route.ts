import {
  appendConversationMessages,
  conversationErrorResponse,
  conversationJson,
  ownerIdFromRequest,
  parseAppendMessagesInput,
  parseConversationId,
  parseTruncateMessagesInput,
  readConversationJson,
  truncateConversationMessages,
} from "@/lib/server/conversation-store";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }> | { conversationId: string };
}

async function conversationIdFrom(context: RouteContext) {
  const params = await context.params;
  return parseConversationId(params.conversationId);
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const conversationId = await conversationIdFrom(context);
    const input = parseAppendMessagesInput(await readConversationJson(request));
    const messages = await appendConversationMessages(
      ownerId,
      conversationId,
      input,
    );
    return conversationJson({ messages }, { status: 201 });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const conversationId = await conversationIdFrom(context);
    const input = parseTruncateMessagesInput(
      await readConversationJson(request),
    );
    await truncateConversationMessages(ownerId, conversationId, input);
    return new Response(null, { status: 204 });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}
