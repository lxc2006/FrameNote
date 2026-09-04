import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  MAX_FONT_SIZE,
  MAX_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
  MIN_FONT_SIZE,
  normalizeDirectSummarySeconds,
  normalizeFontSize,
  parseUserPreferences,
  USER_PREFERENCES_CHANGE_EVENT,
  USER_PREFERENCES_STORAGE_KEY,
  type FontPreference,
  type ThemePreference,
  type UserPreferences,
} from "@/shared/preference-types";
import {
  desktopBridge,
  unwrapDesktopResult,
} from "../clients/desktop-bridge";
import type { SubtitleExtensionStatus } from "@/shared/ipc-contract";
import type {
  ModelCredentialStatus,
  ModelCredentialUpdate,
} from "@/shared/credential-types";

export {
  DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
  parseUserPreferences,
  USER_PREFERENCES_CHANGE_EVENT,
  USER_PREFERENCES_STORAGE_KEY,
} from "@/shared/preference-types";

const FONT_STACKS: Record<FontPreference, string> = {
  system: 'Inter, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  "microsoft-yahei":
    '"Microsoft YaHei", "Microsoft YaHei UI", "Segoe UI", sans-serif',
  youyuan: 'YouYuan, "幼圆", "Microsoft YaHei", "Segoe UI", sans-serif',
  kaiti: 'KaiTi, "楷体", STKaiti, "Microsoft YaHei", Georgia, serif',
  "source-han-sans":
    '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", "Segoe UI", sans-serif',
  songti: 'SimSun, "宋体", "Songti SC", STSong, Georgia, serif',
  humanist:
    '"Trebuchet MS", "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  serif:
    'Georgia, "Times New Roman", SimSun, "宋体", "Songti SC", serif',
  consolas:
    'Consolas, "Cascadia Mono", "Microsoft YaHei", "PingFang SC", monospace',
};

function readPreferenceStorage() {
  try {
    return window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function getServerPreferenceStorage() {
  return "";
}

function subscribeToPreferenceStorage(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === USER_PREFERENCES_STORAGE_KEY || event.key === null) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(USER_PREFERENCES_CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(USER_PREFERENCES_CHANGE_EVENT, onStoreChange);
  };
}

function applyPreferences(preferences: UserPreferences) {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.style.setProperty("--ui-font", FONT_STACKS[preferences.uiFont]);
  root.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
  root.style.setProperty("--text-font", FONT_STACKS[preferences.textFont]);
  root.style.setProperty("--text-font-size", `${preferences.textFontSize}px`);
  root.style.setProperty(
    "--content-font-adjust",
    `${preferences.textFontSize - 12}px`,
  );
}

function writePreferenceStorage(preferences: UserPreferences) {
  try {
    window.localStorage.setItem(
      USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences),
    );
    window.dispatchEvent(new Event(USER_PREFERENCES_CHANGE_EVENT));
  } catch {
    // Browsers can disable local storage. Applied settings still work this visit.
  }
}

function savePreferences(preferences: UserPreferences) {
  writePreferenceStorage(preferences);
  const desktopSettings = desktopBridge()?.settings;
  if (desktopSettings) {
    void desktopSettings
      .setUserPreferences(preferences)
      .then(unwrapDesktopResult)
      .catch((error: unknown) => {
        console.error("Unable to persist desktop preferences", error);
      });
  }
}

interface TypographyFieldsProps {
  legend: string;
  description: string;
  font: FontPreference;
  fontSize: number;
  onFontChange: (value: FontPreference) => void;
  onFontSizeChange: (value: number) => void;
}

