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
type ChineseFontPreference =
  | "system"
  | "microsoft-yahei"
  | "youyuan"
  | "kaiti"
  | "source-han-sans"
  | "songti";
type EnglishFontPreference = "system" | "humanist" | "serif" | "consolas";

interface UserPreferences {
  theme: ThemePreference;
  uiChineseFont: ChineseFontPreference;
  uiEnglishFont: EnglishFontPreference;
  uiFontSize: number;
  textChineseFont: ChineseFontPreference;
  textEnglishFont: EnglishFontPreference;
  textFontSize: number;
}

interface LegacyUserPreferences {
  chineseFont?: "system" | "source-han-sans" | "serif";
  englishFont?: "system" | "humanist" | "serif";
  fontSize?: "small" | "standard" | "comfortable" | "large";
}

const STORAGE_KEY = "framenote.user-preferences.v1";
const PREFERENCES_CHANGE_EVENT = "framenote:preferences-change";
const MIN_FONT_SIZE = 12;
const MAX_FONT_SIZE = 28;
const DEFAULT_FONT_SIZE = 16;

const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "light",
  uiChineseFont: "system",
  uiEnglishFont: "system",
  uiFontSize: DEFAULT_FONT_SIZE,
  textChineseFont: "system",
  textEnglishFont: "system",
  textFontSize: DEFAULT_FONT_SIZE,
};

const CHINESE_FONT_STACKS: Record<ChineseFontPreference, string> = {
  system:
    '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  "microsoft-yahei":
    '"Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", sans-serif',
  youyuan: 'YouYuan, "幼圆", "Microsoft YaHei", sans-serif',
  kaiti: 'KaiTi, "楷体", STKaiti, "Microsoft YaHei", serif',
  "source-han-sans":
    '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  songti: 'SimSun, "宋体", "Songti SC", STSong, serif',
};

