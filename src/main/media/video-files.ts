import { BrowserWindow, dialog, ipcMain, net, protocol, type IpcMainInvokeEvent } from "electron";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DESKTOP_CHANNELS, type DesktopIpcResult } from "../../shared/ipc-contract";
import type { LocalVideoFile, VideoDownloadInput, VideoDownloadResult } from "../../shared/video-files";
import type { BilibiliPreviewResponse } from "../../shared/bilibili-api";
import type { DouyinPreviewResponse } from "../../shared/douyin-api";
import type { MediaSidecarManager } from "./media-sidecar";
import type { DouyinCookieSession } from "./douyin-cookie-session";

const execFileAsync = promisify(execFile);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);
const localVideos = new Map<string, { path: string; owner: number }>();
const downloads = new Map<string, AbortController>();
const downloadTasks = new Set<Promise<unknown>>();
const localVideoOwners = new Set<number>();

export function registerVideoFileScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: "framenote-media",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  }]);
}

async function localVideoPath(value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value) || !videoExtensions.has(extname(value).toLowerCase())) {
    throw new Error("没有找到有效的本地视频路径。");
  }
  try {
    const path = await realpath(value);
    if (!videoExtensions.has(extname(path).toLowerCase()) || !(await stat(path)).isFile()) throw new Error("not a video file");
    return path;
  } catch {
    throw new Error(`找不到本地视频，文件可能已移动或删除：${value}`);
  }
}

function trustedWindow(event: IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error("无效的视频文件请求。");
  return window;
}

async function result<T>(work: () => Promise<T>): Promise<DesktopIpcResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, error: { code: "VIDEO_FILE_ERROR", message: error instanceof Error ? error.message : "视频文件操作失败。" } };
  }
}

function suggestedName(title: string, extension: string) {
  const stem = String(title || "视频").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 140).replace(/[. ]+$/, "");
  const safeStem = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `_${stem}` : stem;
  return `${safeStem || "视频"}${extension}`;
}

async function downloadStream(url: string, path: string, signal: AbortSignal) {
  const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
  const response = await fetch(url, { signal: downloadSignal });
  if (!response.ok || !response.body) throw new Error(`视频下载失败（HTTP ${response.status}）。`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path, { flags: "wx" }), { signal: downloadSignal });
  if ((await stat(path)).size === 0) throw new Error("下载的视频为空，请重新获取视频。");
}

