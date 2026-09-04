import { safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ModelCredentialStatus,
  ModelCredentialUpdate,
} from "../../shared/credential-types";

type CredentialName = keyof ModelCredentialUpdate;

const ENVIRONMENT_KEYS: Record<CredentialName, string> = {
  dashscopeApiKey: "DASHSCOPE_API_KEY",
  deepseekApiKey: "DEEPSEEK_API_KEY",
  serpApiKey: "SERPAPI_API_KEY",
};

interface CredentialFile {
  version: 1;
  encrypted: Partial<Record<CredentialName, string>>;
}

export class CredentialStore {
  private encrypted: CredentialFile["encrypted"] = {};

  constructor(private readonly filePath: string) {}

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as CredentialFile;
      if (parsed.version !== 1 || !parsed.encrypted || typeof parsed.encrypted !== "object") {
        throw new Error("Unsupported credential file format.");
      }
      this.encrypted = parsed.encrypted;
      for (const name of Object.keys(ENVIRONMENT_KEYS) as CredentialName[]) {
        const encoded = this.encrypted[name];
        if (!encoded) continue;
        const value = safeStorage.decryptString(Buffer.from(encoded, "base64"));
        if (value) process.env[ENVIRONMENT_KEYS[name]] = value;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("Unable to load encrypted API credentials.", error);
      }
    }
  }

  getStatus(): ModelCredentialStatus {
    return {
      dashscopeConfigured: Boolean(process.env.DASHSCOPE_API_KEY?.trim()),
      deepseekConfigured: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
      serpApiConfigured: Boolean(process.env.SERPAPI_API_KEY?.trim()),
    };
  }

  async update(update: ModelCredentialUpdate): Promise<ModelCredentialStatus> {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new TypeError("API credential update must be an object.");
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Windows credential encryption is currently unavailable.");
    }

    for (const name of Object.keys(ENVIRONMENT_KEYS) as CredentialName[]) {
      const value = update[name];
      if (value === undefined) continue;
      const environmentKey = ENVIRONMENT_KEYS[name];
      if (value === null || value.trim() === "") {
        delete this.encrypted[name];
        delete process.env[environmentKey];
        continue;
      }
      const normalized = value.trim();
      if (normalized.length > 4_096 || /[\r\n]/.test(normalized)) {
        throw new TypeError("API Key 格式无效。");
      }
      this.encrypted[name] = safeStorage.encryptString(normalized).toString("base64");
      process.env[environmentKey] = normalized;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(
      temporaryPath,
      JSON.stringify({ version: 1, encrypted: this.encrypted } satisfies CredentialFile),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, this.filePath);
    return this.getStatus();
  }
}
