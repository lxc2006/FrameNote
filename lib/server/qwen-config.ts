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

const RUNTIME_ENV_KEY = "__framenoteRuntimeEnv";

function runtimeBindings() {
  return (globalThis as unknown as Record<string, unknown>)[RUNTIME_ENV_KEY] as
    | Record<string, unknown>
    | undefined;
}

/** 由 Worker 入口在每次请求开始时注入 Sites/Cloudflare 环境绑定。 */
export function setQwenRuntimeBindings(bindings: Record<string, unknown>) {
  (globalThis as unknown as Record<string, unknown>)[RUNTIME_ENV_KEY] = bindings;
}

function runtimeValue(name: string): string | undefined {
  const binding = runtimeBindings()?.[name];
  if (typeof binding === "string" && binding.trim()) return binding.trim();

  const processValue = process.env[name];
  return processValue?.trim() || undefined;
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
