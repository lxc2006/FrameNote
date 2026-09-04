import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { SubtitleExtensionStatus } from "../../shared/ipc-contract";

const execFileAsync = promisify(execFile);
const EXTENSION_ID = "framenote-subtitles";
const DESCRIPTOR_NAME = "extension.json";
const ACTIVE_STATE_NAME = "active.json";
const DEFAULT_MANIFEST_URL =
  "https://github.com/lxc2006/FrameNote/releases/latest/download/framenote-subtitles-manifest.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ARCHIVE_BYTES = 5 * 1024 * 1024 * 1024;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface RemoteManifest {
  schemaVersion: 1;
  id: typeof EXTENSION_ID;
  version: string;
  minimumAppVersion: string;
  archiveUrl: string;
  sha256: string;
  downloadBytes: number;
  unpackedBytes: number;
}

interface InstalledDescriptor {
  schemaVersion: 1;
  id: typeof EXTENSION_ID;
  version: string;
  executable: "framenote-subtitles.exe";
  models: string[];
}

interface ActiveState {
  version: string;
}

interface SubtitleExtensionOptions {
  root: string;
  appVersion: string;
  manifestUrl?: string;
}

export class SubtitleExtensionManager {
  private readonly root: string;
  private readonly appVersion: string;
  private readonly manifestUrl: string;
  private status: SubtitleExtensionStatus = { state: "not-installed" };
  private executable: string | undefined;
  private operation: Promise<SubtitleExtensionStatus> | undefined;

  constructor(options: SubtitleExtensionOptions) {
    this.root = resolve(options.root);
    this.appVersion = options.appVersion;
    this.manifestUrl =
      options.manifestUrl?.trim() ||
      process.env.FRAMENOTE_SUBTITLE_EXTENSION_MANIFEST_URL?.trim() ||
      DEFAULT_MANIFEST_URL;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    await this.removeInterruptedOperations();
    const installed = await this.readInstalled();
    this.executable = installed?.executable;
    this.status = installed
      ? { state: "installed", installedVersion: installed.version }
      : { state: "not-installed" };
    return this.getStatus();
  }

  getStatus(): SubtitleExtensionStatus {
    return { ...this.status };
  }

  getExecutable() {
    return this.executable;
  }

  async checkForUpdates(): Promise<SubtitleExtensionStatus> {
    if (this.operation) return this.operation;
    const manifest = await this.readRemoteManifest();
    const installed = await this.readInstalled();
    this.executable = installed?.executable;
    this.status = installed
      ? {
          state:
            compareVersions(manifest.version, installed.version) > 0
              ? "update-available"
              : "installed",
          installedVersion: installed.version,
          availableVersion: manifest.version,
          expectedDownloadBytes: manifest.downloadBytes,
        }
      : {
          state: "not-installed",
          availableVersion: manifest.version,
          expectedDownloadBytes: manifest.downloadBytes,
        };
    return this.getStatus();
  }

