import type {
  VideoModelContext,
  VideoSourceDescriptor,
} from "../../shared/media-types";
import { requestMediaService } from "../media/media-service-client";
import { getQwenConfig, type QwenConfig } from "./qwen-config";
import {
  QwenConfigurationError,
  QwenInputError,
  QwenResponseError,
} from "./qwen-video-engine";

const JOB_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DIRECT_VIDEO_BYTES = 500 * 1024 * 1024;

interface UploadPolicy {
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  max_file_size_mb: number;
  oss_access_key_id: string;
  x_oss_object_acl: string;
  x_oss_forbid_overwrite: string;
}

interface TrustedArtifact {
  playbackUrl: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function resolveQwenVideoContext(
  source: VideoSourceDescriptor,
  context: VideoModelContext,
  signal?: AbortSignal,
): Promise<VideoModelContext> {
  if (!context.mediaJobId) return context;

  const config = getQwenConfig();
  if (!config.apiKey) throw new QwenConfigurationError();
  const artifact = await readTrustedArtifact(
    context.mediaJobId,
    source,
    signal,
  );
  const ossUrl = await uploadArtifactToDashScope(
    context.mediaJobId,
    artifact,
    config,
    signal,
  );
  const rest = { ...context };
  delete rest.mediaJobId;
  return {
    ...rest,
    videoUrl: ossUrl,
    fps: 1,
  };
}

async function readTrustedArtifact(
  jobId: string,
  expectedSource: VideoSourceDescriptor,
  signal?: AbortSignal,
): Promise<TrustedArtifact> {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new QwenInputError("本地视频任务标识无效。");
  }
  const routePrefix =
    expectedSource.kind === "bilibili"
      ? "/v1/bilibili/jobs"
      : "/v1/media/jobs";
  const response = await requestMediaService(
    `${routePrefix}/${jobId.toLowerCase()}`,
    { method: "GET", signal },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new QwenResponseError(
      mediaServiceMessage(body) ?? "无法读取本地分析视频。",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new QwenResponseError("本地媒体服务返回了无效任务。");
  }
  const record = body as Record<string, unknown>;
  const source = record.source;
  const artifact = record.artifact;
  if (
    record.status !== "succeeded" ||
    !source ||
    typeof source !== "object" ||
    Array.isArray(source) ||
    !artifact ||
    typeof artifact !== "object" ||
    Array.isArray(artifact)
  ) {
    throw new QwenInputError("本地分析视频尚未就绪。");
  }
  const sourceRecord = source as Record<string, unknown>;
  if (
    sourceRecord.kind !== expectedSource.kind ||
    (expectedSource.kind === "bilibili" &&
      sourceRecord.bvid !== expectedSource.bvid)
  ) {
    throw new QwenInputError("媒体分析任务与当前视频来源不匹配。");
  }
  const value = artifact as Record<string, unknown>;
  if (
    typeof value.playbackUrl !== "string" ||
    !/^https?:\/\//i.test(value.playbackUrl) ||
    typeof value.filename !== "string" ||
    typeof value.mimeType !== "string" ||
    !value.mimeType.startsWith("video/") ||
    typeof value.sizeBytes !== "number" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes <= 0 ||
    value.sizeBytes > MAX_DIRECT_VIDEO_BYTES
  ) {
    throw new QwenInputError(
      "本地分析视频无效或超过 500 MB 的直接提交上限。",
    );
  }
  return {
    playbackUrl: value.playbackUrl,
    filename: value.filename,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
  };
}

async function uploadArtifactToDashScope(
  jobId: string,
  artifact: TrustedArtifact,
  config: QwenConfig,
  signal?: AbortSignal,
) {
  const policy = await requestUploadPolicy(config, signal);
  if (artifact.sizeBytes > policy.max_file_size_mb * 1024 * 1024) {
    throw new QwenInputError(
      `当前 Qwen 临时存储仅允许 ${policy.max_file_size_mb} MB，下载的视频过大，` +
        "请降低直接总结时长上限。",
    );
  }

  const mediaResponse = await fetch(artifact.playbackUrl, {
    method: "GET",
    headers: { accept: artifact.mimeType },
    signal,
  });
  if (!mediaResponse.ok || !mediaResponse.body) {
    throw new QwenResponseError(
      `读取本地分析视频失败（HTTP ${mediaResponse.status}）。`,
    );
  }

  const key = `${policy.upload_dir.replace(/\/+$/, "")}/${jobId.toLowerCase()}.mp4`;
  const boundary = `----framenote-${crypto.randomUUID()}`;
  const fields: Array<[string, string]> = [
    ["OSSAccessKeyId", policy.oss_access_key_id],
    ["Signature", policy.signature],
    ["policy", policy.policy],
    ["x-oss-object-acl", policy.x_oss_object_acl],
    ["x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite],
    ["key", key],
    ["success_action_status", "200"],
  ];
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    [
      ...fields.map(
        ([name, value]) =>
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
          `${value}\r\n`,
      ),
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeFilename(
          artifact.filename,
        )}"\r\n` +
        `Content-Type: ${artifact.mimeType}\r\n\r\n`,
    ].join(""),
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = concatenateStream(prefix, mediaResponse.body, suffix);
  const uploadResponse = await fetch(policy.upload_host, {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(
        prefix.byteLength + artifact.sizeBytes + suffix.byteLength,
      ),
    },
    body,
    // Required by Node's fetch during tests; ignored by the Workers runtime.
    duplex: "half",
    signal,
  } as RequestInit & { duplex: "half" });
  if (!uploadResponse.ok) {
    const detail = (await uploadResponse.text().catch(() => "")).slice(0, 300);
    throw new QwenResponseError(
      `视频上传到 Qwen 临时存储失败（HTTP ${uploadResponse.status}）${
        detail ? `：${detail}` : "。"
      }`,
    );
  }
  return `oss://${key}`;
}

