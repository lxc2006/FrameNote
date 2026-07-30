import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVideoTimeHref,
  prepareMarkdownContent,
} from "../lib/client/markdown-content.ts";

test("prepares standard Markdown while normalizing FrameNote video times", () => {
  assert.equal(
    prepareMarkdownContent("**`agent.md` / `AGENTS.md` 像项目说明书**"),
    "**`agent.md` / `AGENTS.md` 像项目说明书**",
  );
  assert.equal(
    prepareMarkdownContent(
      "```text\nwechat-publisher/\n├── SKILL.md\n`\n后续说明",
    ),
    "```text\nwechat-publisher/\n├── SKILL.md\n`\n后续说明",
  );
  assert.equal(
    prepareMarkdownContent(
      "1. 示例\n\n    ```text\n    tree/\n    ```\n\n    后续说明",
    ),
    "1. 示例\n\n    ```text\n    tree/\n    ```\n\n    后续说明",
  );
  assert.equal(
    prepareMarkdownContent(
      "错误旧值 [[video:536.000|11:53]] [[video:536.000|11:53]]",
    ),
    "错误旧值 [11:53](framenote-video:713)",
  );
  assert.equal(
    prepareMarkdownContent(
      "区间 [[video:5.000|00:05]] 至 [[video:65.000|01:05]]",
    ),
    "区间 [00:05](framenote-video:5) ~ [01:05](framenote-video:65)",
  );
  assert.equal(parseVideoTimeHref("framenote-video:713"), 713);
  assert.equal(parseVideoTimeHref("javascript:alert(1)"), null);
});
