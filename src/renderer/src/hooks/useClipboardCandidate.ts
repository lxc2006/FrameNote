import { useEffect, useRef } from "react";
import type { DesktopClipboardCandidate } from "@/shared/ipc-contract";
import { desktopBridge } from "../clients/desktop-bridge";

export function useClipboardCandidate(
  onCandidate: (candidate: DesktopClipboardCandidate) => void,
) {
  const callbackRef = useRef(onCandidate);
  callbackRef.current = onCandidate;

  useEffect(() => {
    const clipboard = desktopBridge()?.clipboard;
    if (!clipboard) return;

    const acceptCandidate = (candidate: DesktopClipboardCandidate) => {
      callbackRef.current(candidate);
    };
    clipboard.subscribeCandidate(acceptCandidate);
    return () => clipboard.unsubscribeCandidate(acceptCandidate);
  }, []);
}