async function requestUploadPolicy(
  config: QwenConfig,
  signal?: AbortSignal,
): Promise<UploadPolicy> {
  const baseUrl = new URL(config.baseURL);
  const endpoint = new URL("/api/v1/uploads", baseUrl.origin);
  endpoint.searchParams.set("action", "getPolicy");
  endpoint.searchParams.set("model", config.model);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      accept: "application/json",
    },
    signal,
  });
  const body = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    throw new QwenConfigurationError(
      "Qwen 临时文件上传鉴权失败，请检查 DASHSCOPE_API_KEY。",
    );
  }
  if (!response.ok) {
    throw new QwenResponseError(
      `无法获取 Qwen 临时文件上传凭证（HTTP ${response.status}）。`,
    );
  }
  const raw =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).data
      : null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new QwenResponseError("Qwen 返回了无效的临时文件上传凭证。");
  }
  const value = raw as Record<string, unknown>;
  const maxFileSizeMb = Number(value.max_file_size_mb);
  const policy: UploadPolicy = {
    policy: requiredPolicyString(value.policy),
    signature: requiredPolicyString(value.signature),
    upload_dir: requiredPolicyString(value.upload_dir),
    upload_host: requiredPolicyString(value.upload_host),
    max_file_size_mb: maxFileSizeMb,
    oss_access_key_id: requiredPolicyString(value.oss_access_key_id),
    x_oss_object_acl: requiredPolicyString(value.x_oss_object_acl),
    x_oss_forbid_overwrite: requiredPolicyString(
      value.x_oss_forbid_overwrite,
    ),
  };
  const uploadHost = new URL(policy.upload_host);
  const localTest =
    uploadHost.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(uploadHost.hostname);
  if (
    (uploadHost.protocol !== "https:" && !localTest) ||
    !Number.isFinite(maxFileSizeMb) ||
    maxFileSizeMb <= 0 ||
    maxFileSizeMb > 1_024
  ) {
    throw new QwenResponseError("Qwen 临时文件上传凭证包含无效参数。");
  }
  return policy;
}

function concatenateStream(
  prefix: Uint8Array,
  source: ReadableStream<Uint8Array>,
  suffix: Uint8Array,
) {
  const reader = source.getReader();
  let prefixSent = false;
  let suffixSent = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        controller.enqueue(prefix);
        return;
      }
      const chunk = await reader.read();
      if (!chunk.done) {
        controller.enqueue(chunk.value);
        return;
      }
      if (!suffixSent) {
        suffixSent = true;
        controller.enqueue(suffix);
      }
      controller.close();
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function requiredPolicyString(value: unknown) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new QwenResponseError("Qwen 临时文件上传凭证字段无效。");
  }
  return value;
}

function safeFilename(value: string) {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f"\\/\r\n]/g, "_")
    .trim()
    .slice(0, 180);
  return normalized || "video.mp4";
}

function mediaServiceMessage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const error = record.error ?? record.detail;
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}
