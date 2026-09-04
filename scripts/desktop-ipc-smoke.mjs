import assert from "node:assert/strict";

const endpoint = process.env.FRAMENOTE_CDP_ENDPOINT ?? "http://127.0.0.1:9333";
const targetsResponse = await fetch(`${endpoint}/json/list`);
assert.equal(targetsResponse.ok, true, `无法读取 Electron 调试目标：${targetsResponse.status}`);

const targets = await targetsResponse.json();
const target = targets.find(
  (candidate) =>
    candidate.type === "page" &&
    typeof candidate.webSocketDebuggerUrl === "string",
);
assert.ok(target, "没有找到可用的 Electron Renderer 调试目标。");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(
    () => reject(new Error("连接 Electron Renderer 调试目标超时。")),
    10_000,
  );
  socket.addEventListener(
    "open",
    () => {
      clearTimeout(timeout);
      resolve();
    },
    { once: true },
  );
  socket.addEventListener(
    "error",
    () => {
      clearTimeout(timeout);
      reject(new Error("无法连接 Electron Renderer 调试目标。"));
    },
    { once: true },
  );
});

let nextRequestId = 1;
function send(method, params) {
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`Electron 调试命令超时：${method}`));
    }, 10_000);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      if (message.error) {
        reject(new Error(message.error.message));
        return;
      }
      resolve(message.result);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

try {
  const evaluation = await send("Runtime.evaluate", {
    expression: `(async () => {
      const api = window.framenoteDesktop;
      if (!api) return { hasBridge: false };
      const runtime = await api.getRuntimeInfo();
      const media = await api.media.getConnection();
      const subtitles = await api.subtitles.getStatus();
      const conversations = await api.conversations.list();
      const settings = await api.settings.getUserPreferences();
      const invalidModel = await api.model.analyzeVideo(crypto.randomUUID(), {});
      return {
        hasBridge: true,
        runtime,
        media,
        subtitles,
        conversations,
        settings,
        invalidModel,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  assert.equal(evaluation.exceptionDetails, undefined, "Renderer IPC 调用发生异常。");
  const result = evaluation.result?.value;
  assert.equal(result?.hasBridge, true, "preload 没有暴露 FrameNote 桌面桥接。 ");
  assert.equal(result.runtime?.platform, "win32", "桌面运行平台不是 Windows。");
  assert.equal(result.media?.ok, true, "媒体核心 sidecar IPC 调用失败。");
  assert.equal(result.subtitles?.ok, true, "字幕扩展状态 IPC 调用失败。");
  assert.ok(
    ["not-installed", "installed", "update-available"].includes(
      result.subtitles.value?.state,
    ),
    "字幕扩展状态无效。",
  );
  const mediaBaseUrl = new URL(result.media.value?.baseUrl);
  assert.equal(mediaBaseUrl.protocol, "http:", "媒体核心 sidecar 协议无效。");
  assert.equal(mediaBaseUrl.hostname, "127.0.0.1", "媒体核心必须绑定回环地址。");
  assert.ok(Number(mediaBaseUrl.port) >= 1024, "媒体核心 sidecar 端口无效。");
  assert.equal(
    result.media.value.capabilities.transcription,
    false,
    "核心媒体包不应包含字幕识别能力。",
  );
  assert.equal(result.conversations?.ok, true, "本地会话 IPC 调用失败。");
  assert.ok(Array.isArray(result.conversations.value), "本地会话 IPC 未返回列表。");
  assert.equal(result.settings?.ok, true, "本地设置 IPC 调用失败。");
  assert.equal(result.invalidModel?.ok, false, "无效模型请求未被主进程拒绝。");

  console.log(
    JSON.stringify(
      {
        rendererUrl: target.url,
        runtime: result.runtime,
        media: {
          baseUrl: result.media.value.baseUrl,
          capabilities: result.media.value.capabilities,
        },
        subtitles: result.subtitles.value,
        conversationCount: result.conversations.value.length,
        hasStoredPreferences: result.settings.value !== null,
        invalidModelError: result.invalidModel.error,
      },
      null,
      2,
    ),
  );
  if (process.env.FRAMENOTE_SMOKE_CLOSE_WINDOW === "1") {
    await send("Runtime.evaluate", {
      expression: "setTimeout(() => window.close(), 100); true",
      returnByValue: true,
    });
  }
} finally {
  socket.close();
}
