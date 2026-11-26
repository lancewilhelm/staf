import type { HarnessInfo, ModelInfo } from "@staf/protocol";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  choose,
  effortName,
  loadModels,
  modelInfo,
  modelName,
  openSettings,
  useHarnesses,
  useStore,
} from "../store.ts";
import { Icon } from "./Icon.tsx";

/**
 * The small pill under the composer. It shows which provider, model, reasoning level,
 * and fast mode answer, and opens a menu to change them for this conversation.
 */
export function ChatPill({ direction }: { direction: "up" | "down" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const thread = useStore((s) => s.threads.find((t) => t.id === s.threadId) ?? null);
  const agents = useStore((s) => s.agents);
  const agentId = useStore((s) => s.agentId);
  const draft = useStore((s) => s.draft);
  const harnesses = useHarnesses();
  const models = useStore((s) => s.models);

  const agent = agents.find((a) => a.id === (thread?.agentId ?? agentId)) ?? null;
  const harnessId = thread?.harness ?? draft.harness ?? agent?.harness ?? "codex";
  const model = thread ? thread.model : draft.model !== undefined ? draft.model : (agent?.model ?? null);
  const effort = thread ? thread.effort : draft.effort !== undefined ? draft.effort : (agent?.effort ?? null);
  const fast = thread ? thread.fast : (draft.fast ?? agent?.fast ?? false);
  const harness = harnesses.find((h) => h.id === harnessId) ?? null;
  const running = thread?.status === "running";
  const info = modelInfo(models, harnessId, model);

  useEffect(() => {
    // Model names for the label come from the list, so load it once.
    if (model || effort || fast) void loadModels(harnessId);
  }, [harnessId, model, effort, fast]);

  // The menu may not reach past the window, so its height follows the space beside the pill.
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = root.current?.getBoundingClientRect();
      if (!box) return;
      setRoom(Math.max(200, (direction === "up" ? box.top : window.innerHeight - box.bottom) - 16));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, direction]);

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

  const label = [
    modelName(models, harnessId, model) ?? harness?.label ?? harnessId,
    effort ? effortName(effort) : null,
    fast ? "Fast" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const list = models[harnessId];
  const defaultModel = list?.status === "ready" ? list.list.find((m) => m.isDefault) : undefined;

  /** Keeps the level and fast mode when the new model offers them. */
  const pickModel = (next: string | null) => {
    const nextInfo = modelInfo(models, harnessId, next);
    void choose({
      model: next,
      effort: effort && nextInfo?.efforts?.includes(effort) ? effort : null,
      fast: fast && nextInfo?.fast === true,
    });
  };

  return (
    <div className="pill-root" ref={root}>
      <button
        type="button"
        className={`chat-pill${open ? " open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={running}
        title={running ? "Wait for the answer to finish to change this" : "Choose the provider and model"}
      >
        <span>{label}</span>
        {harness?.experimental && <span className="tag">Experimental</span>}
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className={`menu wide ${direction}`} role="menu" style={room ? { maxHeight: Math.min(560, room) } : undefined}>
          <div className="menu-columns">
            <div className="menu-column">
              <section>
                <h3>Provider</h3>
                {harnesses.map((h) => (
                  <MenuItem
                    key={h.id}
                    selected={h.id === harnessId}
                    disabled={!h.ready}
                    hint={!h.ready ? (h.detail ?? "Not ready") : undefined}
                    onClick={() => {
                      if (h.id !== harnessId) void choose({ harness: h.id, model: null, effort: null, fast: false });
                    }}
                  >
                    {h.label}
                    {h.experimental && <span className="tag">Experimental</span>}
                  </MenuItem>
                ))}
              </section>
              <section className="models">
                <h3>Model</h3>
                <MenuItem selected={model === null} onClick={() => pickModel(null)}>
                  Default{defaultModel ? <span className="muted"> · {defaultModel.name}</span> : null}
                </MenuItem>
                {list?.status === "loading" && <p className="menu-status">Loading models…</p>}
                {list?.status === "error" && <p className="menu-status error">{list.error}</p>}
                {list?.status === "ready" &&
                  list.list.map((m) => (
                    <MenuItem key={m.id} selected={m.id === model} onClick={() => pickModel(m.id)}>
                      {m.name}
                    </MenuItem>
                  ))}
              </section>
            </div>
            <div className="menu-column side">
              {info?.efforts && (
                <section>
                  <h3>Reasoning</h3>
                  <EffortPicker info={info} value={effort} onChange={(next) => void choose({ effort: next })} />
                </section>
              )}
              {info?.fast && (
                <section>
                  <FastSwitch info={info} value={fast} onChange={(next) => void choose({ fast: next })} />
                </section>
              )}
              <ProviderNote harness={harness} switching={thread !== null} />
            </div>
          </div>
          <button
            type="button"
            className="menu-footer"
            onClick={() => {
              setOpen(false);
              openSettings({ section: "providers" });
            }}
          >
            <Icon name="settings" size={15} />
            Provider settings
          </button>
        </div>
      )}
    </div>
  );
}

/** A row of levels. "Default" names the model's own level when the harness reports it. */
export function EffortPicker({
  info,
  value,
  onChange,
}: {
  info: ModelInfo;
  value: string | null;
  onChange: (effort: string | null) => void;
}) {
  const levels = info.efforts ?? [];
  const current = value && levels.includes(value) ? value : null;
  return (
    <div className="segments" role="radiogroup" aria-label="Reasoning">
      <button
        type="button"
        role="radio"
        aria-checked={current === null}
        className={current === null ? "selected" : ""}
        title={info.defaultEffort ? `The model's default, ${effortName(info.defaultEffort)}` : "The model's default"}
        onClick={() => onChange(null)}
      >
        Default
      </button>
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          role="radio"
          aria-checked={current === level}
          className={current === level ? "selected" : ""}
          onClick={() => onChange(level)}
        >
          {effortName(level)}
        </button>
      ))}
    </div>
  );
}

/** The fast mode switch, with what it costs. */
export function FastSwitch({
  info,
  value,
  onChange,
}: {
  info: ModelInfo;
  value: boolean;
  onChange: (fast: boolean) => void;
}) {
  return (
    <button type="button" role="switch" aria-checked={value} className="toggle-row" onClick={() => onChange(!value)}>
      <span className="menu-label">
        Fast mode
        {info.fastNote && <span className="toggle-note">{info.fastNote}</span>}
      </span>
      <span className={`toggle${value ? " on" : ""}`} aria-hidden="true" />
    </button>
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
