import type { HarnessInfo, HeroFont, SidebarMode, ThemePreference } from "@staf/protocol";
import { useEffect, useRef } from "react";
import {
  closeSettings,
  openSettings,
  type SettingsView,
  signIn,
  updatePreferences,
  useHarnesses,
  useStore,
} from "../store.ts";
import { Icon } from "./Icon.tsx";

/** The global settings window: providers and appearance. */
export function Settings({ view }: { view: SettingsView }) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSettings();
    };
    document.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-scrim" onPointerDown={(event) => event.target === event.currentTarget && closeSettings()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} ref={dialog}>
        <header className="modal-head">
          <h2>Settings</h2>
          <button type="button" className="icon-button" onClick={closeSettings} aria-label="Close settings">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">
          <nav className="settings-nav" aria-label="Settings sections">
            <button
              type="button"
              className={view.section === "providers" ? "active" : ""}
              onClick={() => openSettings({ section: "providers" })}
            >
              <Icon name="plug" size={16} />
              Providers
            </button>
            <button
              type="button"
              className={view.section === "appearance" ? "active" : ""}
              onClick={() => openSettings({ section: "appearance" })}
            >
              <Icon name="appearance" size={16} />
              Appearance
            </button>
          </nav>
          <div className="settings-pane">
            {view.section === "providers" && <ProvidersPane />}
            {view.section === "appearance" && <AppearancePane />}
          </div>
        </div>
      </div>
    </div>
  );
}

// Providers

function ProvidersPane() {
  const harnesses = useHarnesses();
  return (
    <div className="providers-pane">
      {harnesses.map((h) => (
        <ProviderCard key={h.id} harness={h} />
      ))}
    </div>
  );
}

function ProviderCard({ harness }: { harness: HarnessInfo }) {
  // Stoplight: green when ready, yellow when a sign-in would fix it, red otherwise.
  const status = harness.ready
    ? { label: "Ready", tone: "ok" }
    : harness.signedIn === false
      ? { label: "Not signed in", tone: "warn" }
      : { label: "Not ready", tone: "bad" };
  return (
    <section className="provider">
      <header>
        <div>
          <h3>
            {harness.label}
            {harness.experimental && <span className="tag">Experimental</span>}
          </h3>
          <p className="provider-sub">Runs through {harness.program}</p>
        </div>
        <span className={`status ${status.tone}`}>{status.label}</span>
      </header>
      {harness.note && <p>{harness.note}</p>}
      {!harness.ready && harness.detail && <p className="field-note error">{harness.detail}</p>}
      {harness.signIn === "staf" ? (
        <div className="provider-actions">
          {harness.account && <span className="account">Signed in as {harness.account}</span>}
          <button type="button" className="button" onClick={() => void signIn(harness.id)}>
            {harness.signedIn ? "Sign in again" : "Sign in"}
          </button>
        </div>
      ) : (
        <p className="field-note">
          Uses this computer's {harness.program} sign-in. To sign in or switch accounts, run{" "}
          <code>{harness.id === "claude" ? "claude" : "agy"}</code> once in a terminal.
        </p>
      )}
    </section>
  );
}

// Appearance

const THEMES: Array<{ id: ThemePreference; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Follows this device's light or dark setting" },
  { id: "light", label: "Light", hint: "Always light" },
  { id: "dark", label: "Dark", hint: "Always dark" },
];

const HERO_FONTS: Array<{ id: HeroFont; label: string; hint: string }> = [
  { id: "bricolage", label: "Bricolage Grotesque", hint: "Sans-serif · Expressive" },
  { id: "space-grotesk", label: "Space Grotesk", hint: "Sans-serif · Geometric" },
  { id: "sans", label: "System sans", hint: "Sans-serif · Neutral" },
  { id: "fraunces", label: "Fraunces Soft", hint: "Serif · Warm display" },
  { id: "serif", label: "System serif", hint: "Serif · Classic" },
];

const SIDEBAR_MODE_OPTIONS: Array<{ id: SidebarMode; label: string; hint: string }> = [
  {
    id: "inbox",
    label: "Inbox",
    hint: "Active threads and scheduled runs stay in your Inbox until settled",
  },
  {
    id: "list",
    label: "Thread list",
    hint: "Chronological thread list, with scheduled runs in a separate Inbox section",
  },
];

