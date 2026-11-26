import type { AgentSummary, HarnessInfo } from "@staf/protocol";
import { useEffect, useRef, useState } from "react";
import {
  closeSettings,
  effortName,
  loadModels,
  modelInfo,
  openSettings,
  removeAgent,
  saveAgent,
  type SettingsView,
  signIn,
  useHarnesses,
  useStore,
} from "../store.ts";
import { FastSwitch } from "./ChatPill.tsx";
import { Icon } from "./Icon.tsx";
import { setThemeSetting, type ThemeSetting, themeSetting } from "../theme.ts";

/** The settings window: agents and providers. */
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
              className={view.section === "agents" ? "active" : ""}
              onClick={() => openSettings({ section: "agents", agentId: null })}
            >
              <Icon name="user" size={16} />
              Agents
            </button>
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
            {view.section === "agents" && <AgentsPane selected={view.agentId} />}
            {view.section === "providers" && <ProvidersPane />}
            {view.section === "appearance" && <AppearancePane />}
          </div>
        </div>
      </div>
    </div>
  );
}

// Agents

function AgentsPane({ selected }: { selected: string | null }) {
  const agents = useStore((s) => s.agents);
  // "new" opens an empty form; null shows the first agent.
  const [current, setCurrent] = useState<string | "new">(selected ?? agents[0]?.id ?? "new");
  const agent = current === "new" ? null : (agents.find((a) => a.id === current) ?? null);

  return (
    <div className="agents-pane">
      <div className="agent-list" role="listbox" aria-label="Agents">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            role="option"
            aria-selected={a.id === current}
            className={a.id === current ? "active" : ""}
            onClick={() => setCurrent(a.id)}
          >
            <span className="agent-name">{a.name}</span>
            <span className="agent-sub">{a.harnessLabel}</span>
          </button>
        ))}
        <button type="button" className={`new-agent${current === "new" ? " active" : ""}`} onClick={() => setCurrent("new")}>
          <Icon name="plus" size={15} />
          New agent
        </button>
      </div>
      <AgentForm key={current} agent={agent} onSaved={(saved) => setCurrent(saved.id)} onDeleted={() => setCurrent(agents[0]?.id ?? "new")} />
    </div>
  );
}

