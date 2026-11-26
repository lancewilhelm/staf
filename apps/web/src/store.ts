import {
  DEFAULT_PREFERENCES,
  type Activity,
  type AgentInput,
  type AgentMemorySettings,
  type AgentMemorySnapshot,
  type AgentSummary,
  type ApproveMemoryRequest,
  type CreateScheduledTaskRequest,
  type HealthInfo,
  type MemoryBlock,
  type MemoryEntry,
  type Message,
  type ModelInfo,
  type ScheduledTask,
  StafClient,
  type StreamEvent,
  type ThreadSummary,
  type UpdatePreferencesRequest,
  type UserPreferences,
} from "@staf/protocol";
import { listenShared } from "./events.ts";
import { useSyncExternalStore } from "react";
import {
  applyPreferences,
  legacyPreferencesToMigrate,
  markPreferencesSynced,
  readCachedPreferences,
  writeCachedPreferences,
} from "./theme.ts";

export type Connection = "connecting" | "open" | "offline";

export interface State {
  /** The open thread, or null for a new chat. */
  threadId: string | null;
  threads: ThreadSummary[];
  /** Messages for each thread that has been opened. */
  messages: Record<string, Message[]>;
  /** Pending memory proposals for each thread that has been opened. */
  proposals: Record<string, MemoryEntry[]>;
  health: HealthInfo | null;
  agents: AgentSummary[];
  /** The agent that a new chat goes to. */
  agentId: string;
  /**
   * A harness and model picked for the next new chat instead of the agent's defaults.
   * Undefined fields use the agent's setting.
   */
  /** Changes to the agent's defaults for the next new chat. */
  draft: Partial<Choice>;
  /** Model lists by harness, loaded when someone opens a picker. */
  models: Record<string, ModelList>;
  /** Scheduled tasks loaded per agent ID. */
  tasks: Record<string, ScheduledTask[]>;
  /** Memory snapshots loaded per agent ID. */
  memories: Record<string, AgentMemorySnapshot>;
  preferences: UserPreferences;
  settings: SettingsView | null;
  agentPanel: AgentPanelView | null;
  connection: Connection;
  /** The last error from an action, shown once to the person. */
  error: string | null;
}

/** How a conversation is answered: by which harness and model, at which level, how fast. */
export interface Choice {
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
}

export type ModelList = { status: "loading" } | { status: "ready"; list: ModelInfo[] } | { status: "error"; error: string };

export type SettingsView =
  | { section: "providers" }
  | { section: "appearance" };

export type AgentPanelSection = "profile" | "tasks" | "memory";

export type AgentPanelView =
  | { mode: "create" }
  | { mode: "edit"; agentId: string; section: AgentPanelSection };

export const api = new StafClient(location.origin);

const LAST_CHOICE_KEY = "staf.lastChoice";

/** The provider, model, and level last picked for each agent in this browser. */
type LastChoices = Record<string, Omit<Choice, "fast">>;

function readLastChoices(): LastChoices {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_CHOICE_KEY) ?? "{}");
    return typeof value === "object" && value !== null ? (value as LastChoices) : {};
  } catch {
    return {};
  }
}

/**
 * Where a new chat with an agent starts: the provider, model, and level that were last
 * picked for it. Fast mode is left out, so that a forgotten switch cannot keep costing.
 */
function lastChoice(agentId: string): Partial<Choice> {
  const saved = readLastChoices()[agentId];
  if (!saved || typeof saved.harness !== "string") return {};
  return { harness: saved.harness, model: saved.model ?? null, effort: saved.effort ?? null };
}

function rememberChoice(agentId: string, choice: Choice | null): void {
  try {
    const all = readLastChoices();
    if (choice) all[agentId] = { harness: choice.harness, model: choice.model, effort: choice.effort };
    else delete all[agentId];
    localStorage.setItem(LAST_CHOICE_KEY, JSON.stringify(all));
  } catch {
    // New chats then start from the agent's defaults.
  }
}

