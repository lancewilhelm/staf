// Applies the color theme and new-chat heading font, and maintains a localStorage pre-paint
// cache so index.html can draw the right colors and typeface before React mounts.
// The host database is the source of truth; store.ts syncs preferences over HTTP and SSE.

import {
  DEFAULT_PREFERENCES,
  isHeroFont,
  isThemePreference,
  type HeroFont,
  type ThemePreference,
  type UpdatePreferencesRequest,
  type UserPreferences,
} from "@staf/protocol";

export type ThemeSetting = ThemePreference;
export type Theme = "light" | "dark";
export type { HeroFont, ThemePreference };

export const DEFAULT_HERO_FONT: HeroFont = DEFAULT_PREFERENCES.heroFont;

const THEME_KEY = "staf.theme";
const FONT_KEY = "staf.heroFont";
const SYNCED_KEY = "staf.prefsSynced";
const dark = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
/** The browser bar color of each theme, the same as `--bg`. */
const BAR_COLORS: Record<Theme, string> = { light: "#f7f7f5", dark: "#151515" };

let currentTheme: ThemePreference = "system";

export interface CachedPreferences {
  theme: ThemePreference;
  heroFont: HeroFont;
  synced: boolean;
}

export function parseThemePreference(value: string | null): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_PREFERENCES.theme;
}

export function parseHeroFont(value: string | null): HeroFont {
  return isHeroFont(value) ? value : DEFAULT_HERO_FONT;
}

export function readCachedPreferences(): CachedPreferences {
  try {
    return {
      theme: parseThemePreference(localStorage.getItem(THEME_KEY)),
      heroFont: parseHeroFont(localStorage.getItem(FONT_KEY)),
      synced: localStorage.getItem(SYNCED_KEY) === "1",
    };
  } catch {
    return {
      theme: DEFAULT_PREFERENCES.theme,
      heroFont: DEFAULT_PREFERENCES.heroFont,
      synced: false,
    };
  }
}

export function writeCachedPreferences(preferences: Pick<UserPreferences, "theme" | "heroFont">): void {
  try {
    if (preferences.theme === DEFAULT_PREFERENCES.theme) localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, preferences.theme);
    if (preferences.heroFont === DEFAULT_PREFERENCES.heroFont) localStorage.removeItem(FONT_KEY);
    else localStorage.setItem(FONT_KEY, preferences.heroFont);
    localStorage.setItem(SYNCED_KEY, "1");
  } catch {
    // Preferences still apply for this session even if localStorage is unavailable.
  }
}

export function markPreferencesSynced(): void {
  try {
    localStorage.setItem(SYNCED_KEY, "1");
  } catch {
    // Handled in memory by store.ts.
  }
}

/**
 * Migrates browser-local settings saved before host-synced preferences existed.
 * Runs at most once per browser, and only while the host still holds default preferences.
 */
export function legacyPreferencesToMigrate(
  server: UserPreferences,
  cached: CachedPreferences,
): UpdatePreferencesRequest | null {
  if (cached.synced) return null;
  const serverIsDefault =
    server.theme === DEFAULT_PREFERENCES.theme &&
    server.heroFont === DEFAULT_PREFERENCES.heroFont &&
    server.sidebarMode === DEFAULT_PREFERENCES.sidebarMode;
  if (!serverIsDefault) return null;

  const patch: UpdatePreferencesRequest = {};
  if (cached.theme !== DEFAULT_PREFERENCES.theme) patch.theme = cached.theme;
  if (cached.heroFont !== DEFAULT_PREFERENCES.heroFont) patch.heroFont = cached.heroFont;
  return Object.keys(patch).length > 0 ? patch : null;
}

function resolve(setting: ThemePreference): Theme {
  return setting === "system" ? (dark?.matches ? "dark" : "light") : setting;
}

export function applyTheme(setting: ThemePreference = readCachedPreferences().theme): void {
  currentTheme = setting;
  if (typeof document === "undefined") return;
  const theme = resolve(setting);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  let bar = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!bar) {
    bar = document.createElement("meta");
    bar.name = "theme-color";
    document.head.append(bar);
  }
  bar.content = BAR_COLORS[theme];
}

export function applyHeroFont(font: HeroFont = readCachedPreferences().heroFont): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.heroFont = font;
}

export function applyPreferences(preferences: Pick<UserPreferences, "theme" | "heroFont">): void {
  applyTheme(preferences.theme);
  applyHeroFont(preferences.heroFont);
}

if (typeof window !== "undefined") {
  // Follow the system while the theme setting is "system".
  dark?.addEventListener("change", () => {
    if (currentTheme === "system") applyTheme("system");
  });
}
