import { useState } from "react";
import { dismissError, openSettings, startChat, useStore } from "../store.ts";
import { AgentPanel } from "./AgentPanel.tsx";
import { ChatView } from "./ChatView.tsx";
import { Icon } from "./Icon.tsx";
import { Settings } from "./Settings.tsx";
import { Sidebar } from "./Sidebar.tsx";

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const title = useStore((s) => s.threads.find((t) => t.id === s.threadId)?.title ?? null);
  const settings = useStore((s) => s.settings);
  const agentPanel = useStore((s) => s.agentPanel);

  return (
    <div className="app">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-button" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            <Icon name="menu" />
          </button>
          <span className="topbar-title">{title ?? "Staf"}</span>
          <button type="button" className="icon-button" onClick={() => startChat()} aria-label="New chat">
            <Icon name="plus" />
          </button>
        </header>
        <Notices />
        <ChatView />
      </div>
      {settings && <Settings view={settings} />}
      {agentPanel && <AgentPanel view={agentPanel} />}
    </div>
  );
}

function Notices() {
  const connection = useStore((s) => s.connection);
  const error = useStore((s) => s.error);
  // Only the harness that the next answer uses matters here; the others show in Settings.
  const blocked = useStore((s) => {
    const thread = s.threads.find((t) => t.id === s.threadId);
    const agent = s.agents.find((a) => a.id === (thread?.agentId ?? s.agentId));
    const id = thread?.harness ?? s.draft.harness ?? agent?.harness;
    return s.health?.harnesses.find((h) => h.id === id && !h.ready) ?? null;
  });

  return (
    <div className="notices">
      {connection === "offline" && <div className="pill">Reconnecting to Staf…</div>}
      {blocked && (
        <details className="notice warn">
          <summary>
            <Icon name="alert" size={16} />
            <span>{blocked.label} isn't connected yet.</span>
          </summary>
          <p>
            {blocked.detail}{" "}
            <button type="button" className="link" onClick={() => openSettings({ section: "providers" })}>
              Open settings
            </button>
          </p>
        </details>
      )}
      {error && (
        <div className="notice error">
          <Icon name="alert" size={16} />
          <span>{error}</span>
          <button type="button" className="icon-button small" onClick={dismissError} aria-label="Dismiss">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
