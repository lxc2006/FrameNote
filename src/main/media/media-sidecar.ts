import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 8788;
const STARTUP_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 5_000;
const MAX_RESTARTS = 3;

export interface MediaSidecarConnection {
  baseUrl: string;
  authorizationToken: string;
  capabilities: {
    transcription: boolean;
  };
}

interface MediaSidecarHealth {
  status: "ok" | "degraded";
  service: string;
  capabilities?: {
    transcription?: boolean;
  };
}

interface SidecarLaunch {
  command: string;
  args: string[];
  cwd: string;
  description: string;
}

interface MediaSidecarOptions {
  isPackaged: boolean;
  resourcesPath: string;
  userDataPath: string;
  projectRoot?: string;
}

export class MediaSidecarManager {
  baseUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
  readonly authorizationToken: string;
  private readonly options: MediaSidecarOptions;
  private child: ChildProcess | undefined;
  private launch: SidecarLaunch | undefined;
  private capabilities = { transcription: false };
  private ready = false;
  private stopping = false;
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;
  private consecutiveHealthFailures = 0;
  private port = DEFAULT_PORT;
  private transcriptionExecutable: string | undefined;

  constructor(options: MediaSidecarOptions) {
    this.options = options;
    this.authorizationToken =
      process.env.BILIBILI_MEDIA_SERVICE_TOKEN?.trim() ||
      randomBytes(32).toString("base64url");
  }

  async start() {
    this.stopping = false;
    this.launch = this.resolveLaunch();
    this.configureDesktopEnvironment();

    const existingHealth = await this.readHealth();
    if (existingHealth && (await this.canUseExistingService())) {
      this.configureDesktopEnvironment();
      this.acceptHealth(existingHealth);
      this.startMonitoring();
      console.info("Using an existing FrameNote media core sidecar.");
      return;
    }

    this.port = await selectLoopbackPort(DEFAULT_PORT);
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.configureDesktopEnvironment();
    await this.launchOwnedProcess();
  }

  getConnection(): MediaSidecarConnection {
    if (!this.ready) {
      throw new Error("媒体核心 sidecar 尚未就绪，请稍后重试。");
    }
    return {
      baseUrl: this.baseUrl,
      authorizationToken: this.authorizationToken,
      capabilities: { ...this.capabilities },
    };
  }

  async stop() {
    this.stopping = true;
    this.ready = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.restartTimer = undefined;
    this.healthTimer = undefined;
    const child = this.child;
    this.child = undefined;
    if (child?.pid) await terminateProcessTree(child);
  }