const initialPreferences = readCachedPreferences();

let state: State = {
  threadId: threadFromPath(location.pathname),
  threads: [],
  messages: {},
  proposals: {},
  health: null,
  agents: [],
  agentId: readSavedAgent(),
  draft: lastChoice(readSavedAgent()),
  models: {},
  tasks: {},
  memories: {},
  preferences: {
    ...DEFAULT_PREFERENCES,
    theme: initialPreferences.theme,
    heroFont: initialPreferences.heroFont,
  },
  settings: null,
  agentPanel: null,
  connection: "connecting",
  error: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<State> | ((current: State) => Partial<State>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const NO_HARNESSES: HealthInfo["harnesses"] = [];
const NO_TASKS: ScheduledTask[] = [];
const NO_PROPOSALS: MemoryEntry[] = [];

/** The harnesses from the last health check. The fallback is one shared array, because a
 *  new array on every read makes useSyncExternalStore render forever. */
export function useHarnesses(): HealthInfo["harnesses"] {
  return useStore((s) => s.health?.harnesses ?? NO_HARNESSES);
}

/** Scheduled tasks for one agent, using a shared empty array fallback to keep selector identity stable. */
export function useAgentTasks(agentId: string): ScheduledTask[] {
  return useStore((s) => s.tasks[agentId] ?? NO_TASKS);
}

export function useAgentMemory(agentId: string): AgentMemorySnapshot | null {
  return useStore((s) => s.memories[agentId] ?? null);
}

export function useThreadProposals(threadId: string | null): MemoryEntry[] {
  return useStore((s) => (threadId ? (s.proposals[threadId] ?? NO_PROPOSALS) : NO_PROPOSALS));
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
  set({ agentId, draft: lastChoice(agentId) });
  try {
    localStorage.setItem("staf.agent", agentId);
  } catch {
    // The choice still applies until the page reloads.
  }
}

/** Starts a new chat with an agent, or with the open conversation's agent if none is given. */
export function startChat(agentId?: string): void {
  const thread = state.threadId ? state.threads.find((t) => t.id === state.threadId) : undefined;
  const target = agentId ?? thread?.agentId ?? state.agentId;
  if (target !== state.agentId) chooseAgent(target);
  openThread(null);
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
    set((current) => ({
      messages: { ...current.messages, [id]: detail.messages },
      proposals: { ...current.proposals, [id]: detail.proposals ?? [] },
    }));
  } catch (error) {
    report(error);
  }
}

async function loadHealth(): Promise<void> {
  set({ health: await api.health() });
}

export async function loadModels(harness: string, options: { force?: boolean } = {}): Promise<void> {
  const current = state.models[harness];
  if (!options.force && current && current.status !== "error") return;
  // A list that is being refreshed stays on screen until the new one arrives.
  if (current?.status !== "ready") set((s) => ({ models: { ...s.models, [harness]: { status: "loading" } } }));
  try {
    const list = await api.listModels(harness);
    set((s) => ({ models: { ...s.models, [harness]: { status: "ready", list } } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    set((s) => ({ models: { ...s.models, [harness]: { status: "error", error: message } } }));
  }
}

/** The model entry for a model ID, or for the default when the ID is null, once the list has loaded. */
export function modelInfo(models: Record<string, ModelList>, harness: string, model: string | null): ModelInfo | null {
  const list = models[harness];
  if (list?.status !== "ready") return null;
  return list.list.find((m) => (model ? m.id === model : m.isDefault)) ?? null;
}

const EFFORT_NAMES: Record<string, string> = { xhigh: "Extra high" };

/** The name to show for a reasoning level, such as "High" for "high". */
export function effortName(effort: string): string {
  return EFFORT_NAMES[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The name to show for a model ID, from the loaded lists. */
export function modelName(models: Record<string, ModelList>, harness: string, model: string | null | undefined): string | null {
  if (!model) return null;
  const list = models[harness];
  if (list?.status === "ready") return list.list.find((m) => m.id === model)?.name ?? model;
  return model;
}

/**
 * Changes how answers are made: for the open conversation from its next message on, or
 * for the next new chat.
 */
export async function choose(change: Partial<Choice>): Promise<void> {
  if (state.threadId) {
    try {
      const thread = await api.updateThread(state.threadId, change);
      // The next new chat with this agent starts with the same choice.
      rememberChoice(thread.agentId, thread);
      if (thread.agentId === state.agentId) set({ draft: lastChoice(thread.agentId) });
    } catch (error) {
      report(error);
    }
    return;
  }
  const agent = state.agents.find((a) => a.id === state.agentId);
  const draft = { ...state.draft, ...change };
  if (agent) {
    rememberChoice(agent.id, {
      harness: draft.harness ?? agent.harness,
      model: draft.model === undefined ? agent.model : draft.model,
      effort: draft.effort === undefined ? agent.effort : draft.effort,
      fast: false,
    });
  }
  const same =
    agent &&
    (draft.harness ?? agent.harness) === agent.harness &&
    (draft.model === undefined ? agent.model : draft.model) === agent.model &&
    (draft.effort === undefined ? agent.effort : draft.effort) === agent.effort &&
    (draft.fast ?? agent.fast) === agent.fast;
  set({ draft: same ? {} : draft });
}

export function openSettings(view: SettingsView = { section: "providers" }): void {
  set({ settings: view, agentPanel: null });
}

export function closeSettings(): void {
  set({ settings: null });
}

export function openAgentPanel(view: AgentPanelView): void {
  set({ agentPanel: view, settings: null });
}

export function closeAgentPanel(): void {
  set({ agentPanel: null });
}

let preferencesMigrated = false;

function applyServerPreferences(preferences: UserPreferences): void {
  set({ preferences });
  writeCachedPreferences(preferences);
  applyPreferences(preferences);
}

async function loadPreferences(): Promise<void> {
  const server = await api.getPreferences();
  if (!preferencesMigrated) {
    preferencesMigrated = true;
    const patch = legacyPreferencesToMigrate(server, readCachedPreferences());
    if (patch) {
      markPreferencesSynced();
      const migrated = await api.updatePreferences(patch);
      applyServerPreferences(migrated);
      return;
    }
  }
  applyServerPreferences(server);
}

export async function updatePreferences(patch: UpdatePreferencesRequest): Promise<void> {
  const previous = state.preferences;
  const optimistic: UserPreferences = { ...previous, ...patch };
  applyServerPreferences(optimistic);
  try {
    const saved = await api.updatePreferences(patch);
    applyServerPreferences(saved);
  } catch (error) {
    applyServerPreferences(previous);
    report(error);
  }
}

export async function saveAgent(id: string | null, input: AgentInput): Promise<AgentSummary | null> {
  try {
    const agent = id ? await api.updateAgent(id, input) : await api.createAgent(input);
    // New defaults apply to the next new chat, ahead of the last choice in the pill.
    rememberChoice(agent.id, null);
    if (agent.id === state.agentId && !state.threadId) set({ draft: {} });
    await loadAgents();
    return agent;
  } catch (error) {
    report(error);
    return null;
  }
}

export async function removeAgent(id: string): Promise<boolean> {
  try {
    await api.deleteAgent(id);
    if (state.agentId === id) chooseAgent("default");
    await loadAgents();
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function loadAgentTasks(agentId: string): Promise<void> {
  try {
    const list = await api.listScheduledTasks(agentId);
    set((current) => ({ tasks: { ...current.tasks, [agentId]: list } }));
  } catch (error) {
    report(error);
  }
}

export async function saveScheduledTask(
  agentId: string,
  taskId: string | null,
  input: CreateScheduledTaskRequest,
): Promise<ScheduledTask | null> {
  try {
    const saved = taskId
      ? await api.updateScheduledTask(taskId, input)
      : await api.createScheduledTask(agentId, input);
    await loadAgentTasks(agentId);
    return saved;
  } catch (error) {
    report(error);
    return null;
  }
}

export async function toggleScheduledTask(task: ScheduledTask): Promise<void> {
  try {
    await api.updateScheduledTask(task.id, { enabled: !task.enabled });
    await loadAgentTasks(task.agentId);
  } catch (error) {
    report(error);
  }
}

export async function removeScheduledTask(task: ScheduledTask): Promise<boolean> {
  try {
    await api.deleteScheduledTask(task.id);
    await loadAgentTasks(task.agentId);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function runScheduledTaskNow(task: ScheduledTask): Promise<ThreadSummary | null> {
  try {
    const result = await api.runScheduledTask(task.id);
    await loadAgentTasks(task.agentId);
    return result.thread;
  } catch (error) {
    report(error);
    return null;
  }
}

export async function loadAgentMemory(agentId: string): Promise<void> {
  try {
    const snapshot = await api.getAgentMemory(agentId);
    set((current) => ({ memories: { ...current.memories, [agentId]: snapshot } }));
  } catch (error) {
    report(error);
  }
}

export async function addMemory(agentId: string, block: MemoryBlock, text: string): Promise<boolean> {
  try {
    await api.createMemory(agentId, { block, text });
    await loadAgentMemory(agentId);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function editMemory(entry: MemoryEntry, text: string, block?: MemoryBlock): Promise<boolean> {
  try {
    await api.updateMemory(entry.id, { text, ...(block ? { block } : {}) });
    await loadAgentMemory(entry.agentId);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function removeMemory(entry: MemoryEntry): Promise<boolean> {
  try {
    await api.deleteMemory(entry.id);
    await loadAgentMemory(entry.agentId);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function approveMemoryProposal(
  entry: MemoryEntry,
  edit?: ApproveMemoryRequest,
): Promise<boolean> {
  try {
    await api.approveMemory(entry.id, edit);
    if (entry.agentId in state.memories) await loadAgentMemory(entry.agentId);
    const tid = entry.source.kind === "schedule" || entry.source.kind === "thread" ? entry.source.threadId : null;
    if (tid && (tid === state.threadId || tid in state.proposals)) await loadThread(tid);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function rejectMemoryProposal(entry: MemoryEntry): Promise<boolean> {
  try {
    await api.rejectMemory(entry.id);
    if (entry.agentId in state.memories) await loadAgentMemory(entry.agentId);
    const tid = entry.source.kind === "schedule" || entry.source.kind === "thread" ? entry.source.threadId : null;
    if (tid && (tid === state.threadId || tid in state.proposals)) await loadThread(tid);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function saveAgentMemorySettings(
  agentId: string,
  memory: Partial<AgentMemorySettings>,
): Promise<boolean> {
  try {
    await api.updateAgent(agentId, { memory });
    await Promise.all([loadAgents(), loadAgentMemory(agentId)]);
    return true;
  } catch (error) {
    report(error);
    return false;
  }
}

export async function signIn(harness: string): Promise<void> {
  try {
    const { url } = await api.startLogin(harness);
    window.open(url, "_blank", "noopener");
  } catch (error) {
    report(error);
  }
}

async function loadAgents(): Promise<void> {
  const agents = await api.listAgents();
  set((current) => {
    const panel = current.agentPanel;
    return {
      agents,
      agentId: agents.some((agent) => agent.id === current.agentId) ? current.agentId : (agents[0]?.id ?? "default"),
      agentPanel: panel?.mode === "edit" && !agents.some((agent) => agent.id === panel.agentId) ? null : panel,
    };
  });
}

// Actions

export async function sendMessage(text: string, files: File[] = []): Promise<void> {
  if (!text.trim() && files.length === 0) return;
  try {
    let id = state.threadId;
    if (!id) {
      const thread = await api.createThread({ agentId: state.agentId, ...state.draft });
      set({ draft: lastChoice(state.agentId) });
      id = thread.id;
      set((current) => ({
        messages: { ...current.messages, [thread.id]: current.messages[thread.id] ?? [] },
      }));
      history.pushState(null, "", `/t/${encodeURIComponent(id)}`);
      set({ threadId: id });
    }
    const attachmentIds: string[] = [];
    for (const file of files) {
      const uploaded = await api.uploadAttachment(id, file, file.name);
      attachmentIds.push(uploaded.id);
    }
    await api.sendMessage(id, text, attachmentIds);
  } catch (error) {
    report(error);
  }
}

export async function settleThread(id: string, settled: boolean): Promise<void> {
  const previous = state.threads;
  const optimisticAt = settled ? Date.now() : null;
  set({
    threads: previous.map((thread) =>
      thread.id === id ? { ...thread, settledAt: settled ? (thread.settledAt ?? optimisticAt) : null } : thread,
    ),
  });
  try {
    const updated = await api.updateThread(id, { settled });
    set((current) => ({
      threads: sortThreads([updated, ...current.threads.filter((thread) => thread.id !== updated.id)]),
    }));
  } catch (error) {
    set({ threads: previous });
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
      loadEverything();
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
        const { [event.threadId]: _removedProposals, ...proposals } = current.proposals;
        return {
          threads: current.threads.filter((thread) => thread.id !== event.threadId),
          messages,
          proposals,
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
    case "message.attachment":
      set((current) => ({
        messages: updateMessage(current.messages, event.threadId, event.messageId, (message) => {
          if (message.attachments.some((item) => item.id === event.attachment.id)) return message;
          return { ...message, attachments: [...message.attachments, event.attachment] };
        }),
      }));
      return;
    case "agents.changed":
      void loadAgents().catch(() => {});
      return;
    case "harnesses.changed": {
      void loadHealth().catch(() => {});
      // A sign-in can change which models a harness offers, so reload the lists in use.
      const inUse = Object.keys(state.models);
      for (const harness of inUse) void loadModels(harness, { force: true });
      return;
    }
    case "preferences.changed":
      applyServerPreferences(event.preferences);
      return;
    case "tasks.changed":
      if (
        event.agentId in state.tasks ||
        (state.agentPanel?.mode === "edit" && state.agentPanel.agentId === event.agentId)
      ) {
        void loadAgentTasks(event.agentId);
      }
      return;
    case "memories.changed":
      if (
        event.agentId in state.memories ||
        (state.agentPanel?.mode === "edit" && state.agentPanel.agentId === event.agentId)
      ) {
        void loadAgentMemory(event.agentId);
      }
      if (event.threadId && (event.threadId === state.threadId || event.threadId in state.proposals)) {
        void loadThread(event.threadId);
      }
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

/** Loads the current state, after connecting or reconnecting, when events may have been missed. */
function loadEverything(): void {
  void loadThreads().catch(report);
  void loadHealth().catch(() => {});
  void loadAgents().catch(() => {});
  void loadPreferences().catch(() => {});
  if (state.threadId) void loadThread(state.threadId);
}

listenShared(api, {
  event: apply,
  offline: () => set({ connection: "offline" }),
  joined: () => {
    set({ connection: "open" });
    loadEverything();
  },
});

// Settings that this browser keeps apply to every open tab.
window.addEventListener("storage", (event) => {
  if (event.key === "staf.agent" && !state.threadId) {
    const agentId = readSavedAgent();
    set({ agentId, draft: lastChoice(agentId) });
  } else if (event.key === LAST_CHOICE_KEY && !state.threadId) {
    set({ draft: lastChoice(state.agentId) });
  }
});
