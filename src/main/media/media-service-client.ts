import {
  BilibiliConfigurationError,
  getBilibiliServiceConfig,
} from "./bilibili-config";

export class MediaServiceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaServiceUnavailableError";
  }
}

export async function requestMediaService(
  path: string,
  init: RequestInit,
  timeoutOverrideMs?: number,
): Promise<Response> {
  const config = getBilibiliServiceConfig();
  if (!config.baseURL) {
    throw new BilibiliConfigurationError(
      "媒体服务尚未配置。请先启动 media_service/app.py，并填写 BILIBILI_MEDIA_SERVICE_URL。",
    );
  }

  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (config.token) headers.set("authorization", `Bearer ${config.token}`);

  const timeoutSignal = AbortSignal.timeout(timeoutOverrideMs ?? config.timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  const requestInit = {
    ...init,
    headers,
    signal,
    ...(init.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
  };

  try {
    return await fetch(`${config.baseURL}${path}`, requestInit);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    if (timeoutSignal.aborted) {
      throw new MediaServiceUnavailableError("媒体服务响应超时，请稍后重试。");
    }
    throw new MediaServiceUnavailableError(
      "无法连接媒体服务，请确认 Python 服务已经启动。",
    );
  }
}
