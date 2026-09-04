export function runtimeValue(name: string): string | undefined {
  const processValue = process.env[name];
  return processValue?.trim() || undefined;
}

export function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