  install(
    onStatus: (status: SubtitleExtensionStatus) => void = () => undefined,
  ) {
    if (this.operation) return this.operation;
    this.operation = this.performInstall(onStatus).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  uninstall(
    onStatus: (status: SubtitleExtensionStatus) => void = () => undefined,
  ) {
    if (this.operation) return this.operation;
    this.operation = this.performUninstall(onStatus).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async performInstall(
    onStatus: (status: SubtitleExtensionStatus) => void,
  ) {
    const manifest = await this.readRemoteManifest();
    if (compareVersions(this.appVersion, manifest.minimumAppVersion) < 0) {
      throw new Error(
        `字幕扩展 ${manifest.version} 要求 FrameNote ${manifest.minimumAppVersion} 或更高版本。`,
      );
    }
    await mkdir(this.root, { recursive: true });
    const archivePath = join(this.root, `.download-${randomUUID()}.zip`);
    const stagingPath = join(this.root, `.staging-${randomUUID()}`);
    const notify = (status: SubtitleExtensionStatus) => {
      this.status = status;
      onStatus(this.getStatus());
    };
    notify({
      state: "installing",
      installedVersion: (await this.readInstalled())?.version,
      availableVersion: manifest.version,
      progress: 0,
      expectedDownloadBytes: manifest.downloadBytes,
    });

    try {
      await this.requireFreeSpace(
        manifest.downloadBytes + manifest.unpackedBytes + 1024 * 1024 * 1024,
      );
      let lastProgressBytes = 0;
      await this.downloadArchive(manifest, archivePath, (received) => {
        if (
          received !== manifest.downloadBytes &&
          received - lastProgressBytes < 8 * 1024 * 1024
        ) {
          return;
        }
        lastProgressBytes = received;
        notify({
          state: "installing",
          installedVersion: this.status.installedVersion,
          availableVersion: manifest.version,
          progress: Math.min(0.92, (received / manifest.downloadBytes) * 0.92),
          downloadedBytes: received,
          expectedDownloadBytes: manifest.downloadBytes,
        });
      });
      await validateArchiveEntries(archivePath);
      await mkdir(stagingPath, { recursive: true });
      await execFileAsync("tar.exe", ["-xf", archivePath, "-C", stagingPath], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      const descriptor = await readDescriptor(stagingPath);
      if (descriptor.version !== manifest.version) {
        throw new Error("字幕扩展包版本与远程清单不一致。 ");
      }
      await verifyExtractedPackage(stagingPath, descriptor);
      const destination = this.versionDirectory(descriptor.version);
      await rm(destination, { recursive: true, force: true });
      await rename(stagingPath, destination);
      await this.writeActive({ version: descriptor.version });
      const installed = await this.readInstalled();
      if (!installed) throw new Error("字幕扩展安装后校验失败。 ");
      this.executable = installed.executable;
      notify({
        state: "installed",
        installedVersion: installed.version,
        availableVersion: manifest.version,
        progress: 1,
      });
      await this.removeInactiveVersions(installed.version);
      return this.getStatus();
    } catch (error) {
      notify({
        state: "error",
        installedVersion: (await this.readInstalled())?.version,
        availableVersion: manifest.version,
        message: error instanceof Error ? error.message : "字幕扩展安装失败。",
      });
      throw error;
    } finally {
      await rm(archivePath, { force: true });
      await rm(stagingPath, { recursive: true, force: true });
    }
  }

  private async performUninstall(
    onStatus: (status: SubtitleExtensionStatus) => void,
  ) {
    this.status = {
      state: "uninstalling",
      installedVersion: (await this.readInstalled())?.version,
    };
    onStatus(this.getStatus());
    await rm(this.root, { recursive: true, force: true });
    await mkdir(this.root, { recursive: true });
    this.executable = undefined;
    this.status = { state: "not-installed" };
    onStatus(this.getStatus());
    return this.getStatus();
  }

  private async downloadArchive(
    manifest: RemoteManifest,
    destination: string,
    onProgress: (received: number) => void,
  ) {
    const response = await fetch(manifest.archiveUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`字幕扩展下载失败（HTTP ${response.status}）。`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isSafeInteger(declaredLength) &&
      declaredLength > 0 &&
      declaredLength !== manifest.downloadBytes
    ) {
      throw new Error("字幕扩展下载大小与清单不一致。 ");
    }

    const handle = await open(destination, "wx");
    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > manifest.downloadBytes || received > MAX_ARCHIVE_BYTES) {
          throw new Error("字幕扩展下载超过清单大小。 ");
        }
        hash.update(value);
        await handle.write(value);
        onProgress(received);
      }
    } finally {
      await handle.close();
      reader.releaseLock();
    }
    if (received !== manifest.downloadBytes) {
      throw new Error("字幕扩展下载不完整。 ");
    }
    if (hash.digest("hex") !== manifest.sha256) {
      throw new Error("字幕扩展 SHA-256 校验失败。 ");
    }
  }

  private async readRemoteManifest(): Promise<RemoteManifest> {
    const manifestUrl = requireHttpsUrl(this.manifestUrl, "字幕扩展清单");
    const response = await fetch(manifestUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`无法获取字幕扩展清单（HTTP ${response.status}）。`);
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
      throw new Error("字幕扩展清单过大。 ");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error("字幕扩展清单过大。 ");
    }
    return parseRemoteManifest(JSON.parse(raw));
  }

  private async readInstalled() {
    try {
      const state = JSON.parse(
        await readFile(join(this.root, ACTIVE_STATE_NAME), "utf8"),
      ) as Partial<ActiveState>;
      if (typeof state.version !== "string" || !VERSION_PATTERN.test(state.version)) {
        return null;
      }
      const packageRoot = this.versionDirectory(state.version);
      const descriptor = await readDescriptor(packageRoot);
      if (descriptor.version !== state.version) return null;
      const executable = safeChildPath(packageRoot, descriptor.executable);
      const executableStats = await stat(executable);
      if (!executableStats.isFile()) return null;
      for (const model of ["fun-asr-nano", "fsmn-vad", "ct-punc"]) {
        const modelStats = await stat(
          safeChildPath(join(packageRoot, "models"), model),
        );
        if (!modelStats.isDirectory()) return null;
      }
      return { version: descriptor.version, executable };
    } catch {
      return null;
    }
  }

  private async writeActive(state: ActiveState) {
    const target = join(this.root, ACTIVE_STATE_NAME);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", flag: "wx" });
    await rm(target, { force: true });
    await rename(temporary, target);
  }

  private versionDirectory(version: string) {
    if (!VERSION_PATTERN.test(version)) throw new Error("字幕扩展版本无效。 ");
    return safeChildPath(this.root, version);
  }

  private async removeInactiveVersions(activeVersion: string) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.root, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            VERSION_PATTERN.test(entry.name) &&
            entry.name !== activeVersion,
        )
        .map((entry) =>
          rm(this.versionDirectory(entry.name), { recursive: true, force: true }).catch(
            () => undefined,
          ),
        ),
    );
  }

  private async removeInterruptedOperations() {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(this.root, { withFileTypes: true });
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.name.startsWith(".download-") ||
            entry.name.startsWith(".staging-"),
        )
        .map((entry) =>
          rm(join(this.root, entry.name), {
            recursive: entry.isDirectory(),
            force: true,
          }),
        ),
    );
  }

  private async requireFreeSpace(requiredBytes: number) {
    const disk = await statfs(this.root);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
      throw new Error(
        `字幕扩展至少需要 ${formatGigabytes(requiredBytes)} GB 可用空间。`,
      );
    }
  }
}

