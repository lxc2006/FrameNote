import { app, dialog } from "electron";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;
let started = false;

export function startAutomaticUpdates() {
  if (
    started ||
    !app.isPackaged ||
    process.env.FRAMENOTE_DISABLE_AUTO_UPDATE === "1"
  ) {
    return;
  }
  started = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = console;
  autoUpdater.on("error", (error) => {
    console.error("FrameNote automatic update failed.", error);
  });
  autoUpdater.on("update-downloaded", (event) => {
    void dialog
      .showMessageBox({
        type: "info",
        title: "FrameNote 更新已就绪",
        message: `FrameNote ${event.version} 已下载完成。`,
        detail: "现在重启即可完成更新；选择稍后时会在退出应用后自动安装。",
        buttons: ["立即重启并安装", "稍后"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall(false, true);
      });
  });
  setTimeout(() => {
    void autoUpdater.checkForUpdatesAndNotify().catch((error) => {
      console.error("FrameNote update check failed.", error);
    });
  }, 15_000).unref();
}
