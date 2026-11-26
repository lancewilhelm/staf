import { join } from "node:path";

/** How the currently active turn was started. */
export type RunTrigger = "chat" | "schedule";

/** Metadata for one currently active agent turn, verified by the Staf host on every MCP tool call. */
export interface RunContext {
  agentId: string;
  threadId: string;
  messageId: string;
  trigger: RunTrigger;
  taskId: string | null;
}

/** Configuration passed to a harness adapter so it can launch `staf mcp-bridge`. */
export interface McpBridgeConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface TokenBinding {
  token: string;
  agentId: string;
  threadId: string;
  harnessId: string;
  /** When set, this token is pinned to one specific assistant message and revoked when that turn ends. */
  messageId: string | null;
}

/**
 * Manages scoped in-memory run tokens for the local Staf MCP server.
 *
 * Per-turn harnesses (such as Claude Code) receive a single-turn token pinned to the current
 * assistant message. Persistent-session harnesses (such as Codex and ACP) keep one MCP bridge
 * process alive across turns in the same thread session, so they receive a thread-session token
 * that is accepted for tool calls ONLY while that thread has an active running turn.
 */
export class RunTokenStore {
  private readonly tokens = new Map<string, TokenBinding>();
  private readonly sessionTokens = new Map<string, string>();
  private readonly activeByThread = new Map<string, RunContext>();

  beginRun(
    input: RunContext & { harnessId: string; singleTurn?: boolean },
  ): { token: string; end: () => void } {
    const context: RunContext = {
      agentId: input.agentId,
      threadId: input.threadId,
      messageId: input.messageId,
      trigger: input.trigger,
      taskId: input.taskId,
    };
    this.activeByThread.set(input.threadId, context);

    let token: string;
    if (input.singleTurn) {
      token = generateToken();
      this.tokens.set(token, {
        token,
        agentId: input.agentId,
        threadId: input.threadId,
        harnessId: input.harnessId,
        messageId: input.messageId,
      });
    } else {
      const sessionKey = `${input.threadId}:${input.harnessId}`;
      const existing = this.sessionTokens.get(sessionKey);
      if (existing && this.tokens.has(existing)) {
        token = existing;
      } else {
        token = generateToken();
        this.sessionTokens.set(sessionKey, token);
        this.tokens.set(token, {
          token,
          agentId: input.agentId,
          threadId: input.threadId,
          harnessId: input.harnessId,
          messageId: null,
        });
      }
    }

    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      const current = this.activeByThread.get(input.threadId);
      if (current?.messageId === input.messageId) {
        this.activeByThread.delete(input.threadId);
      }
      if (input.singleTurn) {
        this.tokens.delete(token);
      }
    };

    return { token, end };
  }

  /**
   * Verifies a token for read-only MCP handshake calls (`initialize`, `ping`, `tools/list`).
   * A token remains valid for handshakes until it is revoked.
   */
  verifyHandshake(token: string): TokenBinding | null {
    if (!token) return null;
    return this.tokens.get(token) ?? null;
  }

  /**
   * Verifies a token for an actual tool execution (`tools/call`).
   * Succeeds only when the token is valid AND its thread has a currently active turn.
   */
  verifyActiveRun(token: string): RunContext | null {
    const binding = this.verifyHandshake(token);
    if (!binding) return null;
    const active = this.activeByThread.get(binding.threadId);
    if (!active) return null;
    if (active.agentId !== binding.agentId) return null;
    if (binding.messageId !== null && active.messageId !== binding.messageId) return null;
    return active;
  }

  /** Invalidates every token and active run associated with a thread (for deletion or harness switch). */
  revokeThread(threadId: string): void {
    this.activeByThread.delete(threadId);
    for (const [token, binding] of this.tokens) {
      if (binding.threadId === threadId) this.tokens.delete(token);
    }
    const prefix = `${threadId}:`;
    for (const key of [...this.sessionTokens.keys()]) {
      if (key.startsWith(prefix)) this.sessionTokens.delete(key);
    }
  }

  /** Invalidates every token and active run (called during host shutdown). */
  revokeAll(): void {
    this.tokens.clear();
    this.sessionTokens.clear();
    this.activeByThread.clear();
  }
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `staf_run_${hex}`;
}

/**
 * Builds the stdio command that harnesses use to launch `staf mcp-bridge`.
 * Uses the compiled binary directly in production builds, or `bun run src/main.ts` in development.
 */
export function defaultBridgeConfig(serverUrl: string, token: string): McpBridgeConfig {
  const cleanUrl = serverUrl.replace(/\/$/, "");
  const isCompiled = typeof Bun !== "undefined" && Bun.main.startsWith("/$bunfs/");
  if (isCompiled) {
    return {
      command: process.execPath,
      args: ["mcp-bridge", "--url", cleanUrl],
      env: { STAF_RUN_TOKEN: token },
    };
  }
  const entry = join(import.meta.dir, "..", "main.ts");
  return {
    command: process.execPath,
    args: ["run", entry, "mcp-bridge", "--url", cleanUrl],
    env: { STAF_RUN_TOKEN: token },
  };
}
