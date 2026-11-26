import { memoryBlockLabel, type MemoryEntry } from "@staf/protocol";
import { useState } from "react";
import { approveMemoryProposal, rejectMemoryProposal } from "../store.ts";
import { Icon } from "./Icon.tsx";

const ACTION_LABEL: Record<string, string> = {
  add: "Add",
  replace: "Update",
  remove: "Remove",
};

export function MemoryProposalCard({
  proposal,
  onOpenThread,
}: {
  proposal: MemoryEntry;
  onOpenThread?: (threadId: string) => void;
}) {
  const action = proposal.proposedAction ?? "add";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(proposal.text);
  const [busy, setBusy] = useState(false);

  const sourceThreadId =
    proposal.source.kind === "schedule" || proposal.source.kind === "thread" ? proposal.source.threadId : null;

  const approve = async () => {
    setBusy(true);
    const ok = await approveMemoryProposal(proposal, editing ? { text: draft } : undefined);
    setBusy(false);
    if (ok) setEditing(false);
  };

  const reject = async () => {
    setBusy(true);
    await rejectMemoryProposal(proposal);
    setBusy(false);
  };

  return (
    <article className="proposal-card">
      <div className="proposal-head">
        <span className="proposal-title">
          <Icon name="bookmark" size={14} />
          <span>Memory proposal</span>
          <span className="proposal-pill">{ACTION_LABEL[action] ?? "Add"}</span>
          <span className="proposal-pill subtle">{memoryBlockLabel(proposal.block)}</span>
        </span>
        {onOpenThread && sourceThreadId && (
          <button type="button" className="link proposal-link" onClick={() => onOpenThread(sourceThreadId)}>
            Open thread
          </button>
        )}
      </div>

      {proposal.targetText && (action === "replace" || action === "remove") && (
        <p className="proposal-old">
          <span className="proposal-diff-label">{action === "remove" ? "Removing:" : "Current:"}</span>{" "}
          {proposal.targetText}
        </p>
      )}

      {action !== "remove" &&
        (editing ? (
          <textarea
            className="proposal-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            autoFocus
          />
        ) : (
          <p className="proposal-text">{proposal.text}</p>
        ))}

      {proposal.flaggedReason && (
        <div className="notice error proposal-flag">
          <Icon name="alert" size={15} />
          <span>{proposal.flaggedReason}</span>
        </div>
      )}

      <div className="proposal-actions">
        <button
          type="button"
          className="button primary proposal-btn"
          disabled={busy || (editing && !draft.trim())}
          onClick={() => void approve()}
        >
          <Icon name="check" size={13} />
          {editing ? "Approve edit" : action === "remove" ? "Approve removal" : "Approve"}
        </button>
        {action !== "remove" &&
          (editing ? (
            <button
              type="button"
              className="button proposal-btn"
              disabled={busy}
              onClick={() => {
                setDraft(proposal.text);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              className="button proposal-btn"
              disabled={busy}
              onClick={() => {
                setDraft(proposal.text);
                setEditing(true);
              }}
            >
              <Icon name="edit" size={13} />
              Edit
            </button>
          ))}
        <button type="button" className="button proposal-btn" disabled={busy} onClick={() => void reject()}>
          Reject
        </button>
      </div>
    </article>
  );
}
