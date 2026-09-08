import type {
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from "react";

export interface VideoPreviewModel {
  kind: "bilibili" | "douyin" | "local" | "remote";
  playbackUrl: string;
  audioPlaybackUrl?: string;
  filename: string;
  title?: string;
  description?: string;
  sizeLabel?: string;
  durationLabel?: string;
  resolutionLabel?: string;
  sourceLabel?: string;
  sourceUrl?: string;
  durationSeconds?: number;
  localPath?: string;
}

interface TranscriptChunkProgress {
  completedChunks: number;
  totalChunks: number;
}

interface VideoPreviewProps {
  preview: VideoPreviewModel;
  placement: "conversation" | "side";
  playerRef: RefObject<HTMLVideoElement | null>;
  isFullscreen: boolean;
  isExtractingTranscript: boolean;
  transcriptExtractionProgress: number | null;
  transcriptChunkProgress: TranscriptChunkProgress | null;
  canExtractTranscript: boolean;
  downloadAction: ReactNode;
  descriptionParagraphs: string[];
  onChooseFile: () => void;
  onExtractTranscript: () => void;
  onToggleFullscreen: () => void;
  onVideoClick: (event: ReactMouseEvent<HTMLVideoElement>) => void;
  onVideoDoubleClick: (event: ReactMouseEvent<HTMLVideoElement>) => void;
  onSyncAudio: (
    video: HTMLVideoElement,
    options?: { forceTime?: boolean; play?: boolean },
  ) => void;
  onVideoError: () => void;
  onLoadedMetadata: (video: HTMLVideoElement) => void;
}

export default function VideoPreview({
  preview,
  placement,
  playerRef,
  isFullscreen,
  isExtractingTranscript,
  transcriptExtractionProgress,
  transcriptChunkProgress,
  canExtractTranscript,
  downloadAction,
  descriptionParagraphs,
  onChooseFile,
  onExtractTranscript,
  onToggleFullscreen,
  onVideoClick,
  onVideoDoubleClick,
  onSyncAudio,
  onVideoError,
  onLoadedMetadata,
}: VideoPreviewProps) {
  const details = (
    <div className="video-preview-details">
      <strong>{preview.title ?? preview.filename}</strong>
      <div className="video-preview-meta" aria-label="视频信息">
        {preview.sourceLabel ? <span>{preview.sourceLabel}</span> : null}
        {preview.sizeLabel ? <span>{preview.sizeLabel}</span> : null}
        {preview.durationLabel ? <span>{preview.durationLabel}</span> : null}
        {preview.resolutionLabel ? <span>{preview.resolutionLabel}</span> : null}
      </div>
      {placement === "side" ? (
        <div className="video-preview-actions">
          {preview.kind === "local" ? (
            <button
              className="video-preview-change"
              type="button"
              disabled={isExtractingTranscript}
              onClick={onChooseFile}
            >
              更改
            </button>
          ) : null}
          {canExtractTranscript ? (
            <button
              className="video-preview-transcript"
              type="button"
              disabled={isExtractingTranscript}
              onClick={onExtractTranscript}
            >
              {isExtractingTranscript && transcriptExtractionProgress !== null
                ? "正在在线识别"
                : "在线识别字幕"}
            </button>
          ) : null}
          {downloadAction}
          {transcriptExtractionProgress !== null ? (
            <div
              className="transcript-extraction-progress"
              role="progressbar"
              aria-label="字幕提取进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(transcriptExtractionProgress * 100)}
            >
              <div className="transcript-extraction-progress-label">
                <span>
                  {transcriptChunkProgress
                    ? `已识别 ${transcriptChunkProgress.completedChunks}/${transcriptChunkProgress.totalChunks} 个音频分片`
                    : "正在准备音频分片"}
                </span>
                <strong>
                  {transcriptChunkProgress
                    ? `${transcriptChunkProgress.completedChunks}/${transcriptChunkProgress.totalChunks}`
                    : "…"}
                </strong>
              </div>
              <div className="transcript-extraction-progress-track">
                <span
                  style={{
                    width: `${Math.round(transcriptExtractionProgress * 100)}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const player = (
    <div
      className={`video-preview-player${isFullscreen ? " app-video-fullscreen" : ""}`}
    >
      <button
        className="video-fullscreen-button"
        type="button"
        onClick={onToggleFullscreen}
        aria-label={isFullscreen ? "退出应用内全屏" : "应用内全屏播放"}
        title={isFullscreen ? "退出应用内全屏（Esc）" : "应用内全屏播放"}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path
            d={
              isFullscreen
                ? "M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6"
                : "M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"
            }
          />
        </svg>
      </button>
      <video
        ref={playerRef}
        src={preview.playbackUrl}
        controls
        controlsList="nofullscreen"
        playsInline
        preload="metadata"
        tabIndex={-1}
        onClick={onVideoClick}
        onDoubleClick={onVideoDoubleClick}
        onPlay={(event) =>
          onSyncAudio(event.currentTarget, { forceTime: true, play: true })
        }
        onPlaying={(event) =>
          onSyncAudio(event.currentTarget, { forceTime: true, play: true })
        }
        onPause={(event) => onSyncAudio(event.currentTarget, { play: false })}
        onWaiting={(event) => onSyncAudio(event.currentTarget, { play: false })}
        onSeeking={(event) =>
          onSyncAudio(event.currentTarget, { forceTime: true, play: false })
        }
        onSeeked={(event) =>
          onSyncAudio(event.currentTarget, {
            forceTime: true,
            play: !event.currentTarget.paused,
          })
        }
        onRateChange={(event) => onSyncAudio(event.currentTarget)}
        onVolumeChange={(event) => onSyncAudio(event.currentTarget)}
        onTimeUpdate={(event) => onSyncAudio(event.currentTarget)}
        onError={onVideoError}
        onEnded={(event) => onSyncAudio(event.currentTarget, { play: false })}
        onLoadedMetadata={(event) => onLoadedMetadata(event.currentTarget)}
      >
        当前浏览器无法播放这个视频。
      </video>
      {preview.audioPlaybackUrl ? (
        <audio
          data-preview-audio
          src={preview.audioPlaybackUrl}
          preload="metadata"
          aria-hidden="true"
        />
      ) : null}
    </div>
  );

  return (
    <section className={`video-preview-card ${placement}`} aria-label="视频预览">
      {placement === "side" ? details : player}
      {placement === "side" ? player : details}
      {placement === "conversation" && preview.description ? (
        <section
          className="video-preview-description"
          aria-labelledby="preview-description-title"
        >
          <h3 id="preview-description-title">视频简介</h3>
          {descriptionParagraphs.map((paragraph, index) => (
            <p key={`preview-description-${index}`}>{paragraph}</p>
          ))}
        </section>
      ) : null}
    </section>
  );
}
