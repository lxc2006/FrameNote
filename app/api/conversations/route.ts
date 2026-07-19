import {
  conversationErrorResponse,
  conversationJson,
  createConversation,
  listConversations,
  ownerIdFromRequest,
  parseCreateConversationInput,
  readConversationJson,
} from "@/lib/server/conversation-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const conversations = await listConversations(ownerId);
    return conversationJson({ conversations });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ownerId = ownerIdFromRequest(request);
    const input = parseCreateConversationInput(
      await readConversationJson(request),
    );
    const conversation = await createConversation(ownerId, input);
    return conversationJson({ conversation }, { status: 201 });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}
