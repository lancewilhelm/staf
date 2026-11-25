import type { AgentSummary, HarnessInfo } from "@staf/protocol";
import { useEffect, useRef, useState } from "react";
import {
  closeSettings,
  loadModels,
  openSettings,
  removeAgent,
  saveAgent,
  type SettingsView,
  signIn,
  useStore,
} from "../store.ts";
import { Icon } from "./Icon.tsx";

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
          </nav>
          <div className="settings-pane">
            {view.section === "agents" ? <AgentsPane selected={view.agentId} /> : <ProvidersPane />}
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
  const harnesses = useStore((s) => s.health?.harnesses ?? []);
  const models = useStore((s) => s.models);
  const threadCount = useStore((s) => (agent ? s.threads.filter((t) => t.agentId === agent.id).length : 0));

  const [name, setName] = useState(agent?.name ?? "");
  const [harness, setHarness] = useState(agent?.harness ?? "codex");
  const [model, setModel] = useState<string | null>(agent?.model ?? null);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadModels(harness);
  }, [harness]);

  const info = harnesses.find((h) => h.id === harness);
  const list = models[harness];
  const changed =
    !agent ||
    name !== agent.name ||
    harness !== agent.harness ||
    model !== agent.model ||
    instructions !== agent.instructions;

  const save = async () => {
    setBusy(true);
    const result = await saveAgent(agent?.id ?? null, { name, harness, model, instructions });
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
          <select value={model ?? ""} onChange={(e) => setModel(e.target.value || null)}>
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
  const harnesses = useStore((s) => s.health?.harnesses ?? []);
  return (
    <div className="providers-pane">
      {harnesses.map((h) => (
        <ProviderCard key={h.id} harness={h} />
      ))}
    </div>
  );
}

function ProviderCard({ harness }: { harness: HarnessInfo }) {
  const state = !harness.ready ? (harness.signedIn === false ? "Not signed in" : "Not ready") : "Ready";
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
        <span className={`status ${harness.ready ? "ok" : "bad"}`}>{state}</span>
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
