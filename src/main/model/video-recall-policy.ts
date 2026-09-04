import type { VideoSummary } from "../../shared/media-types";

interface TimedRecallEvidence {
  items: Array<{
    text: string;
    startSeconds?: number;
    endSeconds?: number;
  }>;
}

const VIDEO_TIME_EXTERNAL_LINK =
  /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|(\[\[\s*video\s*:[^\]\r\n]+\]\])\s*\(\s*<?https?:\/\/[^)\s>]+>?(?:\s+["'][^"'\r\n]*["'])?\s*\)/gi;

export function applyVerifiedVideoTimeReferences(
  answer: string,
  evidence?: TimedRecallEvidence,
  summary?: VideoSummary,
) {
  const sanitizedAnswer = stripVideoTimeExternalLinks(answer);
  const verifiedTimes = collectVerifiedTimes(summary, evidence);
  if (!verifiedTimes.length) return sanitizedAnswer;
  return linkVerifiedPlainTimestamps(sanitizedAnswer, verifiedTimes);
}

function stripVideoTimeExternalLinks(answer: string) {
  return answer.replace(
    VIDEO_TIME_EXTERNAL_LINK,
    (match, videoMarker: string | undefined) => videoMarker ?? match,
  );
}

function collectVerifiedTimes(
  summary?: VideoSummary,
  evidence?: TimedRecallEvidence,
) {
  const times = new Set<number>();
  const add = (seconds: number | null | undefined) => {
    if (seconds !== null && seconds !== undefined && Number.isFinite(seconds)) {
      times.add(Math.max(0, Math.floor(seconds)));
    }
  };
  const addTimestamp = (value: string | undefined) => {
    if (value) add(timestampToSeconds(value));
  };
  summary?.keyPoints.forEach((item) => addTimestamp(item.time));
  summary?.chapters.forEach((item) => addTimestamp(item.time));
  summary?.evidence?.forEach((item) => addTimestamp(item.time));
  summary?.audioAnalysis?.temporalChanges.forEach((item) =>
    addTimestamp(item.time),
  );
  evidence?.items.forEach((item) => {
    add(item.startSeconds);
    add(item.endSeconds);
    for (const match of item.text.matchAll(
      /\[((?:\d{1,3}:)?\d{1,2}:\d{2})\]/g,
    )) {
      add(timestampToSeconds(match[1]));
    }
  });
  return [...times].sort((left, right) => left - right);
}

function linkVerifiedPlainTimestamps(answer: string, verifiedTimes: number[]) {
  const protectedSegments: string[] = [];
  const protectedAnswer = answer.replace(
    /```[\s\S]*?```|`[^`\n]+`|\[\[video:[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>)]+/g,
    (value) => {
      const index = protectedSegments.push(value) - 1;
      return `\uE000${index}\uE001`;
    },
  );
  const linked = protectedAnswer.replace(
    /(?<![\d:：])\[?((?:\d{1,3}:)?\d{1,2}[:：]\d{2})\]?(?![\d:：])/g,
    (match, rawLabel: string) => {
      const label = rawLabel.replaceAll("：", ":");
      const seconds = timestampToSeconds(label);
      if (
        seconds === null ||
        !verifiedTimes.some((verified) => Math.abs(verified - seconds) <= 1)
      ) {
        return match;
      }
      return `[[video:${seconds.toFixed(3)}|${formatTimestamp(seconds)}]]`;
    },
  );
  return linked.replace(/\uE000(\d+)\uE001/g, (_match, rawIndex: string) => {
    return protectedSegments[Number(rawIndex)] ?? "";
  });
}

function timestampToSeconds(value: string) {
  const parts = value.split(":");
  if (
    parts.length < 2 ||
    parts.length > 3 ||
    parts.some((part) => !/^\d+(?:\.\d+)?$/.test(part))
  ) {
    return null;
  }
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function formatTimestamp(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? [hours, minutes, remainder]
        .map((part) => String(part).padStart(2, "0"))
        .join(":")
    : [minutes, remainder]
        .map((part) => String(part).padStart(2, "0"))
        .join(":");
}
