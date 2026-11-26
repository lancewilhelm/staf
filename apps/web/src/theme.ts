// Browser-local appearance settings: color theme and new-chat heading font.
// index.html applies both before the app loads so that the page does not flash in the
// wrong colors or typeface.
//
// Colors and heading fonts are CSS variables in styles.css, selected by `data-theme` and
// `data-hero-font` on <html>.

export type ThemeSetting = "system" | "light" | "dark";
export type Theme = "light" | "dark";
export type HeroFont = "bricolage" | "space-grotesk" | "sans" | "fraunces" | "serif";

export const DEFAULT_HERO_FONT: HeroFont = "bricolage";

const THEME_KEY = "staf.theme";
const FONT_KEY = "staf.heroFont";
const HERO_FONT_SET = new Set<string>(["bricolage", "space-grotesk", "sans", "fraunces", "serif"]);
const dark = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
/** The browser bar color of each theme, the same as `--bg`. */
const BAR_COLORS: Record<Theme, string> = { light: "#f7f7f5", dark: "#151515" };

export function parseHeroFont(value: string | null): HeroFont {
  return value && HERO_FONT_SET.has(value) ? (value as HeroFont) : DEFAULT_HERO_FONT;
}

export function themeSetting(): ThemeSetting {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function setThemeSetting(setting: ThemeSetting): void {
  try {
    if (setting === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, setting);
  } catch {
    // The theme still applies until the page reloads.
  }
  applyTheme(setting);
}

export function heroFontSetting(): HeroFont {
  try {
    return parseHeroFont(localStorage.getItem(FONT_KEY));
  } catch {
    return DEFAULT_HERO_FONT;
  }
}

export function setHeroFontSetting(font: HeroFont): void {
  try {
    if (font === DEFAULT_HERO_FONT) localStorage.removeItem(FONT_KEY);
    else localStorage.setItem(FONT_KEY, font);
  } catch {
    // The heading font still applies until the page reloads.
  }
  applyHeroFont(font);
}

function resolve(setting: ThemeSetting): Theme {
  return setting === "system" ? (dark?.matches ? "dark" : "light") : setting;
}

export function applyTheme(setting: ThemeSetting = themeSetting()): void {
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

export function applyHeroFont(font: HeroFont = heroFontSetting()): void {
  document.documentElement.dataset.heroFont = font;
}

if (typeof window !== "undefined") {
  // Another tab changed an appearance setting.
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_KEY || event.key === null) applyTheme();
    if (event.key === FONT_KEY || event.key === null) applyHeroFont();
  });

  // Follow the system while the theme setting is "system".
  dark?.addEventListener("change", () => {
    if (themeSetting() === "system") applyTheme("system");
  });
}
