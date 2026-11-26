import {
  MAX_MEMORY_LIMIT,
  MAX_NUDGE_INTERVAL,
  MIN_MEMORY_LIMIT,
  type AgentSummary,
  type MemoryBlock,
  type MemoryEntry,
} from "@staf/protocol";
import { useEffect, useState } from "react";
import {
  addMemory,
  closeAgentPanel,
  editMemory,
  loadAgentMemory,
  openThread,
  removeMemory,
  saveAgentMemorySettings,
  useAgentMemory,
} from "../store.ts";
import { Icon } from "./Icon.tsx";
import { MemoryProposalCard } from "./MemoryProposals.tsx";

const BLOCKS: Array<{ id: MemoryBlock; title: string; hint: string; placeholder: string }> = [
  {
    id: "profile",
    title: "Profile",
    hint: "What this agent knows about you: preferences, routines, people, and places.",
    placeholder: "For example: Prefers morning flights and direct routes.",
  },
  {
    id: "notes",
    title: "Notes",
    hint: "What this agent learned about its work: how tasks are done, where things live, and what to avoid.",
    placeholder: "For example: Keep the morning briefing under 2 pages.",
  },
];

export function MemoryPane({ agent }: { agent: AgentSummary }) {
  const snapshot = useAgentMemory(agent.id);
  const [notesLimit, setNotesLimit] = useState(String(agent.memory.notesLimit));
  const [profileLimit, setProfileLimit] = useState(String(agent.memory.profileLimit));
  const [nudgeInterval, setNudgeInterval] = useState(String(agent.memory.nudgeInterval));
  const [savingLimits, setSavingLimits] = useState(false);
  const [limitsSaved, setLimitsSaved] = useState(false);

  useEffect(() => {
    void loadAgentMemory(agent.id);
  }, [agent.id]);

  useEffect(() => {
    setNotesLimit(String(agent.memory.notesLimit));
    setProfileLimit(String(agent.memory.profileLimit));
    setNudgeInterval(String(agent.memory.nudgeInterval));
  }, [agent.memory.notesLimit, agent.memory.profileLimit, agent.memory.nudgeInterval]);

  const openSourceThread = (threadId: string) => {
    closeAgentPanel();
    openThread(threadId);
  };

  const limitsChanged =
    Number(notesLimit) !== agent.memory.notesLimit ||
    Number(profileLimit) !== agent.memory.profileLimit ||
    Number(nudgeInterval) !== agent.memory.nudgeInterval;

  const saveLimits = async (event: React.FormEvent) => {
    event.preventDefault();
    setSavingLimits(true);
    setLimitsSaved(false);
    const ok = await saveAgentMemorySettings(agent.id, {
      notesLimit: Number(notesLimit),
      profileLimit: Number(profileLimit),
      nudgeInterval: Number(nudgeInterval),
    });
    setSavingLimits(false);
    if (ok) {
      setLimitsSaved(true);
      window.setTimeout(() => setLimitsSaved(false), 1800);
    }
  };

  return (
    <div className="drawer-scroll memory-pane">
      <p className="tasks-intro">
        Saved memory belongs only to {agent.name} and follows it across providers. Entries are copied into each new
        conversation when it starts.
      </p>

      {snapshot && snapshot.proposed.length > 0 && (
        <section className="memory-section">
          <div className="memory-section-head">
            <h3>
              Pending proposals <span className="sidebar-count">{snapshot.proposed.length}</span>
            </h3>
          </div>
          <div className="proposal-list">
            {snapshot.proposed.map((proposal) => (
              <MemoryProposalCard key={proposal.id} proposal={proposal} onOpenThread={openSourceThread} />
            ))}
          </div>
        </section>
      )}

      {BLOCKS.map((block) => {
        const usage = snapshot?.usage[block.id] ?? {
          used: 0,
          limit: block.id === "notes" ? agent.memory.notesLimit : agent.memory.profileLimit,
          count: 0,
        };
        const entries = snapshot ? snapshot.active.filter((e) => e.block === block.id) : [];
        return (
          <MemoryBlockSection
            key={block.id}
            agentId={agent.id}
            block={block}
            used={usage.used}
            limit={usage.limit}
            entries={entries}
          />
        );
      })}

      <details className="access memory-limits">
        <summary>Limits and reminders</summary>
        <form className="memory-limits-form" onSubmit={(e) => void saveLimits(e)}>
          <div className="memory-limits-grid">
            <label className="field">
              <span>Profile limit (chars)</span>
              <input
                type="number"
                min={MIN_MEMORY_LIMIT}
                max={MAX_MEMORY_LIMIT}
                value={profileLimit}
                onChange={(e) => setProfileLimit(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Notes limit (chars)</span>
              <input
                type="number"
                min={MIN_MEMORY_LIMIT}
                max={MAX_MEMORY_LIMIT}
                value={notesLimit}
                onChange={(e) => setNotesLimit(e.target.value)}
                required
              />
            </label>
            <label className="field">
              <span>Reminder every N messages</span>
              <input
                type="number"
                min={0}
                max={MAX_NUDGE_INTERVAL}
                value={nudgeInterval}
                onChange={(e) => setNudgeInterval(e.target.value)}
                required
              />
            </label>
          </div>
          <p className="field-note">
            Set the reminder interval to 0 to turn off periodic memory reminders during chats.
          </p>
          <div className="memory-limits-actions">
            {limitsSaved && <span className="saved">Saved</span>}
            <button type="submit" className="button primary" disabled={savingLimits || !limitsChanged}>
              Save limits
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}

function MemoryBlockSection({
  agentId,
  block,
  used,
  limit,
  entries,
}: {
  agentId: string;
  block: { id: MemoryBlock; title: string; hint: string; placeholder: string };
  used: number;
  limit: number;
  entries: MemoryEntry[];
}) {
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState(false);

  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const nearFull = ratio >= 0.85;

  const submitAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newText.trim()) return;
    setBusy(true);
    const ok = await addMemory(agentId, block.id, newText);
    setBusy(false);
    if (ok) {
      setNewText("");
      setAdding(false);
    }
  };

  return (
    <section className="memory-block">
      <div className="memory-block-head">
        <div>
          <h3>{block.title}</h3>
          <p className="memory-block-hint">{block.hint}</p>
        </div>
        <button
          type="button"
          className="task-btn"
          onClick={() => setAdding((v) => !v)}
          aria-label={`Add ${block.title.toLowerCase()} memory`}
        >
          <Icon name="plus" size={13} />
          Add
        </button>
      </div>

      <div className="memory-meter-row">
        <div className="memory-meter" aria-hidden="true">
          <div className={`memory-meter-fill${nearFull ? " warn" : ""}`} style={{ width: `${ratio * 100}%` }} />
        </div>
        <span className={`memory-usage${nearFull ? " warn" : ""}`}>
          {used.toLocaleString("en-US")} / {limit.toLocaleString("en-US")} chars
        </span>
      </div>

      {adding && (
        <form className="memory-add-form" onSubmit={(e) => void submitAdd(e)}>
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            placeholder={block.placeholder}
            rows={2}
            autoFocus
          />
          <div className="memory-entry-actions">
            <button type="submit" className="button primary proposal-btn" disabled={busy || !newText.trim()}>
              Save
            </button>
            <button
              type="button"
              className="button proposal-btn"
              disabled={busy}
              onClick={() => {
                setAdding(false);
                setNewText("");
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {entries.length === 0 ? (
        <p className="memory-empty">Nothing saved in {block.title} yet.</p>
      ) : (
        <ul className="memory-list">
          {entries.map((entry) => (
            <MemoryEntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MemoryEntryRow({ entry }: { entry: MemoryEntry }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!draft.trim()) return;
    setBusy(true);
    const ok = await editMemory(entry, draft);
    setBusy(false);
    if (ok) setEditing(false);
  };

  const remove = async () => {
    setBusy(true);
    await removeMemory(entry);
    setBusy(false);
  };

  return (
    <li className={`memory-entry${entry.flaggedReason ? " flagged" : ""}`}>
      {editing ? (
        <div className="memory-edit-box">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus />
          <div className="memory-entry-actions">
            <button type="button" className="button primary proposal-btn" disabled={busy || !draft.trim()} onClick={() => void save()}>
              Save
            </button>
            <button
              type="button"
              className="button proposal-btn"
              disabled={busy}
              onClick={() => {
                setDraft(entry.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="memory-entry-body">
            <p className="memory-entry-text">{entry.text}</p>
            {entry.flaggedReason && (
              <p className="memory-flag-note">
                <Icon name="alert" size={13} />
                <span>Withheld from model: {entry.flaggedReason}</span>
              </p>
            )}
          </div>
          <div className="memory-row-tools">
            <button
              type="button"
              className="icon-button small"
              aria-label="Edit memory"
              title="Edit"
              disabled={busy}
              onClick={() => {
                setDraft(entry.text);
                setEditing(true);
              }}
            >
              <Icon name="edit" size={14} />
            </button>
            <button
              type="button"
              className="icon-button small"
              aria-label="Delete memory"
              title="Delete"
              disabled={busy}
              onClick={() => void remove()}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        </>
      )}
    </li>
  );
}