function TypographyFields({
  legend,
  description,
  font,
  fontSize,
  onFontChange,
  onFontSizeChange,
}: TypographyFieldsProps) {
  const commitFontSize = (rawValue: number) => {
    onFontSizeChange(normalizeFontSize(rawValue, fontSize));
  };

  return (
    <fieldset className="settings-group">
      <legend>{legend}</legend>
      <p>{description}</p>

      <label className="settings-field">
        <span>字体</span>
        <select
          value={font}
          onChange={(event) =>
            onFontChange(event.target.value as FontPreference)
          }
        >
          <option value="system">系统默认</option>
          <option value="microsoft-yahei">微软雅黑</option>
          <option value="youyuan">幼圆</option>
          <option value="kaiti">楷体</option>
          <option value="source-han-sans">思源黑体</option>
          <option value="songti">宋体</option>
          <option value="humanist">Humanist</option>
          <option value="serif">Georgia</option>
          <option value="consolas">Consolas</option>
        </select>
      </label>

      <label className="settings-field">
        <span>字号</span>
        <span className="settings-number-input">
          <input
            type="number"
            inputMode="numeric"
            min={MIN_FONT_SIZE}
            max={MAX_FONT_SIZE}
            step={1}
            value={fontSize}
            aria-label={`${legend}字号，单位像素`}
            onChange={(event) => {
              if (
                Number.isFinite(event.target.valueAsNumber) &&
                event.target.valueAsNumber >= MIN_FONT_SIZE &&
                event.target.valueAsNumber <= MAX_FONT_SIZE
              ) {
                commitFontSize(event.target.valueAsNumber);
              }
            }}
            onBlur={(event) => {
              if (!Number.isFinite(event.target.valueAsNumber)) {
                event.currentTarget.value = String(fontSize);
                return;
              }
              commitFontSize(event.target.valueAsNumber);
            }}
          />
          <b aria-hidden="true">px</b>
        </span>
      </label>
      <span className="settings-size-range">可输入 {MIN_FONT_SIZE}–{MAX_FONT_SIZE}px</span>
    </fieldset>
  );
}

