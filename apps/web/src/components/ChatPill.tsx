import type { HarnessInfo } from "@staf/protocol";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { chooseAgent, chooseHarnessModel, loadModels, modelName, openSettings, useStore } from "../store.ts";
import { Icon } from "./Icon.tsx";

/**
 * The small pill under the composer. It shows who answers (agent, harness, model) and
 * opens a menu to change it: the agent for a new chat, and the harness and model for this
 * conversation.
 */
export function ChatPill({ direction }: { direction: "up" | "down" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const thread = useStore((s) => s.threads.find((t) => t.id === s.threadId) ?? null);
  const agents = useStore((s) => s.agents);
  const agentId = useStore((s) => s.agentId);
  const draft = useStore((s) => s.draft);
  const harnesses = useStore((s) => s.health?.harnesses ?? []);
  const models = useStore((s) => s.models);

  const agent = agents.find((a) => a.id === (thread?.agentId ?? agentId)) ?? null;
  const harnessId = thread?.harness ?? draft.harness ?? agent?.harness ?? "codex";
  const model = thread ? thread.model : draft.model !== undefined ? draft.model : (agent?.model ?? null);
  const harness = harnesses.find((h) => h.id === harnessId) ?? null;
  const running = thread?.status === "running";

  useEffect(() => {
    // Model names for the label come from the list, so load it once.
    if (model) void loadModels(harnessId);
  }, [harnessId, model]);

  useEffect(() => {
    if (!open) return;
    void loadModels(harnessId);
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, harnessId]);

  const label = [agent?.name ?? "Staf", modelName(models, harnessId, model) ?? harness?.label ?? harnessId].join(" · ");
  const list = models[harnessId];
  const defaultModel = list?.status === "ready" ? list.list.find((m) => m.isDefault) : undefined;

  return (
    <div className="pill-root" ref={root}>
      <button
        type="button"
        className={`chat-pill${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={running}
        title={running ? "Wait for the answer to finish to change this" : "Choose the agent and model"}
      >
        <span>{label}</span>
        {harness?.experimental && <span className="tag">Experimental</span>}
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className={`menu ${direction}`} role="menu">
          {!thread && agents.length > 1 && (
            <section>
              <h3>Agent</h3>
              {agents.map((a) => (
                <MenuItem key={a.id} selected={a.id === agent?.id} onClick={() => chooseAgent(a.id)}>
                  {a.name}
                </MenuItem>
              ))}
            </section>
          )}
          <section>
            <h3>Provider</h3>
            {harnesses.map((h) => (
              <MenuItem
                key={h.id}
                selected={h.id === harnessId}
                disabled={!h.ready}
                hint={!h.ready ? (h.detail ?? "Not ready") : undefined}
                onClick={() => {
                  if (h.id !== harnessId) void chooseHarnessModel(h.id, null);
                }}
              >
                {h.label}
                {h.experimental && <span className="tag">Experimental</span>}
              </MenuItem>
            ))}
          </section>
          <section className="models">
            <h3>Model</h3>
            <MenuItem selected={model === null} onClick={() => void chooseHarnessModel(harnessId, null)}>
              Default{defaultModel ? <span className="muted"> · {defaultModel.name}</span> : null}
            </MenuItem>
            {list?.status === "loading" && <p className="menu-status">Loading models…</p>}
            {list?.status === "error" && <p className="menu-status error">{list.error}</p>}
            {list?.status === "ready" &&
              list.list.map((m) => (
                <MenuItem key={m.id} selected={m.id === model} onClick={() => void chooseHarnessModel(harnessId, m.id)}>
                  {m.name}
                </MenuItem>
              ))}
          </section>
          <ProviderNote harness={harness} switching={thread !== null} />
          <button
            type="button"
            className="menu-footer"
            onClick={() => {
              setOpen(false);
              openSettings({ section: "agents", agentId: agent?.id ?? null });
            }}
          >
            <Icon name="settings" size={15} />
            Edit agents
          </button>
        </div>
      )}
    </div>
  );
}

function ProviderNote({ harness, switching }: { harness: HarnessInfo | null; switching: boolean }) {
  if (!harness?.note && !switching) return null;
  return (
    <div className="menu-note">
      {harness?.note && <p>{harness.note}</p>}
      {switching && <p>A new provider gets the conversation so far as text, without the details of earlier steps.</p>}
    </div>
  );
}

function MenuItem({
  selected,
  disabled,
  hint,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`menu-item${selected ? " selected" : ""}`}
      disabled={disabled}
      title={hint}
      onClick={onClick}
    >
      <span className="menu-label">{children}</span>
      {selected && <Icon name="check" size={15} />}
    </button>
  );
}
