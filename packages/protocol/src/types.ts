// Types shared by the Staf host, the web app, and the CLI.
// Keep this file free of Bun, Node, and DOM-specific imports.

export type ThreadStatus = "idle" | "running";

/** How a thread started: a person's chat or a scheduled task run. */
export type ThreadSource = "chat" | "schedule";

export interface ThreadSummary {
  id: string;
  title: string;
  agentId: string;
  /** Harness that runs this thread, such as "codex". It can change during the conversation. */
  harness: string;
  /** Model that the thread asks for, or null for the harness's default. */
  model: string | null;
  /** Reasoning level, such as "high", or null for the model's default. */
  effort: string | null;
  /** Whether answers use the harness's faster, more expensive mode. */
  fast: boolean;
  /** Whether this thread was started manually or by a scheduled task. */
  source: ThreadSource;
  /** The scheduled task that started this thread, if any. */
  taskId: string | null;
  /** Unix time in milliseconds when this thread was settled, or null while active. */
  settledAt: number | null;
  status: ThreadStatus;
  /** Unix time in milliseconds when the current active turn started, or null while idle. */
  runningSince: number | null;
  /** Unix time in milliseconds. */
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "user" | "assistant";

export type MessageStatus = "streaming" | "complete" | "failed" | "interrupted";

export type ActivityKind =
  | "search"
  | "page"
  | "command"
  | "tool"
  | "file"
  | "note"
  | "reasoning"
  | "other";

export type ActivityStatus = "running" | "done" | "failed";

/** One step that the agent took while it answered, such as a web search. */
export interface Activity {
  id: string;
  kind: ActivityKind;
  /** One line that a person can read, such as "Searched: weather in Lisbon". */
  title: string;
  /** Optional longer text, shown only when someone opens the step. */
  detail?: string;
  status: ActivityStatus;
  startedAt: number;
  completedAt?: number;
}

/** A file attached to a message, such as a generated PDF or an uploaded document. */
export interface Attachment {
  id: string;
  threadId: string;
  /** The message this attachment belongs to, or null while pending send. */
  messageId: string | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Relative URL on the host to view or download the file. */
  url: string;
  createdAt: number;
}

/** Normalized token counts reported by a harness for one turn. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
}

/** How a turn obtained its harness session. */
export type SessionAction = "new" | "resumed" | "handoff" | "recovered";

/** Normalized timing and usage stats recorded for an assistant turn. */
export interface MessageStats {
  durationMs: number;
  firstTokenMs?: number;
  firstActivityMs?: number;
  apiDurationMs?: number;
  stepCount: number;
  sessionAction?: SessionAction;
  effort?: string | null;
  fast?: boolean;
  resolvedModel?: string | null;
  stopReason?: string | null;
  turns?: number;
  costUsd?: number;
  usage?: TokenUsage;
}

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  /** Markdown text. For an assistant message that is still streaming, the text so far. */
  text: string;
  activities: Activity[];
  /** Files attached to this message. */
  attachments: Attachment[];
  status: MessageStatus;
  error?: string;
  /** For assistant messages: the harness and model that wrote the answer. */
  harness?: string;
  model?: string | null;
  /** Optional normalized timing and usage metadata for completed assistant turns. */
  stats?: MessageStats;
  createdAt: number;
  completedAt?: number;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: Message[];
}

export interface AgentSummary {
  id: string;
  name: string;
  /** The default harness ID for new conversations, such as "codex". */
  harness: string;
  /** Harness name to show, such as "ChatGPT". */
  harnessLabel: string;
  /** The default model, or null for the harness's default. */
  model: string | null;
  /** The default reasoning level, or null for the model's default. */
  effort: string | null;
  /** Whether new conversations use fast mode. */
  fast: boolean;
  /** The contents of AGENTS.md. */
  instructions: string;
  /** Access settings. They are edited in agent.json, not through the API. */
  network: boolean;
  writableFolders: string[];
  harnessApps: string[];
  /** The default agent cannot be deleted. */
  isDefault: boolean;
}

/** Fields that the API can change on an agent. */
export interface AgentInput {
  name: string;
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
  instructions: string;
}

export interface HarnessInfo {
  id: string;
  /** Short name, such as "ChatGPT". */
  label: string;
  /** The program behind it, such as "Codex". */
  program: string;
  ready: boolean;
  /** Why the harness is not ready, or other short status text. */
  detail?: string;
  /** One line about how this harness differs from the others. */
  note?: string;
  /** Shown as experimental in the app. */
  experimental?: boolean;
  /** "staf" when Staf keeps its own sign-in, "machine" when the harness uses this computer's. */
  signIn: "staf" | "machine";
  /** Whether the harness is signed in, when Staf can tell. */
  signedIn?: boolean;
  /** The signed-in account, such as an email address, when Staf can tell. */
  account?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  /** The model that the harness uses when none is chosen. */
  isDefault?: boolean;
  /** Reasoning levels that a conversation can pick, lowest first. Absent when there is no choice. */
  efforts?: string[];
  /** The level that the model uses when none is picked. */
  defaultEffort?: string;
  /** Whether the model has a fast mode. */
  fast?: boolean;
  /** What fast mode does and costs, such as "2x speed, increased usage". */
  fastNote?: string;
}

