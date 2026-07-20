import type {
  PersistedVideoDescriptor,
  VideoSourceDescriptor,
} from "../video-engine";
import {
  ConversationRouteError,
  getConversation,
  requireOwnedConversation,
  saveConversationVideoMetadata,
} from "./conversation-store";
import { runtimeBinding } from "./runtime-env";

export const CONVERSATION_VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_CONVERSATION_VIDEO_BYTES = 150 * 1024 * 1024;

interface CompleteUploadInput {
  uploadId: string;
  parts: R2UploadedPart[];
  video: PersistedVideoDescriptor;
}

function mediaBucket() {
  const bucket = runtimeBinding<R2Bucket>("MEDIA");
  if (!bucket) {
    throw new ConversationRouteError(
      503,
      "VIDEO_STORAGE_UNAVAILABLE",
      "视频存储尚未就绪，请稍后重试。",
    );
  }
  return bucket;
}

function objectKey(conversationId: string) {
  return `conversation-videos/${conversationId}/video`;
}

export function parseVideoMetadata(value: unknown): PersistedVideoDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidVideoInput("video 必须是对象。");
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([
    "filename",
    "mimeType",
    "sizeBytes",
    "title",
    "description",
    "durationLabel",
    "qualityLabel",
    "sourceLabel",
  ]);
  const unexpected = Object.keys(object).find((key) => !allowed.has(key));
  if (unexpected) throw invalidVideoInput(`video.${unexpected} 不是允许的字段。`);

  const filename = requiredString(object.filename, "video.filename", 255);
  const mimeType = requiredString(object.mimeType, "video.mimeType", 100);
  if (!/^video\/[a-z0-9.+-]+$/i.test(mimeType)) {
    throw invalidVideoInput("video.mimeType 必须是视频 MIME 类型。");
  }
  const sizeBytes = object.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_CONVERSATION_VIDEO_BYTES
  ) {
    throw invalidVideoInput("视频大小超出 150 MB 存储限制。");
  }

  return {
    filename,
    mimeType,
    sizeBytes,
    description: requiredString(
      object.description,
      "video.description",
      1_000,
    ),
    ...optionalProperty(object.title, "video.title", 300, "title"),
    ...optionalProperty(
      object.durationLabel,
      "video.durationLabel",
      100,
      "durationLabel",
    ),
    ...optionalProperty(
      object.qualityLabel,
      "video.qualityLabel",
      200,
      "qualityLabel",
    ),
    ...optionalProperty(
      object.sourceLabel,
      "video.sourceLabel",
      200,
      "sourceLabel",
    ),
  };
}

export function parseCompleteUploadInput(value: unknown): CompleteUploadInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidVideoInput("请求体必须是对象。");
  }
  const object = value as Record<string, unknown>;
  const unexpected = Object.keys(object).find(
    (key) => key !== "uploadId" && key !== "parts" && key !== "video",
  );
  if (unexpected) throw invalidVideoInput(`${unexpected} 不是允许的字段。`);
  const uploadId = parseUploadId(object.uploadId);
  if (!Array.isArray(object.parts) || object.parts.length < 1 || object.parts.length > 32) {
    throw invalidVideoInput("parts 必须包含 1 至 32 个分片。");
  }
  const parts = object.parts.map((part, index) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw invalidVideoInput(`parts[${index}] 格式无效。`);
    }
    const record = part as Record<string, unknown>;
    const partNumber = parsePartNumber(record.partNumber);
    const etag = requiredString(record.etag, `parts[${index}].etag`, 256);
    return { partNumber, etag };
  });
  if (new Set(parts.map((part) => part.partNumber)).size !== parts.length) {
    throw invalidVideoInput("parts 中存在重复分片。");
  }
  parts.sort((left, right) => left.partNumber - right.partNumber);
  parts.forEach((part, index) => {
    if (part.partNumber !== index + 1) {
      throw invalidVideoInput("parts 必须从 1 开始连续编号。");
    }
  });
  return { uploadId, parts, video: parseVideoMetadata(object.video) };
}

export function parseUploadId(value: unknown) {
  const uploadId = requiredString(value, "uploadId", 512);
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(uploadId)) {
    throw invalidVideoInput("uploadId 格式无效。");
  }
  return uploadId;
}

export function parsePartNumber(value: unknown) {
  const partNumber = typeof value === "string" ? Number(value) : value;
  if (
    typeof partNumber !== "number" ||
    !Number.isSafeInteger(partNumber) ||
    partNumber < 1 ||
    partNumber > 32
  ) {
    throw invalidVideoInput("partNumber 格式无效。");
  }
  return partNumber;
}

export async function initializeConversationVideoUpload(
  ownerId: string,
  conversationId: string,
  video: PersistedVideoDescriptor,
) {
  await requireOwnedConversation(ownerId, conversationId);
  const upload = await mediaBucket().createMultipartUpload(objectKey(conversationId), {
    httpMetadata: {
      contentType: video.mimeType,
      contentDisposition: contentDisposition(video.filename),
    },
    customMetadata: {
      conversationId,
      sizeBytes: String(video.sizeBytes),
    },
  });
  return { uploadId: upload.uploadId, chunkBytes: CONVERSATION_VIDEO_CHUNK_BYTES };
}

