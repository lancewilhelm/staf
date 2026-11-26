import type { ThreadSummary } from "@staf/protocol";
import { useEffect, useState } from "react";
import {
  activeAgentId,
  agentInitial,
  groupThreads,
  partitionThreads,
  runningAgents,
  threadTimeLabel,
  visibleThreads,
} from "../sidebar.ts";
import { deleteThread, openAgentPanel, openSettings, openThread, settleThread, startChat, useStore } from "../store.ts";
import { Icon } from "./Icon.tsx";

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const threads = useStore((s) => s.threads);
  const current = useStore((s) => s.threadId);
  const agents = useStore((s) => s.agents);
  const selectedAgent = useStore((s) => s.agentId);
  const sidebarMode = useStore((s) => s.preferences.sidebarMode);
  const [showAll, setShowAll] = useState(false);
  const [settledOpen, setSettledOpen] = useState(false);

  const currentAgentId = activeAgentId(threads, current, selectedAgent);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId) ?? null;
  const showingAll = showAll && agents.length > 1;
  const shownThreads = visibleThreads(threads, currentAgentId, showingAll);
  const { working, main, settled } = partitionThreads(shownThreads, sidebarMode);
  const running = runningAgents(threads);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const isInboxMode = sidebarMode === "inbox";
  const now = useNow(shownThreads.some((thread) => thread.status === "running") ? 1000 : 30_000);

  const go = (id: string) => {
    openThread(id);
    onClose();
  };

  const newChat = () => {
    startChat();
    onClose();
  };

  const pickAgent = (agentId: string) => {
    startChat(agentId);
    setShowAll(false);
    onClose();
  };

  const emptyMainText = (() => {
    if (isInboxMode && (settled.length > 0 || working.length > 0)) {
      return !showingAll && currentAgent && agents.length > 1
        ? `Inbox is clear for ${currentAgent.name}.`
        : "Inbox is clear.";
    }
    return !showingAll && currentAgent && agents.length > 1
      ? `No threads with ${currentAgent.name} yet.`
      : "No threads yet.";
  })();

  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="sidebar-head">
        <span className="wordmark">Staf</span>
        <button type="button" className="icon-button" onClick={newChat} aria-label="New chat" title="New chat">
          <Icon name="plus" />
        </button>
      </div>

      <section className="sidebar-agents" aria-label="Agents">
        <div className="sidebar-section-head">
          <h2>Agents</h2>
          <button
            type="button"
            className="sidebar-action"
            onClick={() => {
              onClose();
              openAgentPanel({ mode: "create" });
            }}
            aria-label="New agent"
            title="New agent"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        <div className="agent-nav">
          {agents.map((agent) => {
            const isCurrent = agent.id === currentAgentId;
            return (
              <div key={agent.id} className={`agent-row${isCurrent ? " active" : ""}`}>
                <button
                  type="button"
                  className="agent-link"
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => pickAgent(agent.id)}
                >
                  <span className="agent-badge" aria-hidden="true">
                    {agentInitial(agent.name)}
                  </span>
                  <span className="agent-row-name">{agent.name}</span>
                  {running.has(agent.id) && <span className="live-dot" aria-label="Answering" />}
                </button>
                <button
                  type="button"
                  className="agent-edit"
                  aria-label={`Edit ${agent.name}`}
                  title={`Edit ${agent.name}`}
                  onClick={() => {
                    onClose();
                    openAgentPanel({ mode: "edit", agentId: agent.id, section: "profile" });
                  }}
                >
                  <Icon name="edit" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <nav className="thread-list" aria-label={isInboxMode ? "Inbox" : "Threads"}>
        <div className="thread-list-main">
          <div className="sidebar-section-head">
            <h2>
              {isInboxMode ? "Inbox" : "Threads"}
              {isInboxMode && main.length > 0 && <span className="sidebar-count">{main.length}</span>}
            </h2>
            {agents.length > 1 && (
              <button
                type="button"
                className={`sidebar-filter${showingAll ? " active" : ""}`}
                aria-pressed={showingAll}
                onClick={() => setShowAll((value) => !value)}
                title={
                  showingAll
                    ? `Show only ${currentAgent?.name ?? "this agent"}'s threads`
                    : "Show threads from all agents"
                }
              >
                All agents
              </button>
            )}
          </div>

          {main.length === 0 ? (
            <p className="thread-empty">{emptyMainText}</p>
          ) : isInboxMode ? (
            main.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                active={thread.id === current}
                owner={showingAll ? agentNames.get(thread.agentId) : undefined}
                showSettle
                now={now}
                onOpen={go}
              />
            ))
          ) : (
            groupThreads(main, now).map(([label, items]) => (
              <section key={label}>
                <h3>{label}</h3>
                {items.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === current}
                    owner={showingAll ? agentNames.get(thread.agentId) : undefined}
                    showSettle={false}
                    now={now}
                    onOpen={go}
                  />
                ))}
              </section>
            ))
          )}
        </div>

        {isInboxMode && (working.length > 0 || settled.length > 0) && (
          <div className="sidebar-bottom-dock">
            {working.length > 0 && (
              <section className="sidebar-working-block" aria-label="Working">
                <div className="sidebar-section-head">
                  <h2>
                    Working <span className="sidebar-count">{working.length}</span>
                  </h2>
                </div>
                {working.map((thread) => (
                  <ThreadRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === current}
                    owner={showingAll ? agentNames.get(thread.agentId) : undefined}
                    showSettle={false}
                    now={now}
                    onOpen={go}
                  />
                ))}
              </section>
            )}

            {settled.length > 0 && (
              <section className="settled-group">
                <button
                  type="button"
                  className={`settled-toggle${settledOpen ? " open" : ""}`}
                  aria-expanded={settledOpen}
                  onClick={() => setSettledOpen((value) => !value)}
                >
                  <span className="chevron" aria-hidden="true">
                    <Icon name="chevron" size={13} />
                  </span>
                  <span>Settled</span>
                  <span className="sidebar-count">{settled.length}</span>
                </button>
                {settledOpen && (
                  <div className="settled-list">
                    {settled.map((thread) => (
                      <ThreadRow
                        key={thread.id}
                        thread={thread}
                        active={thread.id === current}
                        owner={showingAll ? agentNames.get(thread.agentId) : undefined}
                        showSettle
                        muted
                        now={now}
                        onOpen={go}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="sidebar-button"
          onClick={() => {
            onClose();
            openSettings();
          }}
        >
          <Icon name="settings" size={17} />
          Settings
        </button>
      </div>
    </aside>
  );
}

function ThreadRow({
  thread,
  active,
  owner,
  showSettle,
  muted,
  now,
  onOpen,
}: {
  thread: ThreadSummary;
  active: boolean;
  owner?: string;
  showSettle: boolean;
  muted?: boolean;
  now: number;
  onOpen: (id: string) => void;
}) {
  const isSettled = thread.settledAt !== null;
  const isRunning = thread.status === "running";
  return (
    <div className={`thread-row${active ? " active" : ""}${muted ? " settled" : ""}`}>
      <button type="button" className="thread-link" onClick={() => onOpen(thread.id)}>
        {isRunning && <span className="live-dot" aria-label="Answering" />}
        {thread.source === "schedule" && (
          <span className="schedule-mark" title="Scheduled task" aria-label="Scheduled task">
            <Icon name="clock" size={13} />
          </span>
        )}
        <span className="thread-meta">
          <span className="thread-title">{thread.title}</span>
          {owner && <span className="thread-agent">{owner}</span>}
        </span>
        {(thread.pendingProposals ?? 0) > 0 && (
          <span
            className="thread-proposal-badge"
            title={`${thread.pendingProposals} memory proposal${thread.pendingProposals === 1 ? "" : "s"} waiting`}
            aria-label={`${thread.pendingProposals} memory proposal${thread.pendingProposals === 1 ? "" : "s"} waiting`}
          >
            <Icon name="bookmark" size={11} />
            {thread.pendingProposals}
          </span>
        )}
        <span
          className={`thread-time${isRunning ? " working" : ""}`}
          title={isRunning ? "Working for" : "Last activity"}
        >
          {threadTimeLabel(thread, now)}
        </span>
      </button>
      <span className="thread-actions">
        {showSettle && (
          <button
            type="button"
            className="thread-action"
            aria-label={isSettled ? `Move "${thread.title}" to Inbox` : `Settle "${thread.title}"`}
            title={isSettled ? "Move to Inbox" : "Settle"}
            onClick={() => void settleThread(thread.id, !isSettled)}
          >
            <Icon name={isSettled ? "inbox" : "check"} size={14} />
          </button>
        )}
        <button
          type="button"
          className="thread-delete"
          aria-label={`Delete "${thread.title}"`}
          title="Delete"
          onClick={() => {
            if (confirm(`Delete "${thread.title}"?`)) void deleteThread(thread.id);
          }}
        >
          <Icon name="trash" size={15} />
        </button>
      </span>
    </div>
  );
}

/** The current time, refreshed on an interval so that relative labels stay current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
