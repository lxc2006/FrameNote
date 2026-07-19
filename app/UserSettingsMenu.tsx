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
type ChineseFontPreference = "system" | "source-han-sans" | "serif";
type EnglishFontPreference = "system" | "humanist" | "serif";
type FontSizePreference = "small" | "standard" | "comfortable" | "large";

interface UserPreferences {
  theme: ThemePreference;
  chineseFont: ChineseFontPreference;
  englishFont: EnglishFontPreference;
  fontSize: FontSizePreference;
}

const STORAGE_KEY = "framenote.user-preferences.v1";
const PREFERENCES_CHANGE_EVENT = "framenote:preferences-change";

const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "light",
  chineseFont: "system",
  englishFont: "system",
  fontSize: "comfortable",
};

const CHINESE_FONT_STACKS: Record<ChineseFontPreference, string> = {
  system:
    '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  "source-han-sans":
    '"Source Han Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  serif: '"Songti SC", SimSun, STSong, serif',
};

const ENGLISH_FONT_STACKS: Record<EnglishFontPreference, string> = {
  system: 'Inter, "Segoe UI", Arial',
  humanist: '"Trebuchet MS", "Segoe UI", Arial',
  serif: 'Georgia, "Times New Roman"',
};

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark";
}

function isChineseFontPreference(
  value: unknown,
): value is ChineseFontPreference {
  return value === "system" || value === "source-han-sans" || value === "serif";
}

function isEnglishFontPreference(
  value: unknown,
): value is EnglishFontPreference {
  return value === "system" || value === "humanist" || value === "serif";
}

function isFontSizePreference(value: unknown): value is FontSizePreference {
  return (
    value === "small" ||
    value === "standard" ||
    value === "comfortable" ||
    value === "large"
  );
}

function parsePreferences(storedValue: string): UserPreferences {
  try {
    if (!storedValue) {
      return DEFAULT_PREFERENCES;
    }

    const parsed = JSON.parse(storedValue) as Partial<UserPreferences>;
    return {
      theme: isThemePreference(parsed.theme)
        ? parsed.theme
        : DEFAULT_PREFERENCES.theme,
      chineseFont: isChineseFontPreference(parsed.chineseFont)
        ? parsed.chineseFont
        : DEFAULT_PREFERENCES.chineseFont,
      englishFont: isEnglishFontPreference(parsed.englishFont)
        ? parsed.englishFont
        : DEFAULT_PREFERENCES.englishFont,
      fontSize: isFontSizePreference(parsed.fontSize)
        ? parsed.fontSize
        : DEFAULT_PREFERENCES.fontSize,
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
  root.dataset.fontSize = preferences.fontSize;
  root.dataset.fontZh = preferences.chineseFont;
  root.dataset.fontEn = preferences.englishFont;
  root.style.setProperty(
    "--font-zh",
    CHINESE_FONT_STACKS[preferences.chineseFont],
  );
  root.style.setProperty(
    "--font-en",
    ENGLISH_FONT_STACKS[preferences.englishFont],
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
            <h2 id={titleId}>显示设置</h2>
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

          <label className="settings-field">
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

          <label className="settings-field">
            <span>中文字体</span>
            <select
              value={preferences.chineseFont}
              onChange={(event) =>
                updatePreference(
                  "chineseFont",
                  event.target.value as ChineseFontPreference,
                )
              }
            >
              <option value="system">系统黑体</option>
              <option value="source-han-sans">思源黑体</option>
              <option value="serif">宋体</option>
            </select>
          </label>

          <label className="settings-field">
            <span>英文字体</span>
            <select
              value={preferences.englishFont}
              onChange={(event) =>
                updatePreference(
                  "englishFont",
                  event.target.value as EnglishFontPreference,
                )
              }
            >
              <option value="system">Inter / 系统</option>
              <option value="humanist">Humanist</option>
              <option value="serif">Georgia</option>
            </select>
          </label>

          <label className="settings-field">
            <span>字体大小</span>
            <select
              value={preferences.fontSize}
              onChange={(event) =>
                updatePreference(
                  "fontSize",
                  event.target.value as FontSizePreference,
                )
              }
            >
              <option value="small">较小</option>
              <option value="standard">标准</option>
              <option value="comfortable">舒适（默认）</option>
              <option value="large">较大</option>
            </select>
          </label>

          <p className="settings-hint">显示偏好会保存在当前浏览器。</p>
        </section>
      ) : null}
    </div>
  );
}