export async function uploadConversationVideoPart(
  ownerId: string,
  conversationId: string,
  uploadId: string,
  partNumber: number,
  body: ReadableStream<Uint8Array> | null,
  declaredBytes: number,
) {
  await requireOwnedConversation(ownerId, conversationId);
  if (!body || declaredBytes <= 0 || declaredBytes > CONVERSATION_VIDEO_CHUNK_BYTES) {
    throw invalidVideoInput("视频分片为空或超过 8 MB。请重新上传。");
  }
  return mediaBucket()
    .resumeMultipartUpload(objectKey(conversationId), uploadId)
    .uploadPart(partNumber, body);
}

export async function completeConversationVideoUpload(
  ownerId: string,
  conversationId: string,
  input: CompleteUploadInput,
): Promise<VideoSourceDescriptor> {
  await requireOwnedConversation(ownerId, conversationId);
  const expectedParts = Math.ceil(
    input.video.sizeBytes / CONVERSATION_VIDEO_CHUNK_BYTES,
  );
  if (input.parts.length !== expectedParts) {
    throw invalidVideoInput("视频分片数量与文件大小不匹配。");
  }
  const bucket = mediaBucket();
  const upload = bucket.resumeMultipartUpload(
    objectKey(conversationId),
    input.uploadId,
  );
  await upload.complete(input.parts);
  try {
    return await saveConversationVideoMetadata(
      ownerId,
      conversationId,
      input.video,
    );
  } catch (error) {
    await bucket.delete(objectKey(conversationId));
    throw error;
  }
}

export async function abortConversationVideoUpload(
  ownerId: string,
  conversationId: string,
  uploadId: string,
) {
  await requireOwnedConversation(ownerId, conversationId);
  await mediaBucket()
    .resumeMultipartUpload(objectKey(conversationId), uploadId)
    .abort();
}

export async function readConversationVideo(
  ownerId: string,
  conversationId: string,
  rangeHeader: string | null,
) {
  const conversation = await getConversation(ownerId, conversationId);
  const video = conversation.source.persistedVideo;
  if (!video) {
    throw new ConversationRouteError(
      404,
      "CONVERSATION_VIDEO_NOT_FOUND",
      "这个对话没有已保存的视频。",
    );
  }

  const range = parseRange(rangeHeader, video.sizeBytes);
  const object = await mediaBucket().get(
    objectKey(conversationId),
    range ? { range } : undefined,
  );
  if (!object) {
    throw new ConversationRouteError(
      404,
      "CONVERSATION_VIDEO_NOT_FOUND",
      "已保存的视频文件不存在，请重新获取视频。",
    );
  }

  const headers = videoHeaders(video);
  if (range) {
    headers.set("content-length", String(range.length));
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${video.sizeBytes}`,
    );
  } else {
    headers.set("content-length", String(video.sizeBytes));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export async function headConversationVideo(
  ownerId: string,
  conversationId: string,
) {
  const conversation = await getConversation(ownerId, conversationId);
  const video = conversation.source.persistedVideo;
  if (!video) {
    throw new ConversationRouteError(
      404,
      "CONVERSATION_VIDEO_NOT_FOUND",
      "这个对话没有已保存的视频。",
    );
  }
  const headers = videoHeaders(video);
  headers.set("content-length", String(video.sizeBytes));
  return new Response(null, { status: 200, headers });
}

export async function deleteConversationVideo(
  ownerId: string,
  conversationId: string,
) {
  const conversation = await getConversation(ownerId, conversationId);
  if (conversation.source.persistedVideo) {
    await mediaBucket().delete(objectKey(conversationId));
  }
}

function videoHeaders(video: PersistedVideoDescriptor) {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "content-disposition": contentDisposition(video.filename),
    "content-type": video.mimeType,
    "x-content-type-options": "nosniff",
  });
  return headers;
}

function parseRange(value: string | null, size: number) {
  if (!value) return null;
  const match = value.match(/^bytes=(\d+)-(\d*)$/i);
  if (!match) throw invalidVideoInput("Range 请求格式无效。");
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(requestedEnd) ||
    offset < 0 ||
    requestedEnd < offset ||
    offset >= size
  ) {
    throw new ConversationRouteError(
      416,
      "VIDEO_RANGE_NOT_SATISFIABLE",
      "请求的视频区间超出文件范围。",
    );
  }
  const end = Math.min(requestedEnd, size - 1);
  return { offset, length: end - offset + 1 };
}

function contentDisposition(filename: string) {
  const fallback = filename.replace(/[^A-Za-z0-9._-]/g, "_") || "video.mp4";
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function optionalProperty<Key extends string>(
  value: unknown,
  field: string,
  maxLength: number,
  key: Key,
): Partial<Record<Key, string>> {
  if (value === undefined || value === null || value === "") return {};
  return { [key]: requiredString(value, field, maxLength) } as Record<Key, string>;
}

function requiredString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidVideoInput(`${field} 必须是非空字符串。`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw invalidVideoInput(`${field} 超过长度限制。`);
  }
  return normalized;
}

function invalidVideoInput(message: string) {
  return new ConversationRouteError(400, "INVALID_VIDEO_STORAGE_INPUT", message);
}
