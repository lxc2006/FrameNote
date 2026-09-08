import { BrowserWindow, Menu, clipboard, shell } from "electron";
import { join } from "node:path";
import {
  DESKTOP_CHANNELS,
  type DesktopClipboardCandidate,
} from "../shared/ipc-contract";

interface MainWindowOptions {
  shouldDetectClipboardLinks?: () => boolean;
}

function clipboardCandidate(text: string): DesktopClipboardCandidate | null {
  const value = text.trim();
  if (!value || value.length > 4_096) return null;

  for (const match of value.matchAll(/https:\/\/[^\s]+/giu)) {
    const candidate = match[0].replace(/[，。！？；、）》】」』]+$/u, "");
    try {
      const url = new URL(candidate);
      const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
      if (hostname === "douyin.com" || hostname.endsWith(".douyin.com")) {
        return { kind: "douyin", value: url.href };
      }
      const bvid = url.href.match(/BV[0-9A-Za-z]{10}/iu)?.[0];
      if (bvid) return { kind: "bilibili", value: `BV${bvid.slice(2)}` };
      if (/\.(?:mp4|mov|webm|mkv|m4v|avi|flv|wmv)$/iu.test(url.pathname)) {
        return { kind: "remote", value: url.href };
      }
    } catch {
      // Continue with the next URL in the copied text.
    }
  }

  const bvid = value.match(/BV[0-9A-Za-z]{10}/iu)?.[0];
  return bvid ? { kind: "bilibili", value: `BV${bvid.slice(2)}` } : null;
}

function parseExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isInternalNavigation(targetValue: string, currentValue: string) {
  try {
    const target = new URL(targetValue);
    const current = new URL(currentValue);
    if (target.protocol === "file:" && current.protocol === "file:") {
      return target.pathname === current.pathname;
    }
    return target.origin === current.origin;
  } catch {
    return false;
  }
}

export async function openExternalUrl(value: string) {
  const url = parseExternalUrl(value);
  if (!url) throw new Error("Only HTTP and HTTPS links may be opened externally.");
  await shell.openExternal(url.toString());
}

export function hasMainWindow() {
  return BrowserWindow.getAllWindows().length > 0;
}

export function createMainWindow(options: MainWindowOptions = {}) {
  Menu.setApplicationMenu(null);
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#f5f5f4",
    title: "帧记 FrameNote",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  let hasFocused = false;
  let lastClipboardText = "";
  mainWindow.on("focus", () => {
    void (async () => {
      if (!hasFocused) {
        hasFocused = true;
        return;
      }
      if (options.shouldDetectClipboardLinks?.() === false) return;
      const clipboardValue = await clipboard.readText();
      if (typeof clipboardValue !== "string") return;
      const text = clipboardValue.trim();
      if (!text || text === lastClipboardText) return;
      lastClipboardText = text;
      const candidate = clipboardCandidate(text);
      if (candidate) {
        mainWindow.webContents.send(
          DESKTOP_CHANNELS.clipboardCandidate,
          candidate,
        );
      }
    })().catch((error: unknown) => {
      console.warn("Unable to inspect clipboard contents.", error);
    });
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (parseExternalUrl(url)) void openExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isInternalNavigation(url, mainWindow.webContents.getURL())) return;
    event.preventDefault();
    if (parseExternalUrl(url)) void openExternalUrl(url);
  });
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    () => false,
  );

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) void mainWindow.loadURL(rendererUrl);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}
