type InlineVideoToken =
  | { kind: "text"; value: string }
  | { kind: "time"; seconds: number; label: string }
  | {
      kind: "range";
      startSeconds: number;
      startLabel: string;
      endSeconds: number;
      endLabel: string;
    };

const VIDEO_TIME_MARKER =
  /\[\[\s*video\s*:\s*(?:(\d+(?:\.\d+)?)\s*\|\s*)?((?:\d{2}:)?\d{2}:\d{2})\s*\]\]/gi;
const VIDEO_TIME_HREF = /^framenote-video:(\d+(?:\.\d+)?)$/;

export function prepareMarkdownContent(content: string) {
  const lines = content.trim().replace(/\r\n?/g, "\n").split("\n");
  const prepared: string[] = [];
  let codeFence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    if (!codeFence) {
      const openingFence = line.match(/^\s*(`{3,}|~{3,})/);
      if (openingFence) {
        codeFence = {
          marker: openingFence[1][0] as "`" | "~",
          length: openingFence[1].length,
        };
        prepared.push(line);
        continue;
      }
      prepared.push(videoTimesToMarkdown(line));
      continue;
    }

    prepared.push(line);
    const closingFence = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (
      closingFence &&
      closingFence[1][0] === codeFence.marker &&
      closingFence[1].length >= codeFence.length
    ) {
      codeFence = null;
    }
  }

  return prepared.join("\n").trim();
}

export function parseVideoTimeHref(href: string | undefined) {
  if (!href) return null;
  const match = href.match(VIDEO_TIME_HREF);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function videoTimesToMarkdown(value: string) {
  return tokenizeVideoTimes(value)
    .map((token) => {
      if (token.kind === "text") return token.value;
      if (token.kind === "time") {
        return videoTimeLink(token.label, token.seconds);
      }
      return `${videoTimeLink(token.startLabel, token.startSeconds)} ~ ${videoTimeLink(
        token.endLabel,
        token.endSeconds,
      )}`;
    })
    .join("")
    .trimEnd();
}

function videoTimeLink(label: string, seconds: number) {
  return `[${label}](framenote-video:${seconds})`;
}

function tokenizeVideoTimes(value: string): InlineVideoToken[] {
  const rawTokens: InlineVideoToken[] = [];
  let cursor = 0;

  for (const match of value.matchAll(VIDEO_TIME_MARKER)) {
    const index = match.index ?? 0;

    if (index > cursor) {
      rawTokens.push({
        kind: "text",
        value: value.slice(cursor, index),
      });
    }

    // match[1]：旧格式中的隐藏秒数，例如 47.000
    // match[2]：新旧格式都有的可见时间，例如 00:47
    const legacySecondsText = match[1];
    const label = match[2];

    const labelSeconds = timestampToSeconds(label);

    if (labelSeconds === null) {
      // 时间格式不合法，保留原始文本，不转换成按钮
      rawTokens.push({
        kind: "text",
        value: match[0],
      });
    } else {
      /*
       * 新格式：
       * [[video:00:47]]
       *
       * 旧格式：
       * [[video:47.000|00:47]]
       *
       * 两种格式最终都以用户看得见的 00:47 为准。
       */
      if (legacySecondsText !== undefined) {
        const legacySeconds = Number(legacySecondsText);

        if (
          Number.isFinite(legacySeconds) &&
          Math.abs(legacySeconds - labelSeconds) > 0.5
        ) {
          console.warn("视频时间标记两侧不一致，已采用可见时间", {
            marker: match[0],
            hiddenSeconds: legacySeconds,
            visibleTime: label,
            visibleSeconds: labelSeconds,
          });
        }
      }

      rawTokens.push({
        kind: "time",
        seconds: labelSeconds,
        label,
      });
    }

    cursor = index + match[0].length;
  }

  if (cursor < value.length) {
    rawTokens.push({
      kind: "text",
      value: value.slice(cursor),
    });
  }

  const folded: InlineVideoToken[] = [];

  for (let index = 0; index < rawTokens.length; index += 1) {
    const first = rawTokens[index];
    const separator = rawTokens[index + 1];
    const second = rawTokens[index + 2];

    if (
      first?.kind === "time" &&
      separator?.kind === "text" &&
      second?.kind === "time" &&
      /^(?:\s|至|到|[-–—~～])*$/.test(separator.value)
    ) {
      if (Math.abs(first.seconds - second.seconds) <= 2) {
        // 两个端点太接近，只保留第一个
        folded.push(first);
      } else {
        folded.push({
          kind: "range",
          startSeconds: first.seconds,
          startLabel: first.label,
          endSeconds: second.seconds,
          endLabel: second.label,
        });
      }

      index += 2;
      continue;
    }

    folded.push(first);
  }

  const seenTimes: number[] = [];

  return folded.filter((token) => {
    if (token.kind === "text") {
      return true;
    }

    if (token.kind === "range") {
      seenTimes.push(token.startSeconds, token.endSeconds);
      return true;
    }

    if (seenTimes.some((seconds) => Math.abs(seconds - token.seconds) <= 2)) {
      return false;
    }

    seenTimes.push(token.seconds);
    return true;
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