async function saveVideo(
  event: IpcMainInvokeEvent,
  input: VideoDownloadInput,
  sidecar: MediaSidecarManager,
  douyinCookieSession: DouyinCookieSession,
  signal: AbortSignal,
): Promise<VideoDownloadResult> {
  const window = trustedWindow(event);
  if (!input || !["local", "bilibili", "douyin", "remote"].includes(input.kind)) throw new Error("视频下载来源无效。");
  const sourcePath = input.kind === "local" ? await localVideoPath(input.path) : undefined;
  if (input.kind === "bilibili" && !/^BV[0-9A-Za-z]{10}$/.test(input.bvid)) throw new Error("BV 号无效。");
  if (input.kind === "douyin") {
    const url = new URL(input.sourceUrl);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (hostname !== "douyin.com" && !hostname.endsWith(".douyin.com"))
    ) throw new Error("抖音分享链接无效。");
  }
  if (input.kind === "remote") {
    const url = new URL(input.url);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("视频直链必须是 HTTPS 地址。");
  }
  const remoteExtension = input.kind === "remote" ? extname(new URL(input.url).pathname).toLowerCase() : "";
  const extension = sourcePath ? extname(sourcePath) : videoExtensions.has(remoteExtension) ? remoteExtension : ".mp4";
  const choice = await dialog.showSaveDialog(window, {
    title: "保存视频",
    defaultPath: sourcePath ? basename(sourcePath) : suggestedName("title" in input ? input.title : "视频", extension),
    filters: [{ name: "视频文件", extensions: [extension.slice(1)] }],
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });
  if (choice.canceled || !choice.filePath || signal.aborted) return { cancelled: true };
  const destination = choice.filePath;
  if (sourcePath && sourcePath.toLowerCase() === destination.toLowerCase()) return { cancelled: false, path: destination };
  // Stage on the destination drive so the completed file can be renamed into place.
  const temporary = await mkdtemp(join(dirname(destination), ".framenote-download-"));
  const output = join(temporary, `video${extension}`);
  try {
    if (sourcePath) {
      await pipeline(createReadStream(sourcePath), createWriteStream(output, { flags: "wx" }), { signal });
    } else if (input.kind === "remote") {
      await downloadStream(input.url, output, signal);
    } else if (input.kind === "bilibili") {
      const connection = sidecar.getConnection();
      const response = await fetch(`${connection.baseUrl}/v1/bilibili/preview`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${connection.authorizationToken}` },
        body: JSON.stringify({ bvid: input.bvid }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      const preview = await response.json() as BilibiliPreviewResponse & { error?: { message?: string } };
      if (!response.ok) throw new Error(preview.error?.message || "无法获取 B站下载地址。");
      const proxyUrl = (value: string, kind: string) => {
        const url = new URL(value);
        if (url.origin !== connection.baseUrl || !new RegExp(`^/v1/bilibili/preview/[A-Za-z0-9_-]+/${kind}$`).test(url.pathname)) throw new Error("视频下载地址无效。");
        return url.href;
      };
      const video = join(temporary, "video-track.mp4");
      const audio = join(temporary, "audio-track.m4a");
      await downloadStream(proxyUrl(preview.playbackUrl, "video"), video, signal);
      if (preview.audioPlaybackUrl) {
        await downloadStream(proxyUrl(preview.audioPlaybackUrl, "audio"), audio, signal);
        await execFileAsync(sidecar.getFfmpegPath(), [
          "-nostdin", "-v", "error", "-i", video, "-i", audio,
          "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", output,
        ], { windowsHide: true, signal, maxBuffer: 1024 * 1024 });
      } else {
        await rename(video, output);
      }
    } else if (input.kind === "douyin") {
      await douyinCookieSession.prepare();
      const connection = sidecar.getConnection();
      const response = await fetch(`${connection.baseUrl}/v1/douyin/preview`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${connection.authorizationToken}` },
        body: JSON.stringify({ sourceUrl: input.sourceUrl }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      const preview = await response.json() as DouyinPreviewResponse & { error?: { message?: string } };
      if (!response.ok) throw new Error(preview.error?.message || "无法获取抖音视频下载地址。");
      const url = new URL(preview.playbackUrl);
      if (
        url.origin !== connection.baseUrl ||
        !/^\/v1\/douyin\/preview\/[A-Za-z0-9_-]+\/video$/u.test(url.pathname)
      ) throw new Error("抖音视频下载地址无效。");
      await downloadStream(url.href, output, signal);
    }
    signal.throwIfAborted();
    if (!(await stat(output)).size) throw new Error("没有生成有效的视频文件。");
    await rename(output, destination);
    return { cancelled: false, path: destination };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function registerVideoFiles(
  sidecar: MediaSidecarManager,
  douyinCookieSession: DouyinCookieSession,
) {
  protocol.handle("framenote-media", async (request) => {
    const url = new URL(request.url);
    const entry = localVideos.get(url.hostname);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      "Cache-Control": "no-store",
    };
    if (!entry || url.pathname !== "/video") return new Response("Video not found", { status: 404, headers: corsHeaders });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: corsHeaders });
    try {
      // Chromium's file loader supports Range and streams without reading the entire video into memory.
      const response = await net.fetch(pathToFileURL(entry.path).href, { method: request.method, headers: request.headers });
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response("Video not found", { status: 404, headers: corsHeaders });
    }
  });
  ipcMain.handle(DESKTOP_CHANNELS.videoOpenLocal, (event, value: unknown) => result<LocalVideoFile>(async () => {
    trustedWindow(event);
    const path = await localVideoPath(value);
    const info = await stat(path);
    const token = randomUUID();
    localVideos.set(token, { path, owner: event.sender.id });
    if (!localVideoOwners.has(event.sender.id)) {
      const owner = event.sender.id;
      localVideoOwners.add(owner);
      event.sender.once("destroyed", () => {
        for (const [key, entry] of localVideos) if (entry.owner === owner) localVideos.delete(key);
        localVideoOwners.delete(owner);
      });
    }
    return { path, name: basename(path), size: info.size, lastModified: info.mtimeMs, playbackUrl: `framenote-media://${token}/video` };
  }));
  ipcMain.on(DESKTOP_CHANNELS.videoReleaseLocal, (event, value: unknown) => {
    try {
      const token = new URL(String(value)).hostname;
      if (localVideos.get(token)?.owner === event.sender.id) localVideos.delete(token);
    } catch { /* Ignore already released URLs. */ }
  });
  ipcMain.handle(DESKTOP_CHANNELS.videoDownload, (event, requestId: string, input: VideoDownloadInput) => {
    const task = result<VideoDownloadResult>(async () => {
      trustedWindow(event);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error("无效的下载请求。");
      const key = `${event.sender.id}:${requestId}`;
      if (downloads.has(key)) throw new Error("视频正在下载。");
      const controller = new AbortController();
      downloads.set(key, controller);
      const cancel = () => controller.abort();
      event.sender.once("destroyed", cancel);
      try {
        return await saveVideo(
          event,
          input,
          sidecar,
          douyinCookieSession,
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) return { cancelled: true };
        throw error;
      } finally {
        downloads.delete(key);
        event.sender.removeListener("destroyed", cancel);
      }
    });
    downloadTasks.add(task);
    void task.finally(() => downloadTasks.delete(task));
    return task;
  });
  ipcMain.on(DESKTOP_CHANNELS.videoCancelDownload, (event, requestId: string) => {
    downloads.get(`${event.sender.id}:${requestId}`)?.abort();
  });
}

export async function abortVideoDownloads() {
  for (const controller of downloads.values()) controller.abort();
  // Allow streams/FFmpeg to close and their staging folders to be removed. Do not hang on an open save dialog.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...downloadTasks]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