function AppearancePane() {
  const setting = useStore((s) => s.preferences.theme);
  const font = useStore((s) => s.preferences.heroFont);
  const sidebarMode = useStore((s) => s.preferences.sidebarMode);
  const sample = useStore((s) => {
    const thread = s.threads.find((t) => t.id === s.threadId);
    return s.agents.find((a) => a.id === (thread?.agentId ?? s.agentId))?.name ?? "Staf";
  });

  return (
    <div className="appearance-pane">
      <h3>Theme</h3>
      <div className="theme-options" role="radiogroup" aria-label="Theme">
        {THEMES.map((theme) => (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={setting === theme.id}
            className={`theme-option${setting === theme.id ? " selected" : ""}`}
            onClick={() => void updatePreferences({ theme: theme.id })}
          >
            <span className="theme-swatch" aria-hidden="true">
              {theme.id === "system" ? (
                <>
                  <MiniScreen theme="light" />
                  <MiniScreen theme="dark" />
                </>
              ) : (
                <MiniScreen theme={theme.id} />
              )}
            </span>
            <span className="theme-label">{theme.label}</span>
            <span className="theme-hint">{theme.hint}</span>
          </button>
        ))}
      </div>

      <h3 className="appearance-heading">Heading font</h3>
      <div className="font-options" role="radiogroup" aria-label="Heading font">
        {HERO_FONTS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={font === item.id}
            className={`theme-option font-option${font === item.id ? " selected" : ""}`}
            onClick={() => void updatePreferences({ heroFont: item.id })}
          >
            <span className={`font-swatch font-sample-${item.id}`} aria-hidden="true">
              {sample}
            </span>
            <span className="theme-label">{item.label}</span>
            <span className="theme-hint">{item.hint}</span>
          </button>
        ))}
      </div>

      <h3 className="appearance-heading">Sidebar</h3>
      <div className="sidebar-mode-options" role="radiogroup" aria-label="Sidebar mode">
        {SIDEBAR_MODE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={sidebarMode === option.id}
            className={`theme-option${sidebarMode === option.id ? " selected" : ""}`}
            onClick={() => void updatePreferences({ sidebarMode: option.id })}
          >
            <span className="mode-swatch" aria-hidden="true">
              <MiniSidebar mode={option.id} />
            </span>
            <span className="theme-label">{option.label}</span>
            <span className="theme-hint">{option.hint}</span>
          </button>
        ))}
      </div>

      <p className="field-note">
        Theme, heading font, and sidebar mode are saved on your Staf host and sync across your browsers and devices.
      </p>
    </div>
  );
}

/** A tiny diagram of the sidebar in Inbox mode vs. Thread list mode. */
function MiniSidebar({ mode }: { mode: SidebarMode }) {
  if (mode === "inbox") {
    return (
      <span className="mini-sidebar">
        <span className="mini-sidebar-head">Inbox</span>
        <span className="mini-sidebar-row">
          <span className="mini-sidebar-dot" />
          <span className="mini-sidebar-bar" />
          <span className="mini-sidebar-check" />
        </span>
        <span className="mini-sidebar-row">
          <span className="mini-sidebar-bar short" />
          <span className="mini-sidebar-check" />
        </span>
        <span className="mini-sidebar-foot">Settled</span>
      </span>
    );
  }
  return (
    <span className="mini-sidebar">
      <span className="mini-sidebar-head">Inbox</span>
      <span className="mini-sidebar-row">
        <span className="mini-sidebar-dot" />
        <span className="mini-sidebar-bar short" />
      </span>
      <span className="mini-sidebar-head">Threads</span>
      <span className="mini-sidebar-row">
        <span className="mini-sidebar-bar" />
      </span>
    </span>
  );
}

/** A tiny picture of the Staf screen in one theme. */
function MiniScreen({ theme }: { theme: "light" | "dark" }) {
  return (
    <span className={`mini ${theme}`}>
      <span className="mini-side" />
      <span className="mini-main">
        <span className="mini-line" />
        <span className="mini-line short" />
        <span className="mini-box" />
      </span>
    </span>
  );
}