export default function UserSettingsMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const [subtitleStatus, setSubtitleStatus] =
    useState<SubtitleExtensionStatus | null>(null);
  const [subtitleBusy, setSubtitleBusy] = useState(false);
  const [credentialStatus, setCredentialStatus] =
    useState<ModelCredentialStatus | null>(null);
  const [credentialValues, setCredentialValues] = useState({
    dashscopeApiKey: "",
    deepseekApiKey: "",
    serpApiKey: "",
  });
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialMessage, setCredentialMessage] = useState("");
  const storedPreferences = useSyncExternalStore(
    subscribeToPreferenceStorage,
    readPreferenceStorage,
    getServerPreferenceStorage,
  );
  const preferences = useMemo(
    () => parseUserPreferences(storedPreferences),
    [storedPreferences],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const firstControlRef = useRef<HTMLSelectElement>(null);
  const dialogId = useId();
  const titleId = useId();
  const isDesktop = Boolean(desktopBridge());

  useEffect(() => {
    const desktopSettings = desktopBridge()?.settings;
    if (!desktopSettings) return;

    let cancelled = false;
    void desktopSettings
      .getUserPreferences()
      .then(unwrapDesktopResult)
      .then(async (savedPreferences) => {
        if (cancelled) return;
        if (savedPreferences) {
          applyPreferences(savedPreferences);
          writePreferenceStorage(savedPreferences);
          return;
        }

        const currentPreferences = parseUserPreferences(
          readPreferenceStorage(),
        );
        await desktopSettings
          .setUserPreferences(currentPreferences)
          .then(unwrapDesktopResult);
      })
      .catch((error: unknown) => {
        console.error("Unable to load desktop preferences", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const subtitles = desktopBridge()?.subtitles;
    if (!subtitles) return;
    let cancelled = false;
    const receiveStatus = (status: SubtitleExtensionStatus) => {
      if (!cancelled) setSubtitleStatus(status);
    };
    subtitles.subscribe(receiveStatus);
    void subtitles
      .getStatus()
      .then(unwrapDesktopResult)
      .then(receiveStatus)
      .catch((error: unknown) => {
        console.error("Unable to read subtitle extension status", error);
      });
    return () => {
      cancelled = true;
      subtitles.unsubscribe(receiveStatus);
    };
  }, []);

  useEffect(() => {
    const credentials = desktopBridge()?.credentials;
    if (!credentials) return;
    let cancelled = false;
    void credentials
      .getStatus()
      .then(unwrapDesktopResult)
      .then((status) => {
        if (!cancelled) setCredentialStatus(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCredentialMessage(
            error instanceof Error ? error.message : "无法读取 API Key 状态。",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !containerRef.current?.contains(event.target)
      ) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    const focusTimer = window.setTimeout(
      () => firstControlRef.current?.focus(),
      0,
    );

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.clearTimeout(focusTimer);
    };
  }, [isOpen]);

  const updatePreference = <Key extends keyof UserPreferences>(
    key: Key,
    value: UserPreferences[Key],
  ) => {
    const next = { ...preferences, [key]: value };
    applyPreferences(next);
    savePreferences(next);
  };

  const runSubtitleAction = async (
    action: "check" | "install" | "uninstall",
  ) => {
    const subtitles = desktopBridge()?.subtitles;
    if (!subtitles || subtitleBusy) return;
    setSubtitleBusy(true);
    try {
      const result =
        action === "check"
          ? await subtitles.checkForUpdates()
          : action === "install"
            ? await subtitles.install()
            : await subtitles.uninstall();
      const status = unwrapDesktopResult(result);
      setSubtitleStatus(status);
      if (action !== "check") window.location.reload();
    } catch (error) {
      setSubtitleStatus({
        state: "error",
        installedVersion: subtitleStatus?.installedVersion,
        message: error instanceof Error ? error.message : "字幕扩展操作失败。",
      });
    } finally {
      setSubtitleBusy(false);
    }
  };

  const updateCredentials = async (update?: ModelCredentialUpdate) => {
    const credentials = desktopBridge()?.credentials;
    if (!credentials || credentialBusy) return;
    const changes = update ?? Object.fromEntries(
      Object.entries(credentialValues).filter(([, value]) => value.trim()),
    ) as ModelCredentialUpdate;
    if (Object.keys(changes).length === 0) {
      setCredentialMessage("请输入至少一个需要保存的 API Key。");
      return;
    }
    setCredentialBusy(true);
    setCredentialMessage("");
    try {
      const status = unwrapDesktopResult(await credentials.update(changes));
      setCredentialStatus(status);
      setCredentialValues({
        dashscopeApiKey: "",
        deepseekApiKey: "",
        serpApiKey: "",
      });
      setCredentialMessage("API Key 已使用 Windows 加密保存。");
    } catch (error) {
      setCredentialMessage(
        error instanceof Error ? error.message : "无法保存 API Key。",
      );
    } finally {
      setCredentialBusy(false);
    }
  };

  return (
    <div className="user-settings" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="settings-button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={dialogId}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span className="settings-button-icon" aria-hidden="true">
          ⚙
        </span>
        设置
      </button>

      {isOpen ? (
        <section
          id={dialogId}
          className="settings-popover"
          role="dialog"
          aria-modal="false"
          aria-labelledby={titleId}
        >
          <div className="settings-popover-header">
            <div>
              <span>个性化</span>
              <h2 id={titleId}>设置</h2>
            </div>
            <button
              type="button"
              className="settings-close-button"
              aria-label="关闭显示设置"
              onClick={() => {
                setIsOpen(false);
                buttonRef.current?.focus();
              }}
            >
              ×
            </button>
          </div>

          <label className="settings-field settings-theme-field">
            <span>页面风格</span>
            <select
              ref={firstControlRef}
              value={preferences.theme}
              onChange={(event) =>
                updatePreference(
                  "theme",
                  event.target.value as ThemePreference,
                )
              }
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>

          <TypographyFields
            legend="UI 字体"
            description="用于导航、按钮、输入框和对话列表。"
            font={preferences.uiFont}
            fontSize={preferences.uiFontSize}
            onFontChange={(value) => updatePreference("uiFont", value)}
            onFontSizeChange={(value) => updatePreference("uiFontSize", value)}
          />

          <TypographyFields
            legend="文本字体"
            description="用于视频总结、章节内容和后续对话。"
            font={preferences.textFont}
            fontSize={preferences.textFontSize}
            onFontChange={(value) => updatePreference("textFont", value)}
            onFontSizeChange={(value) => updatePreference("textFontSize", value)}
          />

          <fieldset className="settings-group">
            <legend>视频分析</legend>
            <p>
              视频不超过此时长时，优先让 Qwen 直接读取视频；设为 0
              可关闭直接总结。
            </p>
            <label className="settings-field">
              <span>直接总结上限</span>
              <span className="settings-number-input">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_QWEN_DIRECT_SUMMARY_MAX_SECONDS}
                  step={1}
                  value={preferences.qwenDirectSummaryMaxSeconds}
                  aria-label="Qwen 直接总结时长上限，单位秒"
                  onChange={(event) => {
                    if (Number.isFinite(event.target.valueAsNumber)) {
                      updatePreference(
                        "qwenDirectSummaryMaxSeconds",
                        normalizeDirectSummarySeconds(
                          event.target.valueAsNumber,
                        ),
                      );
                    }
                  }}
                  onBlur={(event) => {
                    if (!Number.isFinite(event.target.valueAsNumber)) {
                      event.currentTarget.value = String(
                        preferences.qwenDirectSummaryMaxSeconds,
                      );
                    }
                  }}
                />
                <b aria-hidden="true">秒</b>
              </span>
            </label>
            <span className="settings-size-range">
              可输入 0–{MAX_QWEN_DIRECT_SUMMARY_MAX_SECONDS} 秒
            </span>
          </fieldset>

          {isDesktop ? (
            <fieldset className="settings-group settings-credential-group">
              <legend>模型 API Key</legend>
              <p>
                Key 由 Electron 主进程使用 Windows 加密存储，不会传给界面或写入 SQLite。
              </p>
              {(
                [
                  ["dashscopeApiKey", "Qwen / DashScope", credentialStatus?.dashscopeConfigured],
                  ["deepseekApiKey", "DeepSeek", credentialStatus?.deepseekConfigured],
                  ["serpApiKey", "SerpAPI（可选）", credentialStatus?.serpApiConfigured],
                ] as const
              ).map(([key, label, configured]) => (
                <div className="settings-credential-row" key={key}>
                  <label>
                    <span>{label}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={credentialValues[key]}
                      placeholder={configured ? "已配置；输入新值可替换" : "尚未配置"}
                      onChange={(event) =>
                        setCredentialValues((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {configured ? (
                    <button
                      type="button"
                      disabled={credentialBusy}
                      onClick={() => void updateCredentials({ [key]: null })}
                    >
                      清除
                    </button>
                  ) : null}
                </div>
              ))}
              <div className="settings-extension-actions">
                <button
                  type="button"
                  disabled={credentialBusy}
                  onClick={() => void updateCredentials()}
                >
                  {credentialBusy ? "正在保存…" : "保存 API Key"}
                </button>
              </div>
              {credentialMessage ? (
                <span className="settings-credential-message" aria-live="polite">
                  {credentialMessage}
                </span>
              ) : null}
            </fieldset>
          ) : null}

          {isDesktop ? (
            <fieldset className="settings-group settings-extension-group">
              <legend>字幕扩展</legend>
              <p>
                独立下载约 3.5～3.9 GB，包含 FunASR Nano、CT-Punc、VAD
                和 PyTorch；基础应用不携带这些内容。
              </p>
              <div className="settings-extension-status" aria-live="polite">
                <strong>{subtitleStatusLabel(subtitleStatus)}</strong>
                {subtitleStatus?.installedVersion ? (
                  <span>当前版本 {subtitleStatus.installedVersion}</span>
                ) : null}
                {subtitleStatus?.state === "installing" ? (
                  <progress
                    max={1}
                    value={subtitleStatus.progress ?? 0}
                    aria-label="字幕扩展下载和安装进度"
                  />
                ) : null}
                {subtitleStatus?.message ? (
                  <span className="settings-extension-error">
                    {subtitleStatus.message}
                  </span>
                ) : null}
              </div>
              <div className="settings-extension-actions">
                {subtitleStatus?.state === "installed" ||
                subtitleStatus?.state === "update-available" ? (
                  <>
                    <button
                      type="button"
                      disabled={subtitleBusy}
                      onClick={() => void runSubtitleAction("check")}
                    >
                      检查更新
                    </button>
                    {subtitleStatus.state === "update-available" ? (
                      <button
                        type="button"
                        disabled={subtitleBusy}
                        onClick={() => void runSubtitleAction("install")}
                      >
                        更新扩展
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={subtitleBusy}
                      onClick={() => void runSubtitleAction("uninstall")}
                    >
                      卸载扩展
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={subtitleBusy || subtitleStatus?.state === "installing"}
                    onClick={() => void runSubtitleAction("install")}
                  >
                    {subtitleBusy ? "正在处理…" : "安装字幕扩展"}
                  </button>
                )}
              </div>
            </fieldset>
          ) : null}

          <p className="settings-hint">
            {isDesktop
              ? "这些偏好会保存在本机桌面数据中。"
              : "这些偏好会保存在当前浏览器。"}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function subtitleStatusLabel(status: SubtitleExtensionStatus | null) {
  switch (status?.state) {
    case "installed":
      return "已安装";
    case "update-available":
      return `可更新到 ${status.availableVersion ?? "新版本"}`;
    case "installing":
      return `正在安装 ${Math.round((status.progress ?? 0) * 100)}%`;
    case "uninstalling":
      return "正在卸载";
    case "error":
      return "操作失败";
    default:
      return "未安装";
  }
}
