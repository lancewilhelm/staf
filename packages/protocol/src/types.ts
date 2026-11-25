// Types shared by the Staf host, the web app, and the CLI.
// Keep this file free of Bun, Node, and DOM-specific imports.

export type ThreadStatus = "idle" | "running";

export interface ThreadSummary {
  id: string;
  title: string;
  agentId: string;
  /** Harness that runs this thread, such as "codex". */
  harness: string;
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
  createdAt: number;
  completedAt?: number;
}

export interface ThreadDetail {
  thread: ThreadSummary;
  messages: Message[];
}

export interface HarnessInfo {
  id: string;
  label: string;
  ready: boolean;
  /** Why the harness is not ready, or other short status text. */
  detail?: string;
}

export interface HealthInfo {
  version: string;
  harnesses: HarnessInfo[];
}

export interface CreateThreadRequest {
  agentId?: string;
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
  | { type: "message.activity"; threadId: string; messageId: string; activity: Activity }
  | { type: "message.completed"; message: Message };

export interface ApiErrorBody {
  error: string;
}
