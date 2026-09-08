export type SourceKind = "upload" | "bilibili" | "douyin" | "url";
export type TranscriptLanguage = "zh" | "ja" | "en";

export interface VideoSourceDescriptor {
  kind: SourceKind;
  title: string;
  subtitle: string;
  durationLabel?: string;
  bvid?: string;
  sourceUrl?: string;
  /** 用户选择的原视频绝对路径，仅用于桌面本地恢复，不发送给模型。 */
  localPath?: string;
  /** 平台视频页公开简介。 */
  description?: string;
}

export interface VideoTranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface VideoTranscript {
  status: "ready" | "unavailable";
  text: string;
  cues: VideoTranscriptCue[];
  language?: string;
  error?: string;
}

export interface SummaryPoint {
  time?: string;
  title: string;
  detail: string;
}

export interface SummaryChapter {
  time: string;
  title: string;
  description: string;
}

export interface SummaryEvidence {
  time: string;
  fact: string;
}

export type SummaryAudioStatus = "analyzed" | "silent" | "unavailable";

export interface SummaryAudioChange {
  time: string;
  description: string;
}

export interface SummaryAudioAnalysis {
  /** analyzed=已听取并分析；silent=已检查但没有可辨声音；unavailable=没有可靠音频证据。 */
  status: SummaryAudioStatus;
  summary: string;
  music: string | null;
  soundscape: string | null;
  temporalChanges: SummaryAudioChange[];
  uncertainty?: string;
}

export interface VideoSummary {
  title: string;
  overview: string;
  keyPoints: SummaryPoint[];
  chapters: SummaryChapter[];
  /** Kept for older saved summaries; new UI no longer presents this separately. */
  takeaway?: string;
  /**
   * 新生成的总结会包含独立声音分析；保持可选以兼容旧的已保存总结。
   */
  audioAnalysis?: SummaryAudioAnalysis;
  /**
   * 给后续问答使用的事实索引。界面可以不展示，但服务端会用它减少
   * 再次发送整段视频的次数。
   */
  evidence?: SummaryEvidence[];
}

export interface VideoModelContext {
  /** Qwen 可读取的公网 HTTPS 视频地址或受支持的 data URL。 */
  videoUrl?: string;
  /**
   * 本地媒体分析任务。模型路由会从受信任的媒体服务读取低清成品并上传到
   * DashScope 临时存储；浏览器不会接触 API Key，也不用转发大文件。
   */
  mediaJobId?: string;
  /** 已按时间顺序抽取的关键帧 URL；适用于已有媒体处理流水线的场景。 */
  frameUrls?: string[];
  /** 与 frameUrls 一一对应的原视频时间（秒）。 */
  frameTimestamps?: number[];
  /** Qwen 可读取的公网音频地址或受支持的 Base64 data URL。 */
  audioUrl?: string;
  /** audioUrl 对应的容器格式。 */
  audioFormat?: "mp3" | "wav" | "aac" | "m4a" | "ogg" | "webm";
  /** 已有的字幕或 ASR 文本。它会与视频/关键帧证据一起使用。 */
  transcript?: string;
  /** 视频抽帧频率。长视频建议使用较低值。 */
  fps?: number;
  /** 原视频实际时长，用于约束并校正模型返回的时间点。 */
  durationSeconds?: number;
}

export interface VideoConversationMessage {
  role: "assistant" | "user";
  content: string;
}

export interface VideoEngine {
  analyze(
    source: VideoSourceDescriptor,
    context?: VideoModelContext,
  ): Promise<VideoSummary>;
}

export function extractBvid(value: string): string | null {
  const match = value.trim().match(/BV[0-9A-Za-z]{10}/i);
  return match ? `BV${match[0].slice(2)}` : null;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(totalSeconds: number) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "时长未知";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  return [hours, minutes, seconds]
    .filter((_, index) => hours > 0 || index > 0)
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}
