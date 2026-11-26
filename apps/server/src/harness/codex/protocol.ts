// The subset of the Codex app-server protocol that Staf uses.
// Checked against `codex app-server generate-ts` from codex-cli 0.172.0.
// Run `bun run codex-types` in apps/server to write the full bindings to .codex-types/.

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type AskForApproval = "untrusted" | "on-request" | "never";

export interface ThreadOptions {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  developerInstructions?: string | null;
}

export interface ThreadStartParams extends ThreadOptions {
  ephemeral?: boolean | null;
}

export interface ThreadResumeParams extends ThreadOptions {
  threadId: string;
  excludeTurns?: boolean;
}

export interface ThreadResponse {
  thread: { id: string };
  model?: string;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: [] }>;
}

export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface Turn {
  id: string;
  status: TurnStatus;
  error: { message: string; additionalDetails: string | null } | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export type WebSearchAction =
  | { type: "search"; query: string | null; queries: string[] | null }
  | { type: "openPage"; url: string | null }
  | { type: "findInPage"; url: string | null; pattern: string | null }
  | { type: "other" };

export type ThreadItem =
  | { type: "userMessage"; id: string }
  | { type: "agentMessage"; id: string; text: string; phase: string | null }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      status: "inProgress" | "completed" | "failed" | "declined";
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: Array<{ path: string }>;
      status: string;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      arguments?: unknown;
      status: "inProgress" | "completed" | "failed";
      error: { message: string } | null;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace: string | null;
      tool: string;
      status: string;
      success: boolean | null;
    }
  | { type: "webSearch"; id: string; query: string; action: WebSearchAction | null }
  | { type: string; id: string };

export interface ItemNotification {
  item: ThreadItem;
  threadId: string;
  turnId: string;
}

export interface AgentMessageDelta {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface TurnCompletedNotification {
  threadId: string;
  turn: Turn;
}

export interface ErrorNotification {
  error: { message: string };
  willRetry: boolean;
  threadId: string;
  turnId: string;
}
