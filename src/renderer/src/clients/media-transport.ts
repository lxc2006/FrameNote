import type { DesktopMediaConnection } from "@/shared/ipc-contract";
import { desktopBridge, unwrapDesktopResult } from "./desktop-bridge";

let desktopConnection: Promise<DesktopMediaConnection> | undefined;

async function getDesktopConnection() {
  const bridge = desktopBridge();
  if (!bridge) {
    throw new Error("FrameNote 桌面媒体桥接不可用，请重新启动应用。");
  }
  desktopConnection ??= bridge.media
    .getConnection()
    .then(unwrapDesktopResult)
    .catch((error) => {
      desktopConnection = undefined;
      throw error;
    });
  return desktopConnection;
}

export async function mediaApiFetch(path: string, init?: RequestInit) {
  const connection = await getDesktopConnection();
  if (!path.startsWith("/v1/media/") && !path.startsWith("/v1/bilibili/")) {
    throw new TypeError(`Unsupported media sidecar path: ${path}`);
  }

  const headers = new Headers(init?.headers);
  headers.set(
    "authorization",
    `Bearer ${connection.authorizationToken}`,
  );
  return fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers,
    credentials: "omit",
  });
}
