import { app, ipcMain } from "electron";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ConversationService } from "./services/conversation-service";
import { ConversationRepository } from "./database/conversation-repository";
import { abortDesktopModelRequests, registerDesktopIpc } from "./ipc/register";
import { DesktopDatabase } from "./database/database";
import { MediaSidecarManager } from "./media/media-sidecar";
import { DESKTOP_CHANNELS } from "../shared/ipc-contract";
import { startAutomaticUpdates } from "./updates/auto-update";
import { createMainWindow, hasMainWindow, openExternalUrl } from "./window";
import { CredentialStore } from "./security/credential-store";
import { abortVideoDownloads, registerVideoFiles, registerVideoFileScheme } from "./media/video-files";

registerVideoFileScheme();

const DESKTOP_OWNER_ID = "desktop-local-user";
let desktopDatabase: DesktopDatabase | undefined;
let mediaSidecar: MediaSidecarManager | undefined;
let credentialStore: CredentialStore | undefined;
let shutdownStarted = false;

function loadDesktopEnvironment() {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, ".env.local"), join(process.resourcesPath, ".env")]
    : [join(process.cwd(), ".env.local"), join(process.cwd(), ".env")];
  const environmentFile = candidates.find((candidate) => existsSync(candidate));
  if (environmentFile) process.loadEnvFile(environmentFile);
}

async function removeLegacyOfflineSubtitleFiles() {
  const roots = new Set<string>();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) {
    roots.add(
      join(localAppData, "FrameNote", "extensions", "framenote-subtitles"),
    );
  }
  roots.add(
    join(app.getPath("userData"), "extensions", "framenote-subtitles"),
  );
  await Promise.all(
    [...roots].map((root) =>
      rm(root, { recursive: true, force: true }).catch((error) => {
        console.warn(
          "Unable to remove a legacy offline subtitle directory.",
          error,
        );
      }),
    ),
  );
}

app.setAppUserModelId("com.framenote.desktop");

app.whenReady().then(async () => {
  loadDesktopEnvironment();
  credentialStore = new CredentialStore(
    join(app.getPath("userData"), "credentials.json"),
  );
  await credentialStore.initialize();
  mediaSidecar = new MediaSidecarManager({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath("userData"),
  });
  try {
    await mediaSidecar.start();
  } catch (error) {
    console.error("FrameNote media core failed to start.", error);
  }
  desktopDatabase = new DesktopDatabase(
    join(app.getPath("userData"), "framenote.sqlite3"),
  );
  registerDesktopIpc(
    desktopDatabase,
    new ConversationService(
      new ConversationRepository(desktopDatabase, DESKTOP_OWNER_ID),
    ),
    mediaSidecar,
    credentialStore,
  );

  ipcMain.handle(
    DESKTOP_CHANNELS.openExternal,
    async (_event, value: unknown) => {
      if (typeof value !== "string") {
        throw new TypeError("An external URL string is required.");
      }
      await openExternalUrl(value);
    },
  );

  registerVideoFiles(mediaSidecar);
  createMainWindow();
  void removeLegacyOfflineSubtitleFiles();
  startAutomaticUpdates();

  app.on("activate", () => {
    if (!hasMainWindow()) createMainWindow();
  });
});

app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  abortDesktopModelRequests();
  void Promise.allSettled([
    abortVideoDownloads(),
    mediaSidecar?.stop() ?? Promise.resolve(),
  ]).finally(() => {
    mediaSidecar = undefined;
    desktopDatabase?.close();
    desktopDatabase = undefined;
    app.exit(0);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
