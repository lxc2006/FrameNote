import { BrowserWindow, shell } from "electron";
import { join } from "node:path";

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

export function createMainWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#f5f5f4",
    title: "帧记 FrameNote",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
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

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) void mainWindow.loadURL(rendererUrl);
  else void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}
