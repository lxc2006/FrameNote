import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

function isNativeVideoControlClick(event: ReactMouseEvent<HTMLVideoElement>) {
  const bounds = event.currentTarget.getBoundingClientRect();
  const controlsHeight = Math.min(64, Math.max(44, bounds.height * 0.16));
  return event.clientY >= bounds.bottom - controlsHeight;
}

export function useVideoPlayer() {
  const playerRef = useRef<HTMLVideoElement>(null);
  const clickTimerRef = useRef<number | null>(null);
  const pendingSeekSecondsRef = useRef<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const clearPendingClick = useCallback(() => {
    if (clickTimerRef.current === null) return;
    window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
  }, []);

  const reset = useCallback(() => {
    clearPendingClick();
    pendingSeekSecondsRef.current = null;
    setIsFullscreen(false);
  }, [clearPendingClick]);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    document.body.style.overflow = "hidden";
    document.documentElement.dataset.videoFullscreen = "true";
    window.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      delete document.documentElement.dataset.videoFullscreen;
      window.removeEventListener("keydown", exitOnEscape);
    };
  }, [isFullscreen]);

  useEffect(() => clearPendingClick, [clearPendingClick]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((current) => !current);
  }, []);

  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLVideoElement>) => {
      if (isNativeVideoControlClick(event)) return;
      event.preventDefault();
      if (event.detail > 1) {
        clearPendingClick();
        return;
      }
      const video = event.currentTarget;
      clearPendingClick();
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        if (!video.isConnected) return;
        if (video.paused || video.ended) {
          if (video.ended) video.currentTime = 0;
          void video.play().catch(() => undefined);
        } else {
          video.pause();
        }
      }, 220);
    },
    [clearPendingClick],
  );

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLVideoElement>) => {
      event.preventDefault();
      if (isNativeVideoControlClick(event)) return;
      clearPendingClick();
      toggleFullscreen();
    },
    [clearPendingClick, toggleFullscreen],
  );

  const syncAudio = useCallback(
    (
      video: HTMLVideoElement,
      options: { forceTime?: boolean; play?: boolean } = {},
    ) => {
      const audio = video.parentElement?.querySelector<HTMLAudioElement>(
        "audio[data-preview-audio]",
      );
      if (!audio) return;
      audio.muted = video.muted;
      audio.volume = video.volume;
      audio.playbackRate = video.playbackRate;
      if (
        Number.isFinite(video.currentTime) &&
        (options.forceTime || Math.abs(audio.currentTime - video.currentTime) > 0.25)
      ) {
        try {
          audio.currentTime = video.currentTime;
        } catch {
          // 音轨元数据尚未就绪时，下一个媒体事件会再次同步。
        }
      }
      if (options.play) {
        void audio.play().catch(() => undefined);
      } else if (options.play === false) {
        audio.pause();
      }
    },
    [],
  );

  const seek = useCallback((seconds: number) => {
    const player = playerRef.current;
    if (!player) return false;
    if (player.readyState >= HTMLMediaElement.HAVE_METADATA) {
      if (
        Number.isFinite(player.duration) &&
        (seconds < 0 || seconds >= player.duration)
      ) {
        return false;
      }
      player.currentTime = seconds;
      void player.play().catch(() => undefined);
    } else {
      pendingSeekSecondsRef.current = seconds;
      player.load();
    }
    player.focus({ preventScroll: true });
    return true;
  }, []);

  const handleLoadedMetadata = useCallback(
    (player: HTMLVideoElement) => {
      const pendingSeconds = pendingSeekSecondsRef.current;
      if (pendingSeconds !== null) {
        pendingSeekSecondsRef.current = null;
        if (pendingSeconds >= 0 && pendingSeconds < player.duration) {
          player.currentTime = pendingSeconds;
          void player.play().catch(() => undefined);
        }
      }
      syncAudio(player, { forceTime: true });
    },
    [syncAudio],
  );

  return {
    playerRef,
    isFullscreen,
    toggleFullscreen,
    handleClick,
    handleDoubleClick,
    syncAudio,
    seek,
    handleLoadedMetadata,
    reset,
  };
}
