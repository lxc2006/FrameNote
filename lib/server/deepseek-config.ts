import { positiveInteger, runtimeValue } from "./runtime-env";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface DeepSeekConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
}

export function getDeepSeekConfig(): DeepSeekConfig {
  return {
    apiKey: runtimeValue("DEEPSEEK_API_KEY") ?? "",
    baseURL: (runtimeValue("DEEPSEEK_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    model: runtimeValue("DEEPSEEK_CHAT_MODEL") ?? DEFAULT_MODEL,
    timeoutMs: positiveInteger(
      runtimeValue("DEEPSEEK_REQUEST_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
  };
}
