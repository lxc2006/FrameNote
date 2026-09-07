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
    </fieldset>
  );
}

export default function UserSettingsMenu() {
  const [isOpen, setIsOpen] = useState(false);
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
            description=""
            font={preferences.uiFont}
            fontSize={preferences.uiFontSize}
            onFontChange={(value) => updatePreference("uiFont", value)}
            onFontSizeChange={(value) => updatePreference("uiFontSize", value)}
          />

          <TypographyFields
            legend="文本字体"
            description=""
            font={preferences.textFont}
            fontSize={preferences.textFontSize}
            onFontChange={(value) => updatePreference("textFont", value)}
            onFontSizeChange={(value) => updatePreference("textFontSize", value)}
          />

          <fieldset className="settings-group">
            <legend>视频分析</legend>
            <p>
              视频不超过此时长时，优先让 Qwen 直接读取视频
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
          </fieldset>

          {isDesktop ? (
            <fieldset className="settings-group settings-credential-group">
              <legend>模型 API Key</legend>
              <p>
                Qwen Key 同时用于视频总结和在线字幕。所有 Key 均由 Electron
                主进程使用 Windows 加密存储，不会写入 SQLite。
              </p>
              {(
                [
                  [
                    "dashscopeApiKey",
                    "Qwen / DashScope",
                    credentialStatus?.dashscopeConfigured,
                    "https://bailian.console.aliyun.com/?apiKey=1&tab=model",
                  ],
                  [
                    "deepseekApiKey",
                    "DeepSeek",
                    credentialStatus?.deepseekConfigured,
                    "https://platform.deepseek.com/api_keys",
                  ],
                  [
                    "serpApiKey",
                    "SerpAPI",
                    credentialStatus?.serpApiConfigured,
                    "https://serpapi.com/manage-api-key",
                  ],
                ] as const
              ).map(([key, label, configured, consoleUrl]) => (
                <div className="settings-credential-row" key={key}>
                  <div className="settings-credential-field">
                    <div className="settings-credential-label">
                      <span>{label}</span>
                      <button
                        type="button"
                        className="settings-api-link"
                        aria-label={`打开 ${label} API Key 工作台`}
                        title="打开 API Key 工作台"
                        onClick={() => {
                          void desktopBridge()
                            ?.openExternal(consoleUrl)
                            .catch((error: unknown) => {
                              setCredentialMessage(
                                error instanceof Error
                                  ? error.message
                                  : "无法打开 API Key 工作台。",
                              );
                            });
                        }}
                      >
                        获取↗
                      </button>
                    </div>
                    <input
                      type="password"
                      aria-label={`${label} API Key`}
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
                  </div>
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
              <div className="settings-credential-actions">
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