const ENGLISH_FONT_STACKS: Record<EnglishFontPreference, string> = {
  system: 'Inter, "Segoe UI", Arial, sans-serif',
  humanist: '"Trebuchet MS", "Segoe UI", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  consolas: 'Consolas, "Cascadia Mono", "Courier New", monospace',
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

function isChineseFontPreference(
  value: unknown,
): value is ChineseFontPreference {
  return (
    value === "system" ||
    value === "microsoft-yahei" ||
    value === "youyuan" ||
    value === "kaiti" ||
    value === "source-han-sans" ||
    value === "songti"
  );
}

function isEnglishFontPreference(
  value: unknown,
): value is EnglishFontPreference {
  return (
    value === "system" ||
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

function migrateLegacyChineseFont(
  value: LegacyUserPreferences["chineseFont"],
): ChineseFontPreference {
  return value === "serif" ? "songti" : value ?? "system";
}

function parsePreferences(storedValue: string): UserPreferences {
  try {
    if (!storedValue) {
      return DEFAULT_PREFERENCES;
    }

    const parsed = JSON.parse(storedValue) as Partial<UserPreferences> &
      LegacyUserPreferences;
    const legacyChineseFont = migrateLegacyChineseFont(parsed.chineseFont);
    const legacyEnglishFont = isEnglishFontPreference(parsed.englishFont)
      ? parsed.englishFont
      : DEFAULT_PREFERENCES.uiEnglishFont;
    const legacyFontSize = isLegacyFontSize(parsed.fontSize)
      ? LEGACY_FONT_SIZES[parsed.fontSize]
      : DEFAULT_FONT_SIZE;

    return {
      theme: isThemePreference(parsed.theme)
        ? parsed.theme
        : DEFAULT_PREFERENCES.theme,
      uiChineseFont: isChineseFontPreference(parsed.uiChineseFont)
        ? parsed.uiChineseFont
        : legacyChineseFont,
      uiEnglishFont: isEnglishFontPreference(parsed.uiEnglishFont)
        ? parsed.uiEnglishFont
        : legacyEnglishFont,
      uiFontSize: normalizeFontSize(parsed.uiFontSize, legacyFontSize),
      textChineseFont: isChineseFontPreference(parsed.textChineseFont)
        ? parsed.textChineseFont
        : legacyChineseFont,
      textEnglishFont: isEnglishFontPreference(parsed.textEnglishFont)
        ? parsed.textEnglishFont
        : legacyEnglishFont,
      textFontSize: normalizeFontSize(parsed.textFontSize, legacyFontSize),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function readPreferenceStorage() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function getServerPreferenceStorage() {
  return "";
}

function subscribeToPreferenceStorage(onStoreChange: () => void) {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      onStoreChange();
    }
  };

  window.addEventListener("storage", handleStorage);
  window.addEventListener(PREFERENCES_CHANGE_EVENT, onStoreChange);

  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(PREFERENCES_CHANGE_EVENT, onStoreChange);
  };
}

function applyPreferences(preferences: UserPreferences) {
  const root = document.documentElement;
  root.dataset.theme = preferences.theme;
  root.style.setProperty(
    "--ui-font-zh",
    CHINESE_FONT_STACKS[preferences.uiChineseFont],
  );
  root.style.setProperty(
    "--ui-font-en",
    ENGLISH_FONT_STACKS[preferences.uiEnglishFont],
  );
  root.style.setProperty("--ui-font-size", `${preferences.uiFontSize}px`);
  root.style.setProperty(
    "--text-font-zh",
    CHINESE_FONT_STACKS[preferences.textChineseFont],
  );
  root.style.setProperty(
    "--text-font-en",
    ENGLISH_FONT_STACKS[preferences.textEnglishFont],
  );
  root.style.setProperty("--text-font-size", `${preferences.textFontSize}px`);
  root.style.setProperty(
    "--content-font-adjust",
    `${preferences.textFontSize - 12}px`,
  );
}

function savePreferences(preferences: UserPreferences) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
    window.dispatchEvent(new Event(PREFERENCES_CHANGE_EVENT));
  } catch {
    // Browsers can disable local storage. Applied settings still work this visit.
  }
}

interface TypographyFieldsProps {
  legend: string;
  description: string;
  chineseFont: ChineseFontPreference;
  englishFont: EnglishFontPreference;
  fontSize: number;
  onChineseFontChange: (value: ChineseFontPreference) => void;
  onEnglishFontChange: (value: EnglishFontPreference) => void;
  onFontSizeChange: (value: number) => void;
}

function TypographyFields({
  legend,
  description,
  chineseFont,
  englishFont,
  fontSize,
  onChineseFontChange,
  onEnglishFontChange,
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
        <span>中文字体</span>
        <select
          value={chineseFont}
          onChange={(event) =>
            onChineseFontChange(event.target.value as ChineseFontPreference)
          }
        >
          <option value="system">系统默认</option>
          <option value="microsoft-yahei">微软雅黑</option>
          <option value="youyuan">幼圆</option>
          <option value="kaiti">楷体</option>
          <option value="source-han-sans">思源黑体</option>
          <option value="songti">宋体</option>
        </select>
      </label>

      <label className="settings-field">
        <span>英文字体</span>
        <select
          value={englishFont}
          onChange={(event) =>
            onEnglishFontChange(event.target.value as EnglishFontPreference)
          }
        >
          <option value="system">Inter / 系统</option>
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
    () => parsePreferences(storedPreferences),
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
              <h2 id={titleId}>显示设置</h2>
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
              <option value="dark">深色（黑灰）</option>
            </select>
          </label>

          <TypographyFields
            legend="UI 字体"
            description="用于导航、按钮、输入框和对话列表。"
            chineseFont={preferences.uiChineseFont}
            englishFont={preferences.uiEnglishFont}
            fontSize={preferences.uiFontSize}
            onChineseFontChange={(value) => updatePreference("uiChineseFont", value)}
            onEnglishFontChange={(value) => updatePreference("uiEnglishFont", value)}
            onFontSizeChange={(value) => updatePreference("uiFontSize", value)}
          />

          <TypographyFields
            legend="文本字体"
            description="用于视频总结、章节内容和后续对话。"
            chineseFont={preferences.textChineseFont}
            englishFont={preferences.textEnglishFont}
            fontSize={preferences.textFontSize}
            onChineseFontChange={(value) => updatePreference("textChineseFont", value)}
            onEnglishFontChange={(value) => updatePreference("textEnglishFont", value)}
            onFontSizeChange={(value) => updatePreference("textFontSize", value)}
          />

          <p className="settings-hint">显示偏好会保存在当前浏览器。</p>
        </section>
      ) : null}
    </div>
  );
}
