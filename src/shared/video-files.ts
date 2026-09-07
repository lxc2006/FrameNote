export interface LocalVideoFile {
  path: string;
  name: string;
  size: number;
  lastModified: number;
  playbackUrl: string;
}

export type VideoDownloadInput =
  | { kind: "local"; path: string }
  | { kind: "bilibili"; bvid: string; title: string }
  | { kind: "remote"; url: string; title: string };

export interface VideoDownloadResult {
  cancelled: boolean;
  path?: string;
}
