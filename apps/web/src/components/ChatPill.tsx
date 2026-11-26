import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  choose,
  effortName,
  loadModels,
  modelName,
  openSettings,
  useHarnesses,
  useStore,
} from "../store.ts";
import { Icon } from "./Icon.tsx";
import { EffortPicker, FastSwitch, ModelPickerPanel } from "./ModelPicker.tsx";

export { EffortPicker, FastSwitch };

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
        <div
          className={`menu wide ${direction}`}
          role="menu"
          style={room ? { maxHeight: Math.min(560, room) } : undefined}
        >
          <ModelPickerPanel
            value={{ harness: harnessId, model, effort, fast }}
            harnesses={harnesses}
            models={models}
            switching={thread !== null}
            onChange={(change) => void choose(change)}
            footer={
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
            }
          />
        </div>
      )}
    </div>
  );
}
