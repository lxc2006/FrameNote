export type EstimatedAnalysisStage = "qwen" | "transcript";

const MAX_ESTIMATED_STAGE_PROGRESS = 0.94;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function estimatedStageDurationMs(
  stage: EstimatedAnalysisStage,
  durationSeconds?: number | null,
) {
  const duration = Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds ?? 0)
    : 0;
  const expectedSeconds =
    stage === "transcript"
      ? clamp(30 + duration * 0.55, 60, 22 * 60)
      : clamp(35 + duration * 0.12, 45, 5 * 60);
  return expectedSeconds * 1_000;
}

export function estimatedStageProgress(
  stage: EstimatedAnalysisStage,
  elapsedMs: number,
  durationSeconds?: number | null,
  initialProgress = 0.1,
) {
  const initial = clamp(initialProgress, 0, MAX_ESTIMATED_STAGE_PROGRESS);
  const elapsed = Math.max(0, elapsedMs);
  const expected = estimatedStageDurationMs(stage, durationSeconds);
  const curve = 1 - Math.exp((-1.5 * elapsed) / expected);
  return Math.min(
    MAX_ESTIMATED_STAGE_PROGRESS,
    initial + (MAX_ESTIMATED_STAGE_PROGRESS - initial) * curve,
  );
}

export function advanceDisplayedProgress(current: number, target: number) {
  const safeCurrent = clamp(Number.isFinite(current) ? current : 0, 0, 100);
  const safeTarget = clamp(Number.isFinite(target) ? target : 0, 0, 100);
  if (safeTarget <= safeCurrent) return safeCurrent;
  const distance = safeTarget - safeCurrent;
  return Math.min(safeTarget, safeCurrent + Math.min(2.5, Math.max(0.15, distance * 0.35)));
}