function parseRemoteManifest(value: unknown): RemoteManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("字幕扩展清单格式无效。 ");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.id !== EXTENSION_ID ||
    typeof record.version !== "string" ||
    !VERSION_PATTERN.test(record.version) ||
    typeof record.minimumAppVersion !== "string" ||
    !VERSION_PATTERN.test(record.minimumAppVersion) ||
    typeof record.archiveUrl !== "string" ||
    typeof record.sha256 !== "string" ||
    !SHA256_PATTERN.test(record.sha256) ||
    typeof record.downloadBytes !== "number" ||
    !Number.isSafeInteger(record.downloadBytes) ||
    record.downloadBytes <= 0 ||
    record.downloadBytes > MAX_ARCHIVE_BYTES ||
    typeof record.unpackedBytes !== "number" ||
    !Number.isSafeInteger(record.unpackedBytes) ||
    record.unpackedBytes <= 0
  ) {
    throw new Error("字幕扩展清单字段无效。 ");
  }
  return {
    schemaVersion: 1,
    id: EXTENSION_ID,
    version: record.version,
    minimumAppVersion: record.minimumAppVersion,
    archiveUrl: requireHttpsUrl(record.archiveUrl, "字幕扩展压缩包"),
    sha256: record.sha256,
    downloadBytes: record.downloadBytes,
    unpackedBytes: record.unpackedBytes,
  };
}

async function readDescriptor(packageRoot: string): Promise<InstalledDescriptor> {
  const raw = JSON.parse(
    await readFile(join(packageRoot, DESCRIPTOR_NAME), "utf8"),
  ) as Partial<InstalledDescriptor>;
  if (
    raw.schemaVersion !== 1 ||
    raw.id !== EXTENSION_ID ||
    typeof raw.version !== "string" ||
    !VERSION_PATTERN.test(raw.version) ||
    raw.executable !== "framenote-subtitles.exe" ||
    !Array.isArray(raw.models) ||
    !["fun-asr-nano", "fsmn-vad", "ct-punc"].every((model) =>
      raw.models?.includes(model),
    )
  ) {
    throw new Error("字幕扩展包描述文件无效。 ");
  }
  return raw as InstalledDescriptor;
}

async function verifyExtractedPackage(
  packageRoot: string,
  descriptor: InstalledDescriptor,
) {
  for (const model of ["fun-asr-nano", "fsmn-vad", "ct-punc"]) {
    const modelStats = await stat(safeChildPath(join(packageRoot, "models"), model));
    if (!modelStats.isDirectory()) {
      throw new Error(`字幕扩展模型目录无效：${model}`);
    }
  }
  const executable = safeChildPath(packageRoot, descriptor.executable);
  const { stdout } = await execFileAsync(executable, ["--health"], {
    cwd: packageRoot,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const health = JSON.parse(stdout) as Record<string, unknown>;
  if (
    health.status !== "ok" ||
    health.service !== "framenote-subtitles" ||
    health.version !== descriptor.version
  ) {
    throw new Error("字幕扩展健康检查失败。 ");
  }
}

async function validateArchiveEntries(archivePath: string) {
  const { stdout } = await execFileAsync("tar.exe", ["-tf", archivePath], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  if (!entries.length || entries.length > 100_000) {
    throw new Error("字幕扩展压缩包目录无效。 ");
  }
  for (const rawEntry of entries) {
    const entry = rawEntry.replaceAll("\\", "/").replace(/^\.\//, "");
    if (
      !entry ||
      entry.startsWith("/") ||
      entry.includes(":") ||
      entry.split("/").includes("..") ||
      entry.length > 500
    ) {
      throw new Error("字幕扩展压缩包包含不安全路径。 ");
    }
  }
}

function safeChildPath(root: string, child: string) {
  if (!child || basename(child) !== child) {
    throw new Error("字幕扩展路径无效。 ");
  }
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, child);
  if (dirname(candidate) !== resolvedRoot || relative(resolvedRoot, candidate).startsWith("..")) {
    throw new Error("字幕扩展路径越界。 ");
  }
  return candidate;
}

function requireHttpsUrl(value: string, label: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    return url.toString();
  } catch {
    throw new Error(`${label}必须使用不含账号信息的 HTTPS 地址。`);
  }
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split("-")[0].split(".").map(Number);
  const rightParts = right.split("-")[0].split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return left.localeCompare(right);
}

function formatGigabytes(bytes: number) {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}
