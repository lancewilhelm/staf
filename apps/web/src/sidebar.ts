import type { SidebarMode, ThreadSummary } from "@staf/protocol";

export interface SidebarSections {
  /** Inbox mode only: threads that are answering right now. */
  working: ThreadSummary[];
  /** Inbox mode: idle threads that are not settled yet. Thread list mode: every thread. */
  main: ThreadSummary[];
  /** Inbox mode only: settled idle threads. */
  settled: ThreadSummary[];
}

/**
 * Splits visible threads into sidebar sections for the chosen sidebar mode.
 * - Inbox mode: running threads go to Working, idle threads that are not settled stay in the
 *   Inbox, and settled threads go to the collapsible Settled section.
 * - Thread list mode: every thread, manual or scheduled, running or idle, stays in one
 *   chronological list. Settling does not apply in this mode.
 */
export function partitionThreads(threads: ThreadSummary[], mode: SidebarMode): SidebarSections {
  if (mode === "list") return { working: [], main: threads, settled: [] };

  const working: ThreadSummary[] = [];
  const main: ThreadSummary[] = [];
  const settled: ThreadSummary[] = [];
  for (const thread of threads) {
    if (thread.status === "running") working.push(thread);
    else if (thread.settledAt !== null) settled.push(thread);
    else main.push(thread);
  }
  return { working, main, settled };
}

/**
 * The short time label on a sidebar row: how long a running thread has been working, or how
 * long ago an idle thread last changed.
 */
export function threadTimeLabel(thread: ThreadSummary, now: number): string {
  if (thread.status === "running") {
    return formatWorkingDuration(now - (thread.runningSince ?? thread.updatedAt));
  }
  return formatThreadAge(thread.updatedAt, now);
}

/** Compact elapsed time for a thread that is actively working, such as "24s", "3m", or "1h". */
export function formatWorkingDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Compact waiting age for an idle thread, such as "now", "4m", "2h", or "3d". */
export function formatThreadAge(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** Readable duration for in-thread progress and completed step summaries, such as "18s" or "2m 14s". */
export function formatElapsedVerbose(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

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
