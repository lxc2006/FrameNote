export type SourceKind = "upload" | "bilibili" | "url";

export interface VideoSourceDescriptor {
  kind: SourceKind;
  title: string;
  subtitle: string;
  durationLabel?: string;
  bvid?: string;
  sourceUrl?: string;
  downloadFirst: boolean;
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
  speech: string | null;
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
}

export interface VideoConversationMessage {
  role: "assistant" | "user";
  content: string;
}

export interface VideoEngine {
  readonly mode: "demo" | "remote";
  analyze(
    source: VideoSourceDescriptor,
    context?: VideoModelContext,
  ): Promise<VideoSummary>;
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));

function createDemoSummary(source: VideoSourceDescriptor): VideoSummary {
  const origin =
    source.kind === "bilibili"
      ? `${source.bvid ?? "该 BV 号"} 对应的 B 站视频`
      : source.kind === "url"
        ? `视频直链《${source.title}》`
      : `本地视频《${source.title}》`;

  return {
    title: source.title,
    overview: `这是一份用于验证产品流程的演示总结。当前尚未连接真实的转写与多模态模型，因此系统没有读取 ${origin} 的实际语义；接入视频理解服务后，这里会替换为视频主旨、论证路径与结论的真实概览。`,
    keyPoints: [
      {
        title: "先识别视频上下文",
        detail:
          "提取标题、时长、画面变化和音轨信息，建立后续转写与视觉理解所需的素材索引。",
      },
      {
        title: "把长视频拆成可追踪片段",
        detail:
          "依据语义转折与场景变化切分章节，让每条总结都能回到对应时间点进行核对。",
      },
      {
        title: "合并语音与画面证据",
        detail:
          "将字幕、语音识别结果和关键帧描述统一交给模型，减少只听音频造成的信息遗漏。",
      },
      {
        title: "输出结构化结论",
        detail:
          "生成概览、关键观点、章节和行动项，同时保留会话上下文供用户继续追问。",
      },
      {
        title: "模型与部署保持可替换",
        detail:
          "页面只依赖统一的视频分析接口，后续可切换云端 API、自托管模型或混合处理方案。",
      },
    ],
    chapters: [
      {
        time: "00:00",
        title: "引入与问题定义",
        description: "识别视频主题、目标受众和创作者希望解决的问题。",
      },
      {
        time: "02:18",
        title: "核心内容展开",
        description: "聚合主要论点、示例以及画面中出现的补充信息。",
      },
      {
        time: "06:42",
        title: "关键转折与验证",
        description: "定位观点变化、反例、数据或演示结果。",
      },
      {
        time: "10:05",
        title: "结论与下一步",
        description: "提炼最终结论、适用条件和可执行建议。",
      },
    ],
    takeaway:
      "首版产品的核心是让“素材获取—内容理解—总结—追问”形成一条可观察、可恢复的链路；模型选择只影响适配器，不影响用户工作流。",
  };
}

export const demoVideoEngine: VideoEngine = {
  mode: "demo",
  async analyze(source) {
    await wait(260);
    return createDemoSummary(source);
  },
};

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
