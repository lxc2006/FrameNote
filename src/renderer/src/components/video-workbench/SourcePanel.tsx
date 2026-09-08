import type {
  ChangeEventHandler,
  DragEventHandler,
  ReactNode,
  RefObject,
} from "react";
import { formatDuration, formatFileSize } from "@/shared/media-types";

export type InputMode = "upload" | "bilibili" | "douyin";
export type WorkbenchPhase = "idle" | "processing" | "ready" | "error";

export interface SelectedVideo {
  file?: File;
  name: string;
  size: number;
  lastModified: number;
  localPath: string;
  objectUrl: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface InlineNotice {
  message: string;
  tone: "error" | "success";
}

interface SourcePanelProps {
  mode: InputMode;
  phase: WorkbenchPhase;
  selectedVideo: SelectedVideo | null;
  bilibiliInput: string;
  bvid: string | null;
  directVideoUrl: string | null;
  douyinInput: string;
  douyinUrl: string | null;
  notice: InlineNotice | null;
  isDragging: boolean;
  isFetchingVideo: boolean;
  canFetchVideo: boolean;
  canAnalyze: boolean;
  fetchVideoLabel: string;
  showingSideVideo: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  sideVideoPreviewRef: RefObject<HTMLDivElement | null>;
  analysisSettings: ReactNode;
  sideVideo: ReactNode;
  onModeChange: (mode: InputMode) => void;
  onFileChange: ChangeEventHandler<HTMLInputElement>;
  onDraggingChange: (dragging: boolean) => void;
  onDrop: DragEventHandler<HTMLDivElement>;
  onSelectedVideoMetadata: (
    objectUrl: string,
    metadata: { duration: number; width: number; height: number },
  ) => void;
  onBilibiliInputChange: (value: string) => void;
  onDouyinInputChange: (value: string) => void;
  onFetchVideo: () => void;
  onAnalyze: () => void;
}

export default function SourcePanel({
  mode,
  phase,
  selectedVideo,
  bilibiliInput,
  bvid,
  directVideoUrl,
  douyinInput,
  douyinUrl,
  notice,
  isDragging,
  isFetchingVideo,
  canFetchVideo,
  canAnalyze,
  fetchVideoLabel,
  showingSideVideo,
  fileInputRef,
  sideVideoPreviewRef,
  analysisSettings,
  sideVideo,
  onModeChange,
  onFileChange,
  onDraggingChange,
  onDrop,
  onSelectedVideoMetadata,
  onBilibiliInputChange,
  onDouyinInputChange,
  onFetchVideo,
  onAnalyze,
}: SourcePanelProps) {
  const busy = phase === "processing";

  return (
    <div className="sidebar-pane source-pane">
      <div className="sidebar-pane-content">
        <div
          className={`source-card ${showingSideVideo ? "showing-side-video" : ""}`}
        >
          <div className="mode-tabs" role="tablist" aria-label="选择视频来源">
            <button
              className={mode === "upload" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "upload"}
              disabled={busy || isFetchingVideo}
              onClick={() => onModeChange("upload")}
            >
              <span aria-hidden="true">↥</span>
              本地
            </button>
            <button
              className={mode === "bilibili" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "bilibili"}
              disabled={busy || isFetchingVideo}
              onClick={() => onModeChange("bilibili")}
            >
              <svg
                className="platform-tab-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                aria-hidden="true"
              >
                <path d="m8 3 3 3m5-3-3 3M5 7h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
                <path d="M8 12v3m8-3v3" />
              </svg>
              B站
            </button>
            <button
              className={mode === "douyin" ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={mode === "douyin"}
              disabled={busy || isFetchingVideo}
              onClick={() => onModeChange("douyin")}
            >
              <svg
                className="platform-tab-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                aria-hidden="true"
              >
                <path d="M14 4v10.2a4.2 4.2 0 1 1-3.1-4.05" />
                <path d="M14 4c.7 2.45 2.35 4 5 4.45" />
              </svg>
              抖音
            </button>
          </div>

          {mode === "upload" ? (
            <div className="source-form" role="tabpanel">
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept="video/mp4,video/webm,video/quicktime,.mkv,.m4v"
                disabled={busy}
                onChange={onFileChange}
                aria-label="选择文件"
              />
              {!selectedVideo ? (
                <div
                  className={`drop-zone ${isDragging ? "dragging" : ""}`}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    onDraggingChange(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => onDraggingChange(false)}
                  onDrop={onDrop}
                >
                  <span className="drop-icon" aria-hidden="true">
                    ↥
                  </span>
                  <strong>拖放视频到这里</strong>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    选择文件
                  </button>
                </div>
              ) : (
                <div className="selected-file">
                  <div className="file-preview">
                    <video
                      src={selectedVideo.objectUrl}
                      preload="metadata"
                      muted
                      onLoadedMetadata={(event) =>
                        onSelectedVideoMetadata(selectedVideo.objectUrl, {
                          duration: event.currentTarget.duration,
                          width: event.currentTarget.videoWidth,
                          height: event.currentTarget.videoHeight,
                        })
                      }
                    />
                    <span aria-hidden="true">▶</span>
                  </div>
                  <div className="file-details">
                    <strong>{selectedVideo.name}</strong>
                    <span>
                      {formatFileSize(selectedVideo.size)} ·{" "}
                      {selectedVideo.duration
                        ? formatDuration(selectedVideo.duration)
                        : "正在读取时长"}
                      {selectedVideo.width && selectedVideo.height
                        ? ` · ${selectedVideo.width}x${selectedVideo.height}`
                        : ""}
                    </span>
                  </div>
                  <button
                    className="replace-file"
                    type="button"
                    disabled={busy}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    更换
                  </button>
                </div>
              )}
            </div>
          ) : mode === "bilibili" ? (
            <div className="source-form" role="tabpanel">
              <label className="field-label" htmlFor="bilibili-source">
                B站链接、BV 号或 HTTPS 视频直链
              </label>
              <div
                className={`link-input ${
                  bilibiliInput && !bvid && !directVideoUrl ? "invalid" : ""
                }`}
              >
                <span aria-hidden="true">↗</span>
                <input
                  id="bilibili-source"
                  value={bilibiliInput}
                  disabled={busy || isFetchingVideo}
                  onChange={(event) => onBilibiliInputChange(event.target.value)}
                  placeholder="BV... 或 https://example.com/video.mp4"
                  autoComplete="off"
                  spellCheck={false}
                />
                {bvid || directVideoUrl ? (
                  <span className="valid-mark">
                    {directVideoUrl ? "视频直链" : "已识别"}
                  </span>
                ) : null}
              </div>
              {bilibiliInput && !bvid && !directVideoUrl ? (
                <p className="field-error">
                  没有识别到 BV 号或受支持的 HTTPS 视频直链。
                </p>
              ) : null}
            </div>
          ) : (
            <div className="source-form" role="tabpanel">
              <label className="field-label" htmlFor="douyin-source">
                抖音分享链接
              </label>
              <div
                className={`link-input ${douyinInput && !douyinUrl ? "invalid" : ""}`}
              >
                <span aria-hidden="true">↗</span>
                <input
                  id="douyin-source"
                  value={douyinInput}
                  disabled={busy || isFetchingVideo}
                  onChange={(event) => onDouyinInputChange(event.target.value)}
                  placeholder="粘贴抖音分享文本或 https://v.douyin.com/..."
                  autoComplete="off"
                  spellCheck={false}
                />
                {douyinUrl ? <span className="valid-mark">已识别</span> : null}
              </div>
              {douyinInput && !douyinUrl ? (
                <p className="field-error">没有识别到有效的抖音 HTTPS 分享链接。</p>
              ) : null}
            </div>
          )}

          {notice ? (
            <div
              className={`inline-notice ${notice.tone}`}
              role={notice.tone === "error" ? "alert" : "status"}
            >
              <span aria-hidden="true">{notice.tone === "error" ? "!" : "✓"}</span>
              {notice.message}
            </div>
          ) : null}

          <div
            className={`source-action-row ${mode === "upload" ? "upload-action-row" : ""}`}
          >
            {mode !== "upload" ? (
              <button
                className="fetch-video-action"
                type="button"
                disabled={!canFetchVideo || busy || isFetchingVideo}
                onClick={onFetchVideo}
              >
                {isFetchingVideo ? (
                  <>
                    <span className="button-spinner" aria-hidden="true" />
                    正在获取
                  </>
                ) : (
                  <>
                    {fetchVideoLabel}
                    <span aria-hidden="true">▶</span>
                  </>
                )}
              </button>
            ) : null}
            <button
              className="primary-action source-action-primary"
              type="button"
              disabled={!canAnalyze || busy || (mode !== "upload" && isFetchingVideo)}
              onClick={onAnalyze}
            >
              {busy ? (
                <>
                  <span className="button-spinner" aria-hidden="true" />
                  正在理解视频
                </>
              ) : (
                <>
                  生成 AI 总结
                  <span aria-hidden="true">→</span>
                </>
              )}
            </button>
            {analysisSettings}
          </div>

          {showingSideVideo ? (
            <div className="side-video-context" ref={sideVideoPreviewRef}>
              {sideVideo}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
