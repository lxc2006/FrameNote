import type { LocalVideoFile } from "@/shared/video-files";
import { desktopBridge, unwrapDesktopResult } from "./desktop-bridge";

export function videoFilesApi() {
  const api = desktopBridge()?.videoFiles;
  if (!api) throw new Error("桌面视频文件接口不可用，请重启软件。");
  return api;
}

export async function openLocalVideo(path: string): Promise<LocalVideoFile> {
  return unwrapDesktopResult(await videoFilesApi().openLocal(path));
}

export function releaseLocalVideo(url: string) {
  desktopBridge()?.videoFiles?.releaseLocal(url);
}
