import type { ThreadSummary } from "@staf/protocol";
import { deleteThread, openThread, useStore } from "../store.ts";
import { Icon } from "./Icon.tsx";

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const threads = useStore((s) => s.threads);
  const current = useStore((s) => s.threadId);

  const go = (id: string | null) => {
    openThread(id);
    onClose();
  };

  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="sidebar-head">
        <span className="wordmark">Staf</span>
        <button type="button" className="icon-button" onClick={() => go(null)} aria-label="New chat" title="New chat">
          <Icon name="plus" />
        </button>
      </div>
      <nav className="thread-list" aria-label="Conversations">
        {groups(threads).map(([label, items]) => (
          <section key={label}>
            <h2>{label}</h2>
            {items.map((thread) => (
              <div key={thread.id} className={`thread-row${thread.id === current ? " active" : ""}`}>
                <button type="button" className="thread-link" onClick={() => go(thread.id)}>
                  {thread.status === "running" && <span className="live-dot" aria-label="Answering" />}
                  <span className="thread-title">{thread.title}</span>
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
            ))}
          </section>
        ))}
      </nav>
    </aside>
  );
}

function groups(threads: ThreadSummary[]): Array<[string, ThreadSummary[]]> {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const buckets: Array<[string, ThreadSummary[]]> = [
    ["Today", []],
    ["Yesterday", []],
    ["Previous 7 days", []],
    ["Older", []],
  ];
  for (const thread of threads) {
    const t = thread.updatedAt;
    const index = t >= startOfToday ? 0 : t >= startOfToday - day ? 1 : t >= startOfToday - 7 * day ? 2 : 3;
    buckets[index]![1].push(thread);
  }
  return buckets.filter(([, items]) => items.length > 0);
}