export interface HealthInfo {
  version: string;
  harnesses: HarnessInfo[];
}

export interface CreateThreadRequest {
  agentId?: string;
  /** Overrides the agent's default harness. */
  harness?: string;
  /** Overrides the agent's default model. Null asks for the harness's default. */
  model?: string | null;
  /** Overrides the agent's default reasoning level. Null asks for the model's default. */
  effort?: string | null;
  /** Overrides the agent's fast mode setting. */
  fast?: boolean;
  /** Defaults to "chat". */
  source?: ThreadSource;
}

/** Changes how a thread is answered from the next message on, or settles/unsettles it. */
export interface UpdateThreadRequest {
  harness?: string;
  model?: string | null;
  effort?: string | null;
  fast?: boolean;
  /** True settles the thread; false moves it back to unsettled. */
  settled?: boolean;
}

export interface LoginStart {
  /** The page to open in a browser to sign in. */
  url: string;
}

export interface SendMessageRequest {
  text: string;
  /** Pending attachment IDs uploaded to this thread to attach to the user message. */
  attachmentIds?: string[];
}

export interface SendMessageResponse {
  userMessage: Message;
  assistantMessage: Message;
}

export type ThemePreference = "system" | "light" | "dark";
export type HeroFont = "bricolage" | "space-grotesk" | "sans" | "fraunces" | "serif";
export type SidebarMode = "inbox" | "list";

/** Appearance and interface preferences synced per person on the host. */
export interface UserPreferences {
  theme: ThemePreference;
  heroFont: HeroFont;
  sidebarMode: SidebarMode;
}

export type UpdatePreferencesRequest = Partial<UserPreferences>;

export type TaskSchedule =
  | {
      type: "daily";
      /** 24-hour local time in HH:MM format, such as "05:30". */
      timeOfDay: string;
      /** Days of the week (0 = Sunday .. 6 = Saturday). Empty or omitted means every day. */
      weekdays?: number[];
    }
  | {
      type: "interval";
      /** Minutes between runs (5 to 10080). */
      everyMinutes: number;
    }
  | {
      type: "once";
      /** Unix time in milliseconds for a single run. */
      runAt: number;
    };

export type ScheduledTaskRunStatus = "running" | "complete" | "failed" | "interrupted";

export interface ScheduledTask {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  schedule: TaskSchedule;
  enabled: boolean;
  /** Optional provider override; null uses the agent's default harness. */
  harness: string | null;
  /** Optional model override; null uses the provider's or agent's default. */
  model: string | null;
  /** Optional reasoning level override. */
  effort: string | null;
  /** Fast mode is off by default so scheduled tasks do not silently spend extra credits. */
  fast: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunThreadId: string | null;
  lastRunStatus: ScheduledTaskRunStatus | null;
  lastRunError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateScheduledTaskRequest {
  name: string;
  prompt: string;
  schedule: TaskSchedule;
  enabled?: boolean;
  harness?: string | null;
  model?: string | null;
  effort?: string | null;
  fast?: boolean;
}

export type UpdateScheduledTaskRequest = Partial<CreateScheduledTaskRequest>;

export interface RunScheduledTaskResponse {
  task: ScheduledTask;
  thread: ThreadSummary;
}

/** Events that the host streams to clients over server-sent events. */
export type StreamEvent =
  | { type: "ready" }
  | { type: "thread.upserted"; thread: ThreadSummary }
  | { type: "thread.deleted"; threadId: string }
  | { type: "message.created"; message: Message }
  | { type: "message.delta"; threadId: string; messageId: string; text: string }
  /** Replaces the whole text of a streaming message. */
  | { type: "message.text"; threadId: string; messageId: string; text: string }
  | { type: "message.activity"; threadId: string; messageId: string; activity: Activity }
  | { type: "message.attachment"; threadId: string; messageId: string; attachment: Attachment }
  | { type: "message.completed"; message: Message }
  /** Agents were added, changed, or removed. */
  | { type: "agents.changed" }
  /** A harness signed in or out. */
  | { type: "harnesses.changed" }
  /** A person's preferences changed. */
  | { type: "preferences.changed"; preferences: UserPreferences }
  /** Scheduled tasks for an agent were added, changed, removed, or ran. */
  | { type: "tasks.changed"; agentId: string };

export interface ApiErrorBody {
  error: string;
}
