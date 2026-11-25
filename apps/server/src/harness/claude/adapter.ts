// Claude through Claude Code's print mode with stream-JSON output, one process per turn.

import type { Activity, HarnessInfo } from "@staf/protocol";
import type { AgentAccess } from "../../agents.ts";
import {
  AnswerText,
  basename,
  describeError,
  firstLine,
  hostOf,
  truncate,
} from "../activities.ts";
import { lines } from "../rpc.ts";
import type { HarnessAdapter, HarnessEvent, TurnOutcome, TurnRequest } from "../types.ts";

export interface ClaudeOptions {
  /** Command that starts Claude Code. Tests replace it with a fake. */
  command?: string[];
}

/**
 * Built-in tools that Staf allows. Others are left out: cloud features of the Claude
 * account (publishing pages, remote triggers, push notifications), scheduling, and
 * subagents, which Staf does not control yet.
 */
export const CLAUDE_TOOLS = ["Bash", "Read", "Edit", "Write", "WebSearch", "WebFetch", "Skill"];

/** Tools that run without asking. Edits inside the working folders are allowed by the permission mode. */
const PREAPPROVED = ["Bash", "WebSearch", "WebFetch"];

/** Builds the command-line arguments for one turn. */
export function claudeArgs(request: Pick<TurnRequest, "sessionId" | "instructions" | "model" | "access">): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Leaves out the person's CLAUDE.md, skills, plugins, hooks, and MCP servers.
    "--safe-mode",
    // Edits inside the working folders are accepted. Anything that would ask is refused,
    // because nobody can answer in print mode.
    "--permission-mode",
    "acceptEdits",
    "--tools",
    ...CLAUDE_TOOLS,
    "--allowedTools",
    ...PREAPPROVED,
    "--settings",
    JSON.stringify(claudeSettings(request.access)),
    "--append-system-prompt",
    request.instructions,
    ...(request.model ? ["--model", request.model] : []),
    ...(request.sessionId ? ["--resume", request.sessionId] : []),
    ...request.access.writableFolders.flatMap((folder) => ["--add-dir", folder]),
  ];
}

/**
 * Commands run in Claude Code's sandbox and may not leave it. Network access is open to
 * every domain when the agent allows it, and closed otherwise.
 */
export function claudeSettings(access: AgentAccess): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      ...(access.network ? { network: { allowedDomains: ["*"] } } : {}),
    },
  };
}

interface ToolState {
  name: string;
  input: Record<string, unknown>;
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = "claude";
  readonly label = "Claude (Claude Code)";

  constructor(private readonly options: ClaudeOptions = {}) {}

  async status(): Promise<HarnessInfo> {
    const base = { id: this.id, label: this.label };
    if (!this.options.command && !Bun.which("claude")) {
      return { ...base, ready: false, detail: "The claude command is not installed." };
    }
    return { ...base, ready: true };
  }

  async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    const ready = await this.status();
    if (!ready.ready) return { status: "failed", error: ready.detail ?? "Claude is not ready." };
    try {
      const first = await this.runOnce(request, request.sessionId);
      if (first.missingSession && request.sessionId) {
        // The saved session is gone. Continue in a new one.
        return (await this.runOnce(request, null)).outcome;
      }
      return first.outcome;
    } catch (error) {
      return { status: "failed", error: describeError(error) };
    }
  }

  async close(): Promise<void> {}

  private async runOnce(
    request: TurnRequest,
    sessionId: string | null,
  ): Promise<{ outcome: TurnOutcome; missingSession: boolean }> {
    const command = this.options.command ?? ["claude"];
    const proc = Bun.spawn([...command, ...claudeArgs({ ...request, sessionId })], {
      cwd: request.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    proc.stdin.write(request.input);
    await proc.stdin.end();

    const onAbort = () => proc.kill("SIGINT");
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    let stderr = "";
    const stderrDone = (async () => {
      for await (const line of lines(proc.stderr)) stderr = (stderr + line + "\n").slice(-4000);
    })();

    const reader = new StreamReader(request.emit, sessionId);
    for await (const line of lines(proc.stdout)) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      reader.handle(message);
    }
    const code = await proc.exited;
    await stderrDone;
    request.signal.removeEventListener("abort", onAbort);

    if (request.signal.aborted) return { outcome: { status: "interrupted" }, missingSession: false };
    if (reader.outcome) return { outcome: reader.outcome, missingSession: false };
    if (sessionId && !reader.started && /no conversation found|session.*not found/i.test(stderr)) {
      return { outcome: { status: "failed", error: "Session not found." }, missingSession: true };
    }
    const tail = stderr.trim().split("\n").slice(-3).join("\n");
    return {
      outcome: {
        status: "failed",
        error: `Claude stopped unexpectedly (exit code ${code})${tail ? `: ${tail}` : "."}`,
      },
      missingSession: false,
    };
  }
}

