import { positiveInteger, runtimeValue } from "../config/app-env";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_FLASH_MODEL = "deepseek-v4-flash";
const DEFAULT_PRO_MODEL = "deepseek-v4-pro";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface DeepSeekConfig {
  apiKey: string;
  baseURL: string;
  flashModel: string;
  proModel: string;
  timeoutMs: number;
}

export function getDeepSeekConfig(): DeepSeekConfig {
  return {
    apiKey: runtimeValue("DEEPSEEK_API_KEY") ?? "",
    baseURL: (runtimeValue("DEEPSEEK_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    ),
    flashModel:
      runtimeValue("DEEPSEEK_FLASH_MODEL") ?? DEFAULT_FLASH_MODEL,
    proModel:
      runtimeValue("DEEPSEEK_PRO_MODEL") ??
      runtimeValue("DEEPSEEK_CHAT_MODEL") ??
      DEFAULT_PRO_MODEL,
    timeoutMs: positiveInteger(
      runtimeValue("DEEPSEEK_REQUEST_TIMEOUT_MS"),
      DEFAULT_TIMEOUT_MS,
    ),
  };
}
