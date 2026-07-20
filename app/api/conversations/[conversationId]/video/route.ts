import {
  conversationErrorResponse,
  conversationJson,
  ownerIdFromRequest,
  parseConversationId,
  readConversationJson,
} from "@/lib/server/conversation-store";
import {
  abortConversationVideoUpload,
  completeConversationVideoUpload,
  headConversationVideo,
  initializeConversationVideoUpload,
  parseCompleteUploadInput,
  parsePartNumber,
  parseUploadId,
  parseVideoMetadata,
  readConversationVideo,
  uploadConversationVideoPart,
} from "@/lib/server/conversation-video-store";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ conversationId: string }> | { conversationId: string };
}

async function requestScope(request: Request, context: RouteContext) {
  const params = await context.params;
  return {
    ownerId: ownerIdFromRequest(request),
    conversationId: parseConversationId(params.conversationId),
  };
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { ownerId, conversationId } = await requestScope(request, context);
    return await readConversationVideo(
      ownerId,
      conversationId,
      request.headers.get("range"),
    );
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function HEAD(request: Request, context: RouteContext) {
  try {
    const { ownerId, conversationId } = await requestScope(request, context);
    return await headConversationVideo(ownerId, conversationId);
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { ownerId, conversationId } = await requestScope(request, context);
    const body = await readConversationJson(request);
    const video = parseVideoMetadata(
      body && typeof body === "object" ? (body as { video?: unknown }).video : null,
    );
    const upload = await initializeConversationVideoUpload(
      ownerId,
      conversationId,
      video,
    );
    return conversationJson(upload, { status: 201 });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { ownerId, conversationId } = await requestScope(request, context);
    const url = new URL(request.url);
    const uploadId = parseUploadId(url.searchParams.get("uploadId"));
    const partNumber = parsePartNumber(url.searchParams.get("partNumber"));
    const declaredBytes = Number(request.headers.get("x-video-part-bytes"));
    const part = await uploadConversationVideoPart(
      ownerId,
      conversationId,
      uploadId,
      partNumber,
      request.body,
      declaredBytes,
    );
    return conversationJson(part, { status: 201 });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { ownerId, conversationId } = await requestScope(request, context);
    const input = parseCompleteUploadInput(
      await readConversationJson(request),
    );
    const source = await completeConversationVideoUpload(
      ownerId,
      conversationId,
      input,
    );
    return conversationJson({ source });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { ownerId, conversationId } = await requestScope(request, context);
    const uploadId = parseUploadId(new URL(request.url).searchParams.get("uploadId"));
    await abortConversationVideoUpload(ownerId, conversationId, uploadId);
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return conversationErrorResponse(error);
  }
}
