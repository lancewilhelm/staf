// Types shared by the Staf host, the web app, and the CLI.
// Keep this file free of Bun, Node, and DOM-specific imports.

export type ThreadStatus = "idle" | "running";

export interface ThreadSummary {
  id: string;
  title: string;
  agentId: string;
  /** Harness that runs this thread, such as "codex". It can change during the conversation. */
  harness: string;
  /** Model that the thread asks for, or null for the harness's default. */
  model: string | null;
  status: ThreadStatus;
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

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  /** Markdown text. For an assistant message that is still streaming, the text so far. */
  text: string;
  activities: Activity[];
  status: MessageStatus;
  error?: string;
  /** For assistant messages: the harness and model that wrote the answer. */
  harness?: string;
  model?: string | null;
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
}

/** Changes the harness or model of a conversation from the next message on. */
export interface UpdateThreadRequest {
  harness?: string;
  model?: string | null;
}

export interface LoginStart {
  /** The page to open in a browser to sign in. */
  url: string;
}

export interface SendMessageRequest {
  text: string;
}

export interface SendMessageResponse {
  userMessage: Message;
  assistantMessage: Message;
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
  | { type: "message.completed"; message: Message }
  /** Agents were added, changed, or removed. */
  | { type: "agents.changed" }
  /** A harness signed in or out. */
  | { type: "harnesses.changed" };

export interface ApiErrorBody {
  error: string;
}
