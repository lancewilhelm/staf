// Claude through Claude Code's print mode with stream-JSON output, one process per turn.

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, HarnessInfo, ModelInfo, TokenUsage } from "@staf/protocol";
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
import type { HarnessAdapter, HarnessEvent, TurnOutcome, TurnRequest, TurnUsageReport } from "../types.ts";

export interface ClaudeOptions {
  /** Command that starts Claude Code. Tests replace it with a fake. */
  command?: string[];
  /** Claude Code's data folder, where it keeps transcripts. Defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  configDir?: string;
}

export const CLAUDE_NOTE =
  "Uses this computer's Claude Code sign-in, and Claude Code keeps its own copy of each conversation in ~/.claude.";

/**
 * Used when Claude Code cannot list its models. It accepts these aliases and maps them to
 * the newest model of each family.
 */
export const CLAUDE_MODELS: ModelInfo[] = [
  { id: "opus", name: "Opus", isDefault: true },
  { id: "sonnet", name: "Sonnet" },
  { id: "haiku", name: "Haiku" },
];

const CLAUDE_FAST_NOTE = "Faster answers, billed to usage credits on top of the Claude plan";

const SIGN_IN_TTL_MS = 60_000;
const MODELS_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;

/** One entry of the model list in Claude Code's `initialize` response. */
interface ClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsFastMode?: boolean;
}

/**
 * Turns Claude Code's model list into Staf's. The "default" entry is left out, and the first
 * alias that resolves to the same model is marked as the default instead. Fast mode is left
 * out when Claude Code says that the account cannot use it.
 */
export function claudeModels(models: ClaudeModel[], fastAvailable: boolean): ModelInfo[] {
  const fallback = models.find((model) => model.value === "default")?.resolvedModel;
  let defaultMarked = false;
  const list: ModelInfo[] = [];
  for (const model of models) {
    if (model.value === "default") continue;
    const isDefault = !defaultMarked && fallback !== undefined && model.resolvedModel === fallback;
    if (isDefault) defaultMarked = true;
    const efforts = model.supportsEffort ? (model.supportedEffortLevels ?? []) : [];
    const fast = fastAvailable && model.supportsFastMode === true;
    list.push({
      id: model.value,
      name: model.displayName,
      ...(isDefault ? { isDefault: true } : {}),
      ...(efforts.length > 1 ? { efforts } : {}),
      ...(fast ? { fast: true, fastNote: CLAUDE_FAST_NOTE } : {}),
    });
  }
  return list;
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
export function claudeArgs(
  request: Pick<TurnRequest, "sessionId" | "instructions" | "model" | "effort" | "fast" | "access">,
): string[] {
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
    JSON.stringify(claudeSettings(request.access, request.fast)),
    "--append-system-prompt",
    request.instructions,
    ...(request.model ? ["--model", request.model] : []),
    ...(request.effort ? ["--effort", request.effort] : []),
    ...(request.sessionId ? ["--resume", request.sessionId] : []),
    ...request.access.writableFolders.flatMap((folder) => ["--add-dir", folder]),
  ];
}

/**
 * Commands run in Claude Code's sandbox and may not leave it. Network access is open to
 * every domain when the agent allows it, and closed otherwise. Fast mode is set either way,
 * so that the person's own Claude Code setting does not apply.
 */
