export type ThemePreference = "light" | "dark";

export type FontPreference =
  | "system"
  | "microsoft-yahei"
  | "youyuan"
  | "kaiti"
  | "source-han-sans"
  | "songti"
  | "humanist"
  | "serif"
  | "consolas";

export interface UserPreferences {
  theme: ThemePreference;
  uiFont: FontPreference;
  uiFontSize: number;
  textFont: FontPreference;
  textFontSize: number;
  qwenDirectSummaryMaxSeconds: number;
  autoDetectClipboardLinks: boolean;
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
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 28;
const DEFAULT_FONT_SIZE = 16;

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  theme: "light",
  uiFont: "system",
  uiFontSize: DEFAULT_FONT_SIZE,
  textFont: "system",
  textFontSize: DEFAULT_FONT_SIZE,
  qwenDirectSummaryMaxSeconds: DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
  autoDetectClipboardLinks: true,
};

const LEGACY_FONT_SIZES: Record<
  NonNullable<LegacyUserPreferences["fontSize"]>,
  number
> = {
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

export function normalizeFontSize(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)))
    : fallback;
}

export function normalizeDirectSummarySeconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(
        MAX_QWEN_DIRECT_SUMMARY_MAX_SECONDS,
        Math.max(0, Math.round(value)),
      )
    : DEFAULT_QWEN_DIRECT_SUMMARY_MAX_SECONDS;
}

export function parseUserPreferences(storedValue: string): UserPreferences {
  try {
    if (!storedValue) return DEFAULT_USER_PREFERENCES;

    const parsed = JSON.parse(storedValue) as Partial<UserPreferences> &
      LegacyUserPreferences;
    const legacyFont = isFontPreference(parsed.uiChineseFont)
      ? parsed.uiChineseFont
      : isFontPreference(parsed.uiEnglishFont)
        ? parsed.uiEnglishFont
        : isFontPreference(parsed.chineseFont)
          ? parsed.chineseFont === "serif"
            ? "songti"
            : parsed.chineseFont
          : isFontPreference(parsed.englishFont)
            ? parsed.englishFont
            : DEFAULT_USER_PREFERENCES.uiFont;
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
        : DEFAULT_USER_PREFERENCES.theme,
      uiFont: isFontPreference(parsed.uiFont) ? parsed.uiFont : legacyFont,
      uiFontSize: normalizeFontSize(parsed.uiFontSize, legacyFontSize),
      textFont: isFontPreference(parsed.textFont)
        ? parsed.textFont
        : legacyTextFont,
      textFontSize: normalizeFontSize(parsed.textFontSize, legacyFontSize),
      qwenDirectSummaryMaxSeconds: normalizeDirectSummarySeconds(
        parsed.qwenDirectSummaryMaxSeconds,
      ),
      autoDetectClipboardLinks:
        typeof parsed.autoDetectClipboardLinks === "boolean"
          ? parsed.autoDetectClipboardLinks
          : DEFAULT_USER_PREFERENCES.autoDetectClipboardLinks,
    };
  } catch {
    return DEFAULT_USER_PREFERENCES;
  }
}

export function normalizeUserPreferences(value: unknown): UserPreferences {
  return parseUserPreferences(JSON.stringify(value) ?? "");
}
