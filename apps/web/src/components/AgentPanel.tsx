import type { AgentSummary } from "@staf/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentInitial } from "../sidebar.ts";
import {
  type AgentPanelSection,
  type AgentPanelView,
  chooseAgent,
  closeAgentPanel,
  effortName,
  loadModels,
  modelName,
  openAgentPanel,
  openSettings,
  removeAgent,
  saveAgent,
  useHarnesses,
  useStore,
} from "../store.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { ModelPickerPanel, type ModelPickerValue } from "./ModelPicker.tsx";
import { ScheduledTasksPane } from "./ScheduledTasksPane.tsx";

const SECTIONS: Array<{ id: AgentPanelSection; label: string; icon: IconName }> = [
  { id: "profile", label: "Profile", icon: "user" },
  { id: "tasks", label: "Scheduled tasks", icon: "clock" },
];

/** Dedicated slide-over panel for creating, editing, and managing one agent. */
export function AgentPanel({ view }: { view: AgentPanelView }) {
  const dialog = useRef<HTMLDivElement>(null);
  const agents = useStore((s) => s.agents);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const agent = view.mode === "edit" ? (agents.find((a) => a.id === view.agentId) ?? null) : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeAgentPanel();
    };
    document.addEventListener("keydown", onKey);
    if (view.mode === "edit") dialog.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [view.mode]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const flashNotice = (text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 1800);
  };

  if (view.mode === "edit" && !agent) return null;

  const title = agent ? agent.name : "New agent";
  const subtitle = agent ? (agent.isDefault ? `${agent.harnessLabel} · Default agent` : agent.harnessLabel) : null;

  return (
    <div
      className="drawer-scrim"
      onPointerDown={(event) => event.target === event.currentTarget && closeAgentPanel()}
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={agent ? `${agent.name} settings` : "New agent"}
        tabIndex={-1}
        ref={dialog}
      >
        <header className="drawer-head">
          <div className="drawer-title">
            {agent && (
              <span className="agent-badge panel-badge" aria-hidden="true">
                {agentInitial(agent.name)}
              </span>
            )}
            <div className="drawer-title-text">
              <h2>{title}</h2>
              {subtitle && <p className="drawer-sub">{subtitle}</p>}
            </div>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={closeAgentPanel}
            aria-label="Close agent panel"
          >
            <Icon name="close" />
          </button>
        </header>

        {view.mode === "edit" && (
          <nav className="drawer-tabs" aria-label="Agent sections">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                type="button"
                className={view.section === section.id ? "active" : ""}
                aria-current={view.section === section.id ? "page" : undefined}
                onClick={() => openAgentPanel({ mode: "edit", agentId: view.agentId, section: section.id })}
              >
                <Icon name={section.icon} size={15} />
                {section.label}
              </button>
            ))}
          </nav>
        )}

        {(view.mode === "create" || view.section === "profile") && (
          <AgentProfileForm
            key={agent?.id ?? "new"}
            agent={agent}
            notice={notice}
            onSaved={(saved, created) => {
              flashNotice(created ? "Created" : "Saved");
              if (created) {
                chooseAgent(saved.id);
                openAgentPanel({ mode: "edit", agentId: saved.id, section: "profile" });
              }
            }}
            onDeleted={closeAgentPanel}
          />
        )}

        {view.mode === "edit" && view.section === "tasks" && agent && (
          <ScheduledTasksPane key={agent.id} agent={agent} />
        )}
      </div>
    </div>
  );
}

