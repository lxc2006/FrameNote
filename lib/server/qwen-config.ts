import { positiveInteger, runtimeValue } from "./runtime-env";

const DEFAULT_BASE_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.5-omni-plus";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface QwenConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
}

export function getQwenConfig(): QwenConfig {
  return {
    apiKey: runtimeValue("DASHSCOPE_API_KEY") ?? "",
    baseURL: (runtimeValue("DASHSCOPE_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    model: runtimeValue("QWEN_VIDEO_MODEL") ?? DEFAULT_MODEL,
    timeoutMs: positiveInteger(
      runtimeValue("QWEN_REQUEST_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

export function isQwenConfigured() {
  return Boolean(getQwenConfig().apiKey);
}