  setTranscriptionExecutable(executable: string | undefined) {
    this.transcriptionExecutable = executable;
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  private resolveLaunch(): SidecarLaunch {
    const projectRoot = resolve(this.options.projectRoot ?? process.cwd());
    const override = process.env.FRAMENOTE_MEDIA_CORE_EXECUTABLE?.trim();
    const executableCandidates = [
      override,
      ...(this.options.isPackaged
        ? [
            join(
              this.options.resourcesPath,
              "media-sidecar",
              "framenote-media-core.exe",
            ),
            join(
              this.options.resourcesPath,
              "media-sidecar",
              "framenote-media-core",
              "framenote-media-core.exe",
            ),
          ]
        : [
            join(
              projectRoot,
              "media_service",
              "dist",
              "framenote-media-core",
              "framenote-media-core.exe",
            ),
          ]),
    ].filter((candidate): candidate is string => Boolean(candidate));

    const executable = executableCandidates.find((candidate) =>
      existsSync(candidate),
    );
    if (executable) {
      return {
        command: executable,
        args: [],
        cwd: dirname(resolve(executable)),
        description: "framenote-media-core.exe",
      };
    }

    if (this.options.isPackaged) {
      throw new Error("安装目录中缺少 framenote-media-core.exe。");
    }

    const script = join(projectRoot, "media_service", "app.py");
    const projectPython = join(projectRoot, ".venv", "Scripts", "python.exe");
    return {
      command:
        process.env.FRAMENOTE_MEDIA_PYTHON?.trim() ||
        (existsSync(projectPython) ? projectPython : "python"),
      args: [script],
      cwd: projectRoot,
      description: "media_service/app.py",
    };
  }

  private configureDesktopEnvironment() {
    process.env.BILIBILI_MEDIA_SERVICE_URL = this.baseUrl;
    process.env.BILIBILI_MEDIA_SERVICE_TOKEN = this.authorizationToken;
  }

  private async launchOwnedProcess() {
    if (!this.launch) throw new Error("媒体核心启动配置不存在。");
    const signingSecret = randomBytes(32).toString("base64url");
    const environment = {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      FRAMENOTE_MEDIA_API_TOKEN: this.authorizationToken,
      FRAMENOTE_MEDIA_ALLOW_TOKENLESS_LOOPBACK: "false",
      FRAMENOTE_MEDIA_CORS_ORIGINS:
        "http://localhost:5173,http://127.0.0.1:5173,null",
      FRAMENOTE_MEDIA_PORT: String(this.port),
      FRAMENOTE_MEDIA_PUBLIC_BASE_URL: this.baseUrl,
      FRAMENOTE_MEDIA_SIGNING_SECRET: signingSecret,
      FRAMENOTE_MEDIA_STATE_DIR: join(
        this.options.userDataPath,
        "media-sidecar",
      ),
      FRAMENOTE_TRANSCRIPTION_BACKEND: "",
      FRAMENOTE_TRANSCRIPTION_EXECUTABLE:
        this.transcriptionExecutable ?? "",
    };
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.info(`[media-core] ${message}`);
    });
    child.stderr?.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.warn(`[media-core] ${message}`);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.ready = false;
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.healthTimer = undefined;
      if (this.stopping) return;
      console.error(
        `Media core sidecar exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`,
      );
      this.scheduleRestart();
    });

    const health = await this.waitForHealth(child);
    this.restartAttempts = 0;
    this.acceptHealth(health);
    this.startMonitoring();
    console.info(`FrameNote media core ready via ${this.launch.description}.`);
  }

  private scheduleRestart() {
    if (this.stopping || this.restartTimer) return;
    if (this.restartAttempts >= MAX_RESTARTS) {
      console.error("Media core sidecar restart limit reached.");
      return;
    }
    this.restartAttempts += 1;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.launchOwnedProcess().catch((error) => {
        console.error("Media core sidecar restart failed.", error);
        this.scheduleRestart();
      });
    }, this.restartAttempts * 1_000);
  }

  private startMonitoring() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(() => {
      void this.readHealth().then((health) => {
        if (health) {
          this.consecutiveHealthFailures = 0;
          this.acceptHealth(health);
          return;
        }
        this.consecutiveHealthFailures += 1;
        if (this.consecutiveHealthFailures >= 3) {
          this.ready = false;
          console.error("Media core sidecar health check failed three times.");
        }
      });
    }, HEALTH_INTERVAL_MS);
  }

  private acceptHealth(health: MediaSidecarHealth) {
    this.ready = health.status === "ok";
    this.capabilities = {
      transcription: health.capabilities?.transcription === true,
    };
  }

  private async waitForHealth(child: ChildProcess) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error("媒体核心 sidecar 在启动完成前退出。");
      }
      const health = await this.readHealth();
      if (health) return health;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    await terminateProcessTree(child);
    throw new Error("媒体核心 sidecar 启动超时。");
  }

  private async readHealth(): Promise<MediaSidecarHealth | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return null;
      const value = (await response.json()) as Partial<MediaSidecarHealth>;
      if (
        value.status !== "ok" ||
        value.service !== "framenote-media-core"
      ) {
        return null;
      }
      return value as MediaSidecarHealth;
    } catch {
      return null;
    }
  }

  private async canUseExistingService() {
    try {
      const response = await fetch(`${this.baseUrl}/v1/bilibili/jobs?limit=1`, {
        headers: { authorization: `Bearer ${this.authorizationToken}` },
        signal: AbortSignal.timeout(1_500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

async function selectLoopbackPort(preferredPort: number) {
  try {
    return await reserveLoopbackPort(preferredPort);
  } catch {
    return reserveLoopbackPort(0);
  }
}

function reserveLoopbackPort(port: number) {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const selectedPort =
        typeof address === "object" && address ? address.port : port;
      server.close((error) =>
        error ? reject(error) : resolvePromise(selectedPort),
      );
    });
  });
}

async function terminateProcessTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
      );
      return;
    } catch {
      // Fall back to Node's exact child handle if taskkill races with exit.
    }
  }
  child.kill("SIGTERM");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
  if (child.exitCode === null) child.kill("SIGKILL");
}
