const RUNTIME_ENV_KEY = "__framenoteRuntimeEnv";

function runtimeBindings() {
  return (globalThis as unknown as Record<string, unknown>)[RUNTIME_ENV_KEY] as
    | Record<string, unknown>
    | undefined;
}

/** 由 Worker 入口在每次请求开始时注入 Sites/Cloudflare 环境绑定。 */
export function setRuntimeBindings(bindings: Record<string, unknown>) {
  (globalThis as unknown as Record<string, unknown>)[RUNTIME_ENV_KEY] = bindings;
}

export function runtimeBinding<T>(name: string): T | undefined {
  return runtimeBindings()?.[name] as T | undefined;
}

export function runtimeValue(name: string): string | undefined {
  const binding = runtimeBindings()?.[name];
  if (typeof binding === "string" && binding.trim()) return binding.trim();

  const processValue = process.env[name];
  return processValue?.trim() || undefined;
}

export function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
