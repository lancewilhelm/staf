import { describe, expect, test } from "bun:test";
import { DEFAULT_PREFERENCES, type UserPreferences } from "@staf/protocol";
import {
  DEFAULT_HERO_FONT,
  legacyPreferencesToMigrate,
  parseHeroFont,
  parseThemePreference,
} from "../src/theme.ts";

const DEFAULTS: UserPreferences = { ...DEFAULT_PREFERENCES };

describe("preferences helpers", () => {
  test("parseThemePreference accepts known themes and falls back to system", () => {
    expect(parseThemePreference("system")).toBe("system");
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("sepia")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  test("parseHeroFont accepts known fonts and falls back to default", () => {
    expect(parseHeroFont("fraunces")).toBe("fraunces");
    expect(parseHeroFont("unknown")).toBe(DEFAULT_HERO_FONT);
    expect(parseHeroFont(null)).toBe(DEFAULT_HERO_FONT);
  });

  test("legacyPreferencesToMigrate migrates unsynced non-default browser settings once", () => {
    expect(
      legacyPreferencesToMigrate(DEFAULTS, {
        theme: "dark",
        heroFont: "bricolage",
        synced: false,
      }),
    ).toEqual({ theme: "dark" });

    expect(
      legacyPreferencesToMigrate(DEFAULTS, {
        theme: "light",
        heroFont: "fraunces",
        synced: false,
      }),
    ).toEqual({ theme: "light", heroFont: "fraunces" });
  });

  test("legacyPreferencesToMigrate skips migration when already synced, host is customized, or browser has defaults", () => {
    expect(
      legacyPreferencesToMigrate(DEFAULTS, {
        theme: "dark",
        heroFont: "fraunces",
        synced: true,
      }),
    ).toBeNull();

    expect(
      legacyPreferencesToMigrate(
        { theme: "light", heroFont: "bricolage", sidebarMode: "list" },
        { theme: "dark", heroFont: "fraunces", synced: false },
      ),
    ).toBeNull();

    expect(
      legacyPreferencesToMigrate(
        { theme: "system", heroFont: "bricolage", sidebarMode: "inbox" },
        { theme: "dark", heroFont: "bricolage", synced: false },
      ),
    ).toBeNull();

    expect(
      legacyPreferencesToMigrate(DEFAULTS, {
        theme: "system",
        heroFont: "bricolage",
        synced: false,
      }),
    ).toBeNull();
  });
});