export function claudeSettings(access: AgentAccess, fast = false): Record<string, unknown> {
  return {
    fastMode: fast,
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
  readonly label = "Claude";
  private signIn: { signedIn: boolean | undefined; at: number } | null = null;
  private models: { list: ModelInfo[]; at: number } | null = null;

  constructor(private readonly options: ClaudeOptions = {}) {}

  async status(): Promise<HarnessInfo> {
    const base: HarnessInfo = {
      id: this.id,
      label: this.label,
      program: "Claude Code",
      signIn: "machine",
      note: CLAUDE_NOTE,
      ready: true,
    };
    if (!this.options.command && !Bun.which("claude")) {
      return { ...base, ready: false, detail: "The claude command is not installed." };
    }
    const signedIn = this.options.command ? undefined : await this.checkSignIn();
    if (signedIn === false) {
      return { ...base, ready: false, signedIn, detail: "Not signed in. Run `claude` once in a terminal and sign in." };
    }
    return { ...base, ...(signedIn !== undefined ? { signedIn } : {}) };
  }

  /** Asks Claude Code for its models, at most every ten minutes, and falls back to the aliases. */
  async listModels(): Promise<ModelInfo[]> {
    if (this.models && Date.now() - this.models.at < MODELS_TTL_MS) return this.models.list;
    let list = CLAUDE_MODELS;
    try {
      const probed = await this.probeModels();
      if (probed.length > 0) list = probed;
    } catch (error) {
      console.warn(`Claude Code did not list its models, so Staf uses the aliases: ${describeError(error)}`);
    }
    this.models = { list, at: Date.now() };
    return list;
  }

  /**
   * Starts Claude Code in stream-JSON mode and sends only the `initialize` request, which
   * returns the model list without sending a message. Fast mode is asked for, so that the
   * response says whether this account can use it.
   */
  private async probeModels(): Promise<ModelInfo[]> {
    const command = this.options.command ?? ["claude"];
    const proc = Bun.spawn(
      [
        ...command,
        "-p",
        "--safe-mode",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--settings",
        JSON.stringify({ fastMode: true }),
      ],
      { cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    const timer = setTimeout(() => proc.kill(), PROBE_TIMEOUT_MS);
    try {
      proc.stdin.write(JSON.stringify({ type: "control_request", request_id: "staf-models", request: { subtype: "initialize" } }) + "\n");
      await proc.stdin.flush();
      for await (const line of lines(proc.stdout)) {
        let message: { type?: string; response?: { request_id?: string; response?: Record<string, unknown> } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type !== "control_response" || message.response?.request_id !== "staf-models") continue;
        const body = message.response.response ?? {};
        const models = Array.isArray(body.models) ? (body.models as ClaudeModel[]) : [];
        return claudeModels(models, body.fast_mode_disabled_reason == null);
      }
      throw new Error("Claude Code closed without an answer.");
    } finally {
      clearTimeout(timer);
      proc.kill();
    }
  }

  /** Drops a reasoning level or fast mode that the model does not offer. */
  private async checkChoice(request: TurnRequest): Promise<TurnRequest> {
    if (!request.effort && !request.fast) return request;
    const models = await this.listModels();
    const info = request.model ? models.find((m) => m.id === request.model) : models.find((m) => m.isDefault);
    // A model that the list does not know, such as a full model ID, gets what was asked for.
    if (!info) return request;
    return {
      ...request,
      effort: request.effort && info.efforts?.includes(request.effort) ? request.effort : null,
      fast: request.fast && info.fast === true,
    };
  }

  /** Deletes Claude Code's transcript of a session and the small files that it keeps beside it. */
  async deleteSession(sessionId: string): Promise<void> {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(sessionId)) throw new Error(`"${sessionId}" is not a Claude session ID.`);
    const root = this.options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    const projects = join(root, "projects");
    if (existsSync(projects)) {
      for (const project of readdirSync(projects)) {
        rmSync(join(projects, project, `${sessionId}.jsonl`), { force: true });
        rmSync(join(projects, project, sessionId), { recursive: true, force: true });
      }
    }
    rmSync(join(root, "session-env", sessionId), { recursive: true, force: true });
    rmSync(join(root, "file-history", sessionId), { recursive: true, force: true });
    const todos = join(root, "todos");
    if (existsSync(todos)) {
      for (const name of readdirSync(todos)) {
        if (name.startsWith(`${sessionId}-`)) rmSync(join(todos, name), { force: true });
      }
    }
  }

  /** Asks `claude auth status`, at most once a minute. Undefined means that Staf could not tell. */
  private async checkSignIn(): Promise<boolean | undefined> {
    if (this.signIn && Date.now() - this.signIn.at < SIGN_IN_TTL_MS) return this.signIn.signedIn;
    let signedIn: boolean | undefined;
    try {
      const proc = Bun.spawn(["claude", "auth", "status"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
      const timer = setTimeout(() => proc.kill(), 5000);
      const text = await new Response(proc.stdout).text();
      clearTimeout(timer);
      const parsed = JSON.parse(text) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === "boolean") signedIn = parsed.loggedIn;
    } catch {
      signedIn = undefined;
    }
    this.signIn = { signedIn, at: Date.now() };
    return signedIn;
  }

  async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    const ready = await this.status();
    if (!ready.ready) return { status: "failed", error: ready.detail ?? "Claude is not ready." };
    try {
      request = await this.checkChoice(request);
      const first = await this.runOnce(request, request.sessionId);
      if (first.missingSession && request.sessionId) {
        // The saved session is gone. Continue in a new one.
        const input = request.inputWithHistory ?? request.input;
        return (await this.runOnce({ ...request, input }, null)).outcome;
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
  private resolvedModel: string | null = null;

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
          if (typeof message.model === "string" && message.model) this.resolvedModel = message.model;
          if (message.session_id !== this.resumedSession) {
            this.emit({ type: "session", sessionId: message.session_id });
          }
        }
        return;
      case "stream_event":
        this.onStreamEvent(message.event as Record<string, unknown>);
        return;
      case "assistant": {
        const assistant = message.message as { model?: unknown; content?: Array<Record<string, unknown>> };
        if (typeof assistant?.model === "string" && assistant.model) this.resolvedModel = assistant.model;
        this.onAssistant(assistant);
        return;
      }
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
    const report = parseClaudeResultReport(message, this.resolvedModel);
    if (message.subtype === "success" && message.is_error !== true) {
      if (!this.answer.text.trim() && text) this.answer.append(text);
      this.outcome = { status: "completed", report };
      return;
    }
    const errors = Array.isArray(message.errors) ? (message.errors as unknown[]).map(String).join("; ") : "";
    this.outcome = {
      status: "failed",
      error: text || errors || `Claude could not finish the answer (${String(message.subtype)}).`,
      report,
    };
  }
}

function parseClaudeResultReport(
  message: Record<string, unknown>,
  resolvedModel: string | null,
): TurnUsageReport {
  const rawUsage = asRecord(message.usage);
  const usage = parseClaudeUsage(rawUsage);
  const modelUsage = asRecord(message.modelUsage);
  const firstModel = modelUsage ? Object.keys(modelUsage)[0] ?? null : null;
  const providerMeta: Record<string, unknown> = {};
  for (const key of [
    "subtype",
    "stop_reason",
    "duration_ms",
    "duration_api_ms",
    "num_turns",
    "total_cost_usd",
    "usage",
    "modelUsage",
  ]) {
    if (message[key] !== undefined) providerMeta[key] = message[key];
  }
  return {
    ...(typeof message.duration_api_ms === "number" ? { apiDurationMs: message.duration_api_ms } : {}),
    ...(resolvedModel ?? firstModel ? { resolvedModel: resolvedModel ?? firstModel } : {}),
    ...(typeof message.stop_reason === "string"
      ? { stopReason: message.stop_reason }
      : typeof message.subtype === "string"
        ? { stopReason: message.subtype }
        : {}),
    ...(typeof message.num_turns === "number" ? { turns: message.num_turns } : {}),
    ...(typeof message.total_cost_usd === "number" ? { costUsd: message.total_cost_usd } : {}),
    ...(usage ? { usage } : {}),
    ...(Object.keys(providerMeta).length > 0 ? { providerMeta } : {}),
  };
}

function parseClaudeUsage(raw: Record<string, unknown> | null): TokenUsage | undefined {
  if (!raw) return undefined;
  const inputTokens = asNumber(raw.input_tokens);
  const outputTokens = asNumber(raw.output_tokens);
  const cachedInputTokens = asNumber(raw.cache_read_input_tokens);
  const cacheCreationTokens = asNumber(raw.cache_creation_input_tokens);
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationTokens ?? 0)
      : undefined;
  const usage: TokenUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
