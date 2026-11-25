import { useState } from "react";
import { dismissError, openThread, useStore } from "../store.ts";
import { ChatView } from "./ChatView.tsx";
import { Icon } from "./Icon.tsx";
import { Sidebar } from "./Sidebar.tsx";

export function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const title = useStore((s) => s.threads.find((t) => t.id === s.threadId)?.title ?? null);

  return (
    <div className="app">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-button menu" onClick={() => setMenuOpen(true)} aria-label="Open conversations">
            <Icon name="menu" />
          </button>
          <span className="topbar-title">{title ?? ""}</span>
          <button type="button" className="icon-button menu" onClick={() => openThread(null)} aria-label="New chat">
            <Icon name="plus" />
          </button>
        </header>
        <Notices />
        <ChatView />
      </div>
    </div>
  );
}

function Notices() {
  const connection = useStore((s) => s.connection);
  const error = useStore((s) => s.error);
  const blocked = useStore((s) => s.health?.harnesses.find((h) => !h.ready) ?? null);

  return (
    <div className="notices">
      {connection === "offline" && <div className="pill">Reconnecting to Staf…</div>}
      {blocked && (
        <details className="notice warn">
          <summary>
            <Icon name="alert" size={16} />
            <span>{blocked.label} isn't connected yet.</span>
          </summary>
          <p>{blocked.detail}</p>
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
