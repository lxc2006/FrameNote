import { BrowserWindow, session } from "electron";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DOUYIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/138.0.0.0 Safari/537.36";

function isAllowedDouyinNavigation(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    return (
      url.protocol === "https:" &&
      (hostname === "douyin.com" || hostname.endsWith(".douyin.com"))
    );
  } catch {
    return false;
  }
}

export class DouyinCookieSession {
  private readonly cookieFile: string;
  private preparing: Promise<void> | undefined;

  constructor(cookieFile: string) {
    this.cookieFile = cookieFile;
  }

  prepare() {
    this.preparing ??= this.exportCookies().finally(() => {
      this.preparing = undefined;
    });
    return this.preparing;
  }

  async dispose() {
    await rm(this.cookieFile, { force: true });
  }

  private async exportCookies() {
    const browserSession = session.fromPartition("framenote-douyin-anonymous");
    browserSession.setUserAgent(DOUYIN_USER_AGENT);
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-frame-navigate", (event) => {
      if (!isAllowedDouyinNavigation(event.url)) event.preventDefault();
    });
    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedDouyinNavigation(url)) event.preventDefault();
    });
    window.webContents.on("will-redirect", (event, url) => {
      if (!isAllowedDouyinNavigation(url)) event.preventDefault();
    });
    try {
      await window.loadURL("https://www.douyin.com/");
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const cookies = (await browserSession.cookies.get({})).filter((cookie) => {
        const domain = (cookie.domain ?? "").replace(/^\./u, "").toLowerCase();
        return domain === "douyin.com" || domain.endsWith(".douyin.com");
      });
      if (cookies.length === 0) throw new Error("未能建立抖音匿名会话，请稍后重试。");

      const lines = cookies.map((cookie) => {
        const domain = cookie.domain || ".douyin.com";
        const fileDomain = cookie.httpOnly ? `#HttpOnly_${domain}` : domain;
        return [
          fileDomain,
          domain.startsWith(".") ? "TRUE" : "FALSE",
          cookie.path || "/",
          cookie.secure ? "TRUE" : "FALSE",
          Math.floor(cookie.expirationDate ?? 0),
          cookie.name.replace(/[\t\r\n]/gu, ""),
          cookie.value.replace(/[\t\r\n]/gu, ""),
        ].join("\t");
      });
      await mkdir(dirname(this.cookieFile), { recursive: true });
      await writeFile(
        this.cookieFile,
        `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`,
        "utf8",
      );
    } finally {
      window.destroy();
    }
  }
}
