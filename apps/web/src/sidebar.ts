import type { ThreadSummary } from "@staf/protocol";

/**
 * The agent that the sidebar highlights and filters by: the open conversation's agent,
 * or the agent chosen for new chats when no conversation is open.
 */
export function activeAgentId(
  threads: ThreadSummary[],
  threadId: string | null,
  selectedAgentId: string,
): string {
  if (!threadId) return selectedAgentId;
  return threads.find((thread) => thread.id === threadId)?.agentId ?? selectedAgentId;
}

/** Conversations to show in the sidebar: either every conversation or only one agent's. */
export function visibleThreads(
  threads: ThreadSummary[],
  agentId: string,
  showAll: boolean,
): ThreadSummary[] {
  if (showAll) return threads;
  return threads.filter((thread) => thread.agentId === agentId);
}

/** Agent IDs that currently have a conversation answering. */
export function runningAgents(threads: ThreadSummary[]): Set<string> {
  const running = new Set<string>();
  for (const thread of threads) {
    if (thread.status === "running") running.add(thread.agentId);
  }
  return running;
}

/** First character of an agent's name, used in the compact sidebar badge. */
export function agentInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0];
  return first ? first.toUpperCase() : "?";
}

/** Groups conversations into recency buckets, omitting buckets that are empty. */
export function groupThreads(
  threads: ThreadSummary[],
  now: number = Date.now(),
): Array<[string, ThreadSummary[]]> {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const day = 24 * 60 * 60 * 1000;
  const buckets: Array<[string, ThreadSummary[]]> = [
    ["Today", []],
    ["Yesterday", []],
    ["Previous 7 days", []],
    ["Older", []],
  ];
  for (const thread of threads) {
    const t = thread.updatedAt;
    const index =
      t >= startOfToday ? 0 : t >= startOfToday - day ? 1 : t >= startOfToday - 7 * day ? 2 : 3;
    buckets[index]![1].push(thread);
  }
  return buckets.filter(([, items]) => items.length > 0);
}
