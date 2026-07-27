"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type ThemePreference = "light" | "dark";
type FontPreference =
  | "system"
  | "microsoft-yahei"
  | "youyuan"
  | "kaiti"
  | "source-han-sans"
  | "songti"
  | "humanist"
  | "serif"
  | "consolas";

interface UserPreferences {
  theme: ThemePreference;
  uiFont: FontPreference;
  uiFontSize: number;
  textFont: FontPreference;
  textFontSize: number;
  qwenDirectSummaryMaxSeconds: number;
}

interface LegacyUserPreferences {
  uiChineseFont?: FontPreference;
  uiEnglishFont?: FontPreference;
  textChineseFont?: FontPreference;
  textEnglishFont?: FontPreference;
  chineseFont?: "system" | "source-han-sans" | "serif";
  englishFont?: "system" | "humanist" | "serif";
  fontSize?: "small" | "standard" | "comfortable" | "large";
}

export const USER_PREFERENCES_STORAGE_KEY = "framenote.user-preferences.v1";
export const USER_PREFERENCES_CHANGE_EVENT = "framenote:preferences-change";
export const DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS = 360;
export const MAX_QWEN_DIRECT_SUMMARY_MAX_SECONDS = 900;
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 28;
const DEFAULT_FONT_SIZE = 16;

const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "light",
  uiFont: "system",
  uiFontSize: DEFAULT_FONT_SIZE,
  textFont: "system",
  textFontSize: DEFAULT_FONT_SIZE,
  qwenDirectSummaryMaxSeconds: DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
};

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

const LEGACY_FONT_SIZES: Record<NonNullable<LegacyUserPreferences["fontSize"]>, number> = {
  small: 11,
  standard: 12,
  comfortable: 14,
  large: 16,
};

function isLegacyFontSize(
  value: unknown,
): value is NonNullable<LegacyUserPreferences["fontSize"]> {
  return (
    value === "small" ||
    value === "standard" ||
    value === "comfortable" ||
    value === "large"
  );
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark";
}

function isFontPreference(value: unknown): value is FontPreference {
  return (
    value === "system" ||
    value === "microsoft-yahei" ||
    value === "youyuan" ||
    value === "kaiti" ||
    value === "source-han-sans" ||
    value === "songti" ||
    value === "humanist" ||
    value === "serif" ||
    value === "consolas"
  );
}

function normalizeFontSize(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)))
    : fallback;
}

function normalizeDirectSummarySeconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(
        MAX_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
        Math.max(0, Math.round(value)),
      )
    : DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS;
}

export function parseUserPreferences(storedValue: string): UserPreferences {
  try {
    if (!storedValue) {
      return DEFAULT_PREFERENCES;
    }

    const parsed = JSON.parse(storedValue) as Partial<UserPreferences> &
      LegacyUserPreferences;
    const legacyFont = isFontPreference(parsed.uiChineseFont)
      ? parsed.uiChineseFont
      : isFontPreference(parsed.uiEnglishFont)
        ? parsed.uiEnglishFont
        : isFontPreference(parsed.chineseFont)
          ? parsed.chineseFont === "serif" ? "songti" : parsed.chineseFont
          : isFontPreference(parsed.englishFont)
            ? parsed.englishFont
            : DEFAULT_PREFERENCES.uiFont;
    const legacyTextFont = isFontPreference(parsed.textChineseFont)
      ? parsed.textChineseFont
      : isFontPreference(parsed.textEnglishFont)
        ? parsed.textEnglishFont
        : legacyFont;
    const legacyFontSize = isLegacyFontSize(parsed.fontSize)
      ? LEGACY_FONT_SIZES[parsed.fontSize]
      : DEFAULT_FONT_SIZE;

    return {
      theme: isThemePreference(parsed.theme)
        ? parsed.theme
        : DEFAULT_PREFERENCES.theme,
      uiFont: isFontPreference(parsed.uiFont) ? parsed.uiFont : legacyFont,
      uiFontSize: normalizeFontSize(parsed.uiFontSize, legacyFontSize),
      textFont: isFontPreference(parsed.textFont)
        ? parsed.textFont
        : legacyTextFont,
      textFontSize: normalizeFontSize(parsed.textFontSize, legacyFontSize),
      qwenDirectSummaryMaxSeconds: normalizeDirectSummarySeconds(
        parsed.qwenDirectSummaryMaxSeconds,
      ),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

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

function savePreferences(preferences: UserPreferences) {
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

          <p className="settings-hint">这些偏好会保存在当前浏览器。</p>
        </section>
      ) : null}
    </div>
  );
}