function AgentProfileForm({
  agent,
  notice,
  onSaved,
  onDeleted,
}: {
  agent: AgentSummary | null;
  notice: string | null;
  onSaved: (agent: AgentSummary, created: boolean) => void;
  onDeleted: () => void;
}) {
  const harnesses = useHarnesses();
  const models = useStore((s) => s.models);
  const agentId = agent?.id ?? null;
  const threadCount = useStore((s) => (agentId ? s.threads.filter((t) => t.agentId === agentId).length : 0));

  const defaultHarness =
    agent?.harness ?? (harnesses.some((h) => h.id === "codex") ? "codex" : (harnesses[0]?.id ?? "codex"));

  const [name, setName] = useState(agent?.name ?? "");
  const [harness, setHarness] = useState(defaultHarness);
  const [model, setModel] = useState<string | null>(agent?.model ?? null);
  const [effort, setEffort] = useState<string | null>(agent?.effort ?? null);
  const [fast, setFast] = useState(agent?.fast ?? false);
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [busy, setBusy] = useState(false);

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRoot = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState<number | null>(null);

  useEffect(() => {
    void loadModels(harness);
  }, [harness]);

  useLayoutEffect(() => {
    if (!pickerOpen) return;
    const measure = () => {
      const box = pickerRoot.current?.getBoundingClientRect();
      if (!box) return;
      setRoom(Math.max(220, window.innerHeight - box.bottom - 80));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    void loadModels(harness);
    const onDown = (event: PointerEvent) => {
      if (!pickerRoot.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [pickerOpen, harness]);

  const info = harnesses.find((h) => h.id === harness);
  const list = models[harness];
  const defaultModel = list?.status === "ready" ? list.list.find((m) => m.isDefault) : undefined;
  const resolvedModel = modelName(models, harness, model) ?? (defaultModel ? `Default · ${defaultModel.name}` : "Provider's default");
  const summaryParts = [
    info?.label ?? harness,
    resolvedModel,
    effort ? effortName(effort) : null,
    fast ? "Fast" : null,
  ].filter(Boolean);

  const applyChoice = (change: Partial<ModelPickerValue>) => {
    if (change.harness !== undefined) setHarness(change.harness);
    if (change.model !== undefined) setModel(change.model);
    if (change.effort !== undefined) setEffort(change.effort);
    if (change.fast !== undefined) setFast(change.fast);
  };

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
    const created = agent === null;
    const result = await saveAgent(agent?.id ?? null, { name, harness, model, effort, fast, instructions });
    setBusy(false);
    if (result) onSaved(result, created);
  };

  const remove = async () => {
    if (!agent) return;
    const what =
      threadCount > 0
        ? `Delete ${agent.name} and its ${threadCount} thread${threadCount === 1 ? "" : "s"}? Its workspace moves to Staf's trash folder.`
        : `Delete ${agent.name}? Its workspace moves to Staf's trash folder.`;
    if (!confirm(what)) return;
    setBusy(true);
    const removed = await removeAgent(agent.id);
    setBusy(false);
    if (removed) onDeleted();
  };

  return (
    <form
      className="drawer-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="drawer-scroll">
        <label className="field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example, Paper"
            maxLength={60}
            autoFocus={!agent}
            required
          />
        </label>

        <div className="field">
          <span>Default model</span>
          <div className="agent-model-picker" ref={pickerRoot}>
            <button
              type="button"
              className={`model-trigger${pickerOpen ? " open" : ""}`}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
            >
              <span className="model-trigger-label">
                <span>{summaryParts.join(" · ")}</span>
                {info?.experimental && <span className="tag">Experimental</span>}
              </span>
              <span className="model-trigger-chevron" aria-hidden="true">
                <Icon name="down" size={15} />
              </span>
            </button>
            {pickerOpen && (
              <div
                className="menu wide down agent-model-menu"
                role="menu"
                style={room ? { maxHeight: Math.min(460, room) } : undefined}
              >
                <ModelPickerPanel
                  value={{ harness, model, effort, fast }}
                  harnesses={harnesses}
                  models={models}
                  allowUnreadyProviders
                  onChange={applyChoice}
                  footer={
                    <div className="menu-footer-row">
                      <button
                        type="button"
                        className="menu-footer-link"
                        onClick={() => {
                          setPickerOpen(false);
                          openSettings({ section: "providers" });
                        }}
                      >
                        <Icon name="settings" size={14} />
                        Provider settings
                      </button>
                      <button type="button" className="menu-footer-done" onClick={() => setPickerOpen(false)}>
                        Done
                      </button>
                    </div>
                  }
                />
              </div>
            )}
          </div>
          {!pickerOpen && list?.status === "error" && <p className="field-note error model-note">{list.error}</p>}
        </div>

        <label className="field">
          <span>Instructions</span>
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={10}
            placeholder="Who is this agent, and how should it answer?"
          />
        </label>

        {agent && <AccessSummary agent={agent} />}
      </div>

      <footer className="drawer-foot">
        {agent && !agent.isDefault && (
          <button type="button" className="button danger" onClick={() => void remove()} disabled={busy}>
            Delete
          </button>
        )}
        <span className="spacer" />
        {notice && <span className="saved">{notice}</span>}
        <button type="submit" className="button primary" disabled={busy || !changed || !name.trim()}>
          {agent ? "Save" : "Create agent"}
        </button>
      </footer>
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
