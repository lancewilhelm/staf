import type { HeroFont, SidebarMode, ThemePreference, UserPreferences } from "./types.ts";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];
export const HERO_FONT_PREFERENCES: readonly HeroFont[] = [
  "bricolage",
  "space-grotesk",
  "sans",
  "fraunces",
  "serif",
];
export const SIDEBAR_MODES: readonly SidebarMode[] = ["inbox", "list"];

export const DEFAULT_PREFERENCES: Readonly<UserPreferences> = {
  theme: "system",
  heroFont: "bricolage",
  sidebarMode: "list",
};

const THEME_SET = new Set<string>(THEME_PREFERENCES);
const HERO_FONT_SET = new Set<string>(HERO_FONT_PREFERENCES);
const SIDEBAR_MODE_SET = new Set<string>(SIDEBAR_MODES);

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_SET.has(value);
}

export function isHeroFont(value: unknown): value is HeroFont {
  return typeof value === "string" && HERO_FONT_SET.has(value);
}

export function isSidebarMode(value: unknown): value is SidebarMode {
  return typeof value === "string" && SIDEBAR_MODE_SET.has(value);
}