function AgentForm({
  agent,
  onSaved,
  onDeleted,
}: {
  agent: AgentSummary | null;
  onSaved: (agent: AgentSummary) => void;
  onDeleted: () => void;
}) {
  const harnesses = useHarnesses();
  const models = useStore((s) => s.models);
  const threadCount = useStore((s) => (agent ? s.threads.filter((t) => t.agentId === agent.id).length : 0));

  const [name, setName] = useState(agent?.name ?? "");
  const [harness, setHarness] = useState(agent?.harness ?? "codex");
  const [model, setModel] = useState<string | null>(agent?.model ?? null);
  const [effort, setEffort] = useState<string | null>(agent?.effort ?? null);
  const [fast, setFast] = useState(agent?.fast ?? false);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadModels(harness);
  }, [harness]);

  const info = harnesses.find((h) => h.id === harness);
  const list = models[harness];
  const chosen = modelInfo(models, harness, model);
  const changed =
    !agent ||
    name !== agent.name ||
    harness !== agent.harness ||
    model !== agent.model ||
    effort !== agent.effort ||
    fast !== agent.fast ||
    instructions !== agent.instructions;

  const save = async () => {
    setBusy(true);
    const result = await saveAgent(agent?.id ?? null, { name, harness, model, effort, fast, instructions });
    setBusy(false);
    if (result) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved(result);
    }
  };

  const remove = async () => {
    if (!agent) return;
    const what =
      threadCount > 0
        ? `Delete ${agent.name} and its ${threadCount} conversation${threadCount === 1 ? "" : "s"}? Its workspace moves to Staf's trash folder.`
        : `Delete ${agent.name}? Its workspace moves to Staf's trash folder.`;
    if (!confirm(what)) return;
    setBusy(true);
    if (await removeAgent(agent.id)) onDeleted();
    setBusy(false);
  };

  return (
    <form
      className="agent-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Paper" maxLength={60} required />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Default provider</span>
          <select
            value={harness}
            onChange={(e) => {
              setHarness(e.target.value);
              setModel(null);
              setEffort(null);
              setFast(false);
            }}
          >
            {harnesses.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label}
                {h.experimental ? " (experimental)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Default model</span>
          <select
            value={model ?? ""}
            onChange={(e) => {
              const next = e.target.value || null;
              const nextInfo = modelInfo(models, harness, next);
              setModel(next);
              if (effort && !nextInfo?.efforts?.includes(effort)) setEffort(null);
              if (fast && !nextInfo?.fast) setFast(false);
            }}
          >
            <option value="">Provider's default</option>
            {list?.status === "ready" &&
              list.list.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            {model && list?.status !== "ready" && <option value={model}>{model}</option>}
          </select>
        </label>
      </div>
      {(chosen?.efforts || chosen?.fast) && (
        <div className="field-row">
          {chosen.efforts && (
            <label className="field">
              <span>Default reasoning</span>
              <select value={effort ?? ""} onChange={(e) => setEffort(e.target.value || null)}>
                <option value="">
                  Model's default{chosen.defaultEffort ? ` (${effortName(chosen.defaultEffort)})` : ""}
                </option>
                {chosen.efforts.map((level) => (
                  <option key={level} value={level}>
                    {effortName(level)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {chosen.fast && (
            <div className="field">
              <span>Speed</span>
              <FastSwitch info={chosen} value={fast} onChange={setFast} />
            </div>
          )}
        </div>
      )}
      {info?.note && <p className="field-note">{info.note}</p>}
      {list?.status === "error" && <p className="field-note error">{list.error}</p>}

      <label className="field">
        <span>Instructions</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={9}
          placeholder="Who is this agent, and how should it answer?"
        />
      </label>

      {agent && <AccessSummary agent={agent} />}

      <div className="form-actions">
        {agent && !agent.isDefault && (
          <button type="button" className="button danger" onClick={() => void remove()} disabled={busy}>
            Delete
          </button>
        )}
        <span className="spacer" />
        {saved && <span className="saved">Saved</span>}
        <button type="submit" className="button primary" disabled={busy || !changed || !name.trim()}>
          {agent ? "Save" : "Create agent"}
        </button>
      </div>
    </form>
  );
}

function AccessSummary({ agent }: { agent: AgentSummary }) {
  const folders = agent.writableFolders.length ? agent.writableFolders.join(", ") : "None";
  const apps = agent.harnessApps.length ? agent.harnessApps.join(", ") : "None";
  return (
    <details className="access">
      <summary>Access</summary>
      <dl>
        <dt>Internet for commands</dt>
        <dd>{agent.network ? "On" : "Off"}</dd>
        <dt>Extra writable folders</dt>
        <dd>{folders}</dd>
        <dt>ChatGPT account apps</dt>
        <dd>{apps}</dd>
      </dl>
      <p className="field-note">
        Access is changed in <code>~/.staf/agents/{agent.id}/agent.json</code>, not here, so that an agent cannot
        widen its own access through Staf's web API.
      </p>
    </details>
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

const THEMES: Array<{ id: ThemeSetting; label: string; hint: string }> = [
  { id: "system", label: "System", hint: "Follows this device's light or dark setting" },
  { id: "light", label: "Light", hint: "Always light" },
  { id: "dark", label: "Dark", hint: "Always dark" },
];

function AppearancePane() {
  const [setting, setSetting] = useState<ThemeSetting>(themeSetting);
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
            onClick={() => {
              setThemeSetting(theme.id);
              setSetting(theme.id);
            }}
          >
            <span className={`theme-swatch ${theme.id}`} aria-hidden="true" />
            <span className="theme-label">{theme.label}</span>
            <span className="theme-hint">{theme.hint}</span>
          </button>
        ))}
      </div>
      <p className="field-note">The theme is saved in this browser, so each device can have its own.</p>
    </div>
  );
}