/** Turns Claude Code's stream-JSON messages into Staf events. */
export class StreamReader {
  outcome: TurnOutcome | null = null;
  started = false;
  private readonly answer: AnswerText;
  private readonly tools = new Map<string, ToolState>();
  private sawDeltas = false;

  constructor(
    private readonly emit: (event: HarnessEvent) => void,
    private readonly resumedSession: string | null,
  ) {
    this.answer = new AnswerText(emit);
  }

  handle(message: Record<string, unknown>): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && typeof message.session_id === "string") {
          this.started = true;
          if (message.session_id !== this.resumedSession) {
            this.emit({ type: "session", sessionId: message.session_id });
          }
        }
        return;
      case "stream_event":
        this.onStreamEvent(message.event as Record<string, unknown>);
        return;
      case "assistant":
        this.onAssistant(message.message as { content?: Array<Record<string, unknown>> });
        return;
      case "user":
        this.onUser(message.message as { content?: unknown });
        return;
      case "result":
        this.onResult(message);
        return;
    }
  }

  private onStreamEvent(event: Record<string, unknown>): void {
    if (event.type === "content_block_start") {
      const block = event.content_block as { type?: string; id?: string; name?: string };
      if (block.type === "text") this.answer.separate();
      if (block.type === "tool_use" && block.id && block.name) {
        this.answer.toolStarted();
        this.tools.set(block.id, { name: block.name, input: {} });
        this.emit({ type: "activity", activity: toolActivity(block.id, block.name, {}, "running") });
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta as { type?: string; text?: string };
      if (delta.type === "text_delta" && delta.text) {
        this.sawDeltas = true;
        this.answer.append(delta.text);
      }
    }
  }

  private onAssistant(message: { content?: Array<Record<string, unknown>> }): void {
    for (const block of message.content ?? []) {
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (!this.tools.has(block.id)) this.answer.toolStarted();
        this.tools.set(block.id, { name: block.name, input });
        this.emit({ type: "activity", activity: toolActivity(block.id, block.name, input, "running") });
      } else if (block.type === "text" && !this.sawDeltas && typeof block.text === "string") {
        // Without partial messages, text arrives only in whole blocks.
        this.answer.separate();
        this.answer.append(block.text);
      }
    }
  }

  private onUser(message: { content?: unknown }): void {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const tool = this.tools.get(block.tool_use_id);
      if (!tool) continue;
      const output = resultText(block.content);
      const status = block.is_error === true ? "failed" : "done";
      this.emit({
        type: "activity",
        activity: toolActivity(block.tool_use_id, tool.name, tool.input, status, output),
      });
    }
  }

  private onResult(message: Record<string, unknown>): void {
    const text = typeof message.result === "string" ? message.result : "";
    if (message.subtype === "success" && message.is_error !== true) {
      if (!this.answer.text.trim() && text) this.answer.append(text);
      this.outcome = { status: "completed" };
      return;
    }
    const errors = Array.isArray(message.errors) ? (message.errors as unknown[]).map(String).join("; ") : "";
    this.outcome = {
      status: "failed",
      error: text || errors || `Claude could not finish the answer (${String(message.subtype)}).`,
    };
  }
}

/** Maps a Claude Code tool call to a Staf step. */
export function toolActivity(
  id: string,
  name: string,
  input: Record<string, unknown>,
  status: Activity["status"],
  output = "",
): Activity {
  const now = Date.now();
  const base = { id, startedAt: now, status, ...(status === "running" ? {} : { completedAt: now }) };
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Bash": {
      const command = text("command");
      const detail = [command ? `$ ${command}` : "", output].filter(Boolean).join("\n\n");
      return {
        ...base,
        kind: "command",
        title: command ? `Ran ${firstLine(command)}` : "Running a command",
        ...(detail ? { detail: truncate(detail) } : {}),
      };
    }
    case "WebSearch": {
      const query = text("query");
      return { ...base, kind: "search", title: query ? `Searched: ${query}` : "Searching the web" };
    }
    case "WebFetch": {
      const url = text("url");
      return { ...base, kind: "page", title: url ? `Opened ${hostOf(url)}` : "Opening a page" };
    }
    case "Read": {
      const path = text("file_path");
      return { ...base, kind: "file", title: path ? `Read ${basename(path)}` : "Reading a file" };
    }
    case "Edit":
    case "Write": {
      const path = text("file_path");
      return {
        ...base,
        kind: "file",
        title: path ? `Edited ${basename(path)}` : "Editing a file",
        ...(path ? { detail: path } : {}),
        ...(status === "failed" && output ? { detail: truncate(output) } : {}),
      };
    }
    case "Skill": {
      const skill = text("skill") || text("name");
      return { ...base, kind: "tool", title: skill ? `Used the ${skill} skill` : "Used a skill" };
    }
    default:
      return { ...base, kind: "tool", title: `Used ${name}`, ...(output ? { detail: truncate(output) } : {}) };
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join("\n")
    .trim();
}
