// The color theme: light, dark, or the system's. It is a setting of this browser, like the
// last chosen agent, so a phone and a laptop can differ. index.html applies the saved theme
// before the app loads, so that the page does not flash in the wrong colors.
//
// Colors are CSS variables in styles.css. A theme sets `data-theme` on <html>, and the
// variables for that theme apply. Richer themes later add more values of `data-theme`.

export type ThemeSetting = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "staf.theme";
const dark = window.matchMedia("(prefers-color-scheme: dark)");
/** The browser bar color of each theme, the same as `--bg`. */
const BAR_COLORS: Record<Theme, string> = { light: "#f7f7f5", dark: "#151515" };

export function themeSetting(): ThemeSetting {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function setThemeSetting(setting: ThemeSetting): void {
  try {
    if (setting === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, setting);
  } catch {
    // The theme still applies until the page reloads.
  }
  applyTheme(setting);
}

function resolve(setting: ThemeSetting): Theme {
  return setting === "system" ? (dark.matches ? "dark" : "light") : setting;
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

// Follow the system while the setting is "system".
dark.addEventListener("change", () => {
  if (themeSetting() === "system") applyTheme("system");
});
