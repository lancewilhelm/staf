import {
  type Activity,
  type AgentSummary,
  type HealthInfo,
  type Message,
  StafClient,
  type StreamEvent,
  type ThreadSummary,
} from "@staf/protocol";
import { useSyncExternalStore } from "react";

export type Connection = "connecting" | "open" | "offline";

export interface State {
  /** The open thread, or null for a new chat. */
  threadId: string | null;
  threads: ThreadSummary[];
  /** Messages for each thread that has been opened. */
  messages: Record<string, Message[]>;
  health: HealthInfo | null;
  agents: AgentSummary[];
  /** The agent that a new chat goes to. */
  agentId: string;
  connection: Connection;
  /** The last error from an action, shown once to the person. */
  error: string | null;
}

export const api = new StafClient(location.origin);

let state: State = {
  threadId: threadFromPath(location.pathname),
  threads: [],
  messages: {},
  health: null,
  agents: [],
  agentId: readSavedAgent(),
  connection: "connecting",
  error: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((current: State) => Partial<State>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function useStore<T>(select: (state: State) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
}

function readSavedAgent(): string {
  try {
    return localStorage.getItem("staf.agent") ?? "default";
  } catch {
    return "default";
  }
}

export function chooseAgent(agentId: string): void {
  set({ agentId });
  try {
    localStorage.setItem("staf.agent", agentId);
  } catch {
    // The choice still applies until the page reloads.
  }
}

function threadFromPath(path: string): string | null {
  const match = /^\/t\/([^/]+)$/.exec(path);
  return match ? decodeURIComponent(match[1]!) : null;
}

function sortThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

function report(error: unknown): void {
  set({ error: error instanceof Error ? error.message : String(error) });
}

// Navigation

export function openThread(id: string | null, options: { replace?: boolean } = {}): void {
  const path = id ? `/t/${encodeURIComponent(id)}` : "/";
  if (location.pathname !== path) {
    if (options.replace) history.replaceState(null, "", path);
    else history.pushState(null, "", path);
  }
  set({ threadId: id, error: null });
  if (id) void loadThread(id);
}

window.addEventListener("popstate", () => {
  const id = threadFromPath(location.pathname);
  set({ threadId: id });
  if (id) void loadThread(id);
});

// Loading

async function loadThreads(): Promise<void> {
  const threads = await api.listThreads();
  set({ threads: sortThreads(threads) });
}

async function loadThread(id: string): Promise<void> {
  try {
    const detail = await api.getThread(id);
    set((current) => ({ messages: { ...current.messages, [id]: detail.messages } }));
  } catch (error) {
    report(error);
  }
}

async function loadHealth(): Promise<void> {
  set({ health: await api.health() });
}

async function loadAgents(): Promise<void> {
  const agents = await api.listAgents();
  set((current) => ({
    agents,
    agentId: agents.some((agent) => agent.id === current.agentId) ? current.agentId : (agents[0]?.id ?? "default"),
  }));
}

// Actions

export async function sendMessage(text: string): Promise<void> {
  try {
    let id = state.threadId;
    if (!id) {
      const thread = await api.createThread({ agentId: state.agentId });
      id = thread.id;
      set((current) => ({
        messages: { ...current.messages, [thread.id]: current.messages[thread.id] ?? [] },
      }));
      history.pushState(null, "", `/t/${encodeURIComponent(id)}`);
      set({ threadId: id });
    }
    await api.sendMessage(id, text);
  } catch (error) {
    report(error);
  }
}

export async function stopAnswer(): Promise<void> {
  if (!state.threadId) return;
  try {
    await api.interrupt(state.threadId);
  } catch (error) {
    report(error);
  }
}

export async function deleteThread(id: string): Promise<void> {
  try {
    await api.deleteThread(id);
    if (state.threadId === id) openThread(null, { replace: true });
  } catch (error) {
    report(error);
  }
}

export function dismissError(): void {
  set({ error: null });
}

// Live events

function updateMessage(
  messages: Record<string, Message[]>,
  threadId: string,
  messageId: string,
  update: (message: Message) => Message,
): Record<string, Message[]> {
  const list = messages[threadId];
  if (!list) return messages;
  const index = list.findIndex((message) => message.id === messageId);
  if (index < 0) return messages;
  const next = [...list];
  next[index] = update(list[index]!);
  return { ...messages, [threadId]: next };
}

function upsertActivity(activities: Activity[], activity: Activity): Activity[] {
  const index = activities.findIndex((item) => item.id === activity.id);
  if (index < 0) return [...activities, activity];
  const next = [...activities];
  next[index] = activity;
  return next;
}

function apply(event: StreamEvent): void {
  switch (event.type) {
    case "ready":
      set({ connection: "open" });
      void loadThreads().catch(report);
      void loadHealth().catch(() => {});
      void loadAgents().catch(() => {});
      if (state.threadId) void loadThread(state.threadId);
      return;
    case "thread.upserted":
      set((current) => ({
        threads: sortThreads([
          event.thread,
          ...current.threads.filter((thread) => thread.id !== event.thread.id),
        ]),
      }));
      return;
    case "thread.deleted":
      set((current) => {
        const { [event.threadId]: _removed, ...messages } = current.messages;
        return {
          threads: current.threads.filter((thread) => thread.id !== event.threadId),
          messages,
        };
      });
      if (state.threadId === event.threadId) openThread(null, { replace: true });
      return;
    case "message.created":
      set((current) => {
        const list = current.messages[event.message.threadId];
        if (!list && event.message.threadId !== current.threadId) return {};
        if (list?.some((message) => message.id === event.message.id)) return {};
        return {
          messages: {
            ...current.messages,
            [event.message.threadId]: [...(list ?? []), event.message],
          },
        };
      });
      return;
    case "message.delta":
      set((current) => ({
        messages: updateMessage(current.messages, event.threadId, event.messageId, (message) => ({
          ...message,
          text: message.text + event.text,
        })),
      }));
      return;
    case "message.text":
      set((current) => ({
        messages: updateMessage(current.messages, event.threadId, event.messageId, (message) => ({
          ...message,
          text: event.text,
        })),
      }));
      return;
    case "message.activity":
      set((current) => ({
        messages: updateMessage(current.messages, event.threadId, event.messageId, (message) => ({
          ...message,
          activities: upsertActivity(message.activities, event.activity),
        })),
      }));
      return;
    case "message.completed":
      set((current) => ({
        messages: updateMessage(
          current.messages,
          event.message.threadId,
          event.message.id,
          () => event.message,
        ),
      }));
      return;
  }
}

/** Keeps one event stream open, and reconnects after a short wait when it drops. */
async function listen(): Promise<void> {
  for (;;) {
    try {
      for await (const event of api.events()) apply(event);
    } catch {
      // Reconnect below.
    }
    set({ connection: "offline" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

void listen();
