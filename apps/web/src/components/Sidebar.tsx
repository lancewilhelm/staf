import { useState } from "react";
import { activeAgentId, agentInitial, groupThreads, runningAgents, visibleThreads } from "../sidebar.ts";
import { deleteThread, openSettings, openThread, startChat, useStore } from "../store.ts";
import { Icon } from "./Icon.tsx";

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const threads = useStore((s) => s.threads);
  const current = useStore((s) => s.threadId);
  const agents = useStore((s) => s.agents);
  const selectedAgent = useStore((s) => s.agentId);
  const [showAll, setShowAll] = useState(false);

  const currentAgentId = activeAgentId(threads, current, selectedAgent);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId) ?? null;
  const showingAll = showAll && agents.length > 1;
  const shownThreads = visibleThreads(threads, currentAgentId, showingAll);
  const running = runningAgents(threads);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));

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
              openSettings({ section: "agents", agentId: "new" });
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
                    openSettings({ section: "agents", agentId: agent.id });
                  }}
                >
                  <Icon name="edit" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <nav className="thread-list" aria-label="Conversations">
        <div className="sidebar-section-head">
          <h2>Conversations</h2>
          {agents.length > 1 && (
            <button
              type="button"
              className={`sidebar-filter${showingAll ? " active" : ""}`}
              aria-pressed={showingAll}
              onClick={() => setShowAll((value) => !value)}
              title={
                showingAll
                  ? `Show only ${currentAgent?.name ?? "this agent"}'s conversations`
                  : "Show conversations from all agents"
              }
            >
              All agents
            </button>
          )}
        </div>
        {shownThreads.length === 0 ? (
          <p className="thread-empty">
            {!showingAll && currentAgent && agents.length > 1
              ? `No conversations with ${currentAgent.name} yet.`
              : "No conversations yet."}
          </p>
        ) : (
          groupThreads(shownThreads).map(([label, items]) => (
            <section key={label}>
              <h3>{label}</h3>
              {items.map((thread) => {
                const owner = showingAll ? agentNames.get(thread.agentId) : undefined;
                return (
                  <div key={thread.id} className={`thread-row${thread.id === current ? " active" : ""}`}>
                    <button type="button" className="thread-link" onClick={() => go(thread.id)}>
                      {thread.status === "running" && <span className="live-dot" aria-label="Answering" />}
                      <span className="thread-meta">
                        <span className="thread-title">{thread.title}</span>
                        {owner && <span className="thread-agent">{owner}</span>}
                      </span>
                    </button>
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
                  </div>
                );
              })}
            </section>
          ))
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
