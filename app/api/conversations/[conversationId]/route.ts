import {
  conversationErrorResponse,
  conversationJson,
  deleteConversation,
  getConversation,
  ownerIdFromRequest,
  parseConversationId,
  parseRenameConversationInput,
  readConversationJson,
  renameConversation,
} from "@/lib/server/conversation-store";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }> | { conversationId: string };
}

async function conversationIdFrom(context: RouteContext) {
  const params = await context.params;
  return parseConversationId(params.conversationId);
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const conversationId = await conversationIdFrom(context);
    const conversation = await getConversation(ownerId, conversationId);
    return conversationJson({ conversation });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const conversationId = await conversationIdFrom(context);
    const { title } = parseRenameConversationInput(
      await readConversationJson(request),
    );
    const conversation = await renameConversation(
      ownerId,
      conversationId,
      title,
    );
    return conversationJson({ conversation });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const conversationId = await conversationIdFrom(context);
    await deleteConversation(ownerId, conversationId);
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}
