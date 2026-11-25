// A harness adapter for agents that speak the Agent Client Protocol (ACP) over stdio.
// https://agentclientprotocol.com. Antigravity (`agy acp`) is the first one.

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Activity, HarnessInfo, ModelInfo } from "@staf/protocol";
import type { AgentAccess } from "../../agents.ts";
import { VERSION } from "../../config.ts";
import {
  AnswerText,
  basename,
  describeError,
  firstLine,
  hostOf,
  truncate,
} from "../activities.ts";
import { RpcError, RpcProcess } from "../rpc.ts";
import type { HarnessAdapter, TurnOutcome, TurnRequest } from "../types.ts";

/** The parts of an ACP tool call that Staf reads. Updates may carry only some fields. */
export interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path: string }>;
  content?: Array<Record<string, unknown>>;
}

export interface PermissionContext {
  toolCall: AcpToolCall;
  /** The agent's workspace. */
  cwd: string;
  access: AgentAccess;
}

export interface AcpOptions {
  id: string;
  /** Short name, such as "Gemini". */
  label: string;
  /** The program behind it, such as "Antigravity". */
  program: string;
  /** One line about how this harness differs from the others. */
  note?: string;
  experimental?: boolean;
  /** The command that starts the ACP server. */
  command: string[];
  /** Fields for `_meta` on session/new and session/load, such as a system prompt. */
  sessionMeta?: (instructions: string) => Record<string, unknown>;
  /** Decides a permission request. The default policy is `defaultPermission`. */
  permission?: (context: PermissionContext) => boolean;
  /** Settings that this harness cannot honor, described for a note step. */
  unsupported?: (access: AgentAccess) => string[];
  /** A command that must exist for the harness to be ready. */
  requires?: string;
  /** Text to show when the agent says that it needs a sign-in. */
  signInHint?: string;
  /** Where to cache the model list between runs. */
  modelsCache?: string;
  /** Deletes the files that the harness keeps for a session. ACP has no call for it. */
  deleteSessionFiles?: (sessionId: string) => void;
  idleMs?: number;
}

/** The model list that ACP agents return from session/new and session/load. */
interface SessionModels {
  availableModels?: Array<{ modelId: string; name?: string }>;
  currentModelId?: string;
}

interface ActiveTurn {
  sessionId: string;
  cwd: string;
  access: AgentAccess;
  answer: AnswerText;
  emit: TurnRequest["emit"];
  tools: Map<string, AcpToolCall>;
  /** Steps that Staf refused, by title. */
  refused: string[];
}

const IDLE_MS = 10 * 60 * 1000;

export class AcpAdapter implements HarnessAdapter {
  readonly id: string;
  readonly label: string;

  private rpc: RpcProcess | null = null;
  private starting: Promise<RpcProcess> | null = null;
  private readonly loaded = new Set<string>();
  private readonly turns = new Map<string, ActiveTurn>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The model that each loaded session uses, so that a change is sent only once. */
  private readonly sessionModels = new Map<string, string>();
  private models: { list: ModelInfo[]; defaultId: string | null } | null = null;

  constructor(private readonly options: AcpOptions) {
    this.id = options.id;
    this.label = options.label;
  }

  async status(): Promise<HarnessInfo> {
    const base: HarnessInfo = {
      id: this.id,
      label: this.label,
      program: this.options.program,
      signIn: "machine",
      ready: true,
      ...(this.options.note ? { note: this.options.note } : {}),
      ...(this.options.experimental ? { experimental: true } : {}),
    };
    const required = this.options.requires;
    if (required && !Bun.which(required)) {
      return { ...base, ready: false, detail: `The ${required} command is not installed.` };
    }
    return base;
  }

  async listModels(): Promise<ModelInfo[]> {
    this.models ??= this.readModelCache();
    if (this.models) return this.models.list;
    // The model list only comes with a session, so open one in an empty folder and delete it.
    const ready = await this.status();
    if (!ready.ready) throw new Error(ready.detail ?? `${this.label} is not ready.`);
    this.clearIdleTimer();
    const cwd = mkdtempSync(join(tmpdir(), "staf-models-"));
    try {
      const rpc = await this.connect();
      const meta = this.options.sessionMeta?.("");
      const created = await rpc.request<{ sessionId: string; models?: SessionModels }>("session/new", {
        cwd,
        mcpServers: [],
        ...(meta ? { _meta: meta } : {}),
      });
      this.rememberModels(created.models, true);
      this.loaded.add(created.sessionId);
      await this.deleteSession(created.sessionId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      if (this.turns.size === 0) this.startIdleTimer();
    }
    // rememberModels() filled the cache, which TypeScript cannot see through the call.
    return (this.models as { list: ModelInfo[] } | null)?.list ?? [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (this.loaded.has(sessionId) && this.rpc?.alive) {
      await this.rpc.request("session/close", { sessionId }).catch(() => {});
    }
    this.loaded.delete(sessionId);
    this.sessionModels.delete(sessionId);
    this.options.deleteSessionFiles?.(sessionId);
  }

  /** Keeps the model list from a session response. `fresh` marks a new session, whose model is the default. */
  private rememberModels(models: SessionModels | undefined, fresh: boolean): void {
    if (!models?.availableModels?.length) return;
    const defaultId = fresh ? (models.currentModelId ?? null) : (this.models?.defaultId ?? null);
    const list = models.availableModels.map((model) => ({
      id: model.modelId,
      name: model.name ?? model.modelId,
      ...(model.modelId === defaultId ? { isDefault: true } : {}),
    }));
    this.models = { list, defaultId };
    if (this.options.modelsCache) {
      try {
        writeFileSync(this.options.modelsCache, JSON.stringify(this.models, null, 2) + "\n");
      } catch {
        // The cache only saves a lookup.
      }
    }
  }

  private readModelCache(): { list: ModelInfo[]; defaultId: string | null } | null {
    if (!this.options.modelsCache) return null;
    try {
      return JSON.parse(readFileSync(this.options.modelsCache, "utf8")) as { list: ModelInfo[]; defaultId: string | null };
    } catch {
      return null;
    }
  }

  async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.clearIdleTimer();
    try {
      return await this.run(request);
    } catch (error) {
      return { status: "failed", error: this.explain(error) };
    } finally {
      if (this.turns.size === 0) this.startIdleTimer();
    }
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    this.rpc?.kill();
    this.rpc = null;
    this.loaded.clear();
    this.sessionModels.clear();
  }

  private async run(request: TurnRequest): Promise<TurnOutcome> {
    const ready = await this.status();
    if (!ready.ready) return { status: "failed", error: ready.detail ?? `${this.label} is not ready.` };

    for (const problem of this.options.unsupported?.(request.access) ?? []) {
      const now = Date.now();
      request.emit({
        type: "activity",
        activity: {
          id: `unsupported-${problem}`,
          kind: "note",
          title: firstLine(problem),
          detail: problem,
          status: "failed",
          startedAt: now,
          completedAt: now,
        },
      });
    }

    const rpc = await this.connect();
    const meta = this.options.sessionMeta?.(request.instructions);
    const sessionParams = {
      cwd: request.cwd,
      mcpServers: [],
      ...(meta ? { _meta: meta } : {}),
    };

    let sessionId = request.sessionId;
    let input = request.input;
    if (sessionId && !this.loaded.has(sessionId)) {
      try {
        const loaded = await rpc.request<{ models?: SessionModels } | null>("session/load", { ...sessionParams, sessionId });
        this.rememberModels(loaded?.models, false);
        if (loaded?.models?.currentModelId) this.sessionModels.set(sessionId, loaded.models.currentModelId);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        // The saved session is gone. A new one gets the conversation so far.
        sessionId = null;
        input = request.inputWithHistory ?? request.input;
      }
    }
    if (!sessionId) {
      const created = await rpc.request<{ sessionId: string; models?: SessionModels }>("session/new", sessionParams);
      sessionId = created.sessionId;
      this.rememberModels(created.models, true);
      if (created.models?.currentModelId) this.sessionModels.set(sessionId, created.models.currentModelId);
      request.emit({ type: "session", sessionId });
    }
    this.loaded.add(sessionId);
    await this.applyModel(rpc, sessionId, request);

    if (this.turns.has(sessionId)) {
      return { status: "failed", error: "This conversation already has an answer in progress." };
    }
    const turn: ActiveTurn = {
      sessionId,
      cwd: request.cwd,
      access: request.access,
      answer: new AnswerText(request.emit),
      emit: request.emit,
      tools: new Map(),
      refused: [],
    };
    this.turns.set(sessionId, turn);
    const onAbort = () => rpc.notify("session/cancel", { sessionId });
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    try {
      const result = await rpc.request<{ stopReason: string }>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: input }],
      });
      const outcome = outcomeFor(result.stopReason, request.signal.aborted);
      if (outcome.status === "completed" && !turn.answer.text.trim() && turn.refused.length > 0) {
        // ACP agents end the turn when a permission is refused, without saying why.
        turn.answer.append(
          `Staf refused a step that is outside this agent's permissions (${turn.refused.join("; ")}), and ${this.label} stopped there.`,
        );
      }
      return outcome;
    } catch (error) {
      if (request.signal.aborted) return { status: "interrupted" };
      return { status: "failed", error: this.explain(error) };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      this.turns.delete(sessionId);
    }
  }

  /** Switches the session to the requested model, or back to the default, when it differs. */
  private async applyModel(rpc: RpcProcess, sessionId: string, request: TurnRequest): Promise<void> {
    const wanted = request.model ?? this.models?.defaultId ?? null;
    if (!wanted || this.sessionModels.get(sessionId) === wanted) return;
    try {
      await rpc.request("session/set_model", { sessionId, modelId: wanted });
      this.sessionModels.set(sessionId, wanted);
    } catch (error) {
      const now = Date.now();
      request.emit({
        type: "activity",
        activity: {
          id: "model-not-set",
          kind: "note",
          title: `Could not use the model "${wanted}"`,
          detail: describeError(error),
          status: "failed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
  }

  private async connect(): Promise<RpcProcess> {
    if (this.rpc?.alive) return this.rpc;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const rpc = new RpcProcess(
        this.options.command,
        { ...process.env },
        {
          onNotification: (method, params) => this.onNotification(method, params),
          onRequest: (method, params) => this.onRequest(method, params),
          onExit: (code, stderrTail) => this.onExit(rpc, code, stderrTail),
        },
        { jsonrpc: true },
      );
      try {
        await rpc.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "staf", title: "Staf", version: VERSION },
        });
      } catch (error) {
        rpc.kill();
        throw error;
      }
      this.rpc = rpc;
      return rpc;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private onExit(rpc: RpcProcess, code: number | null, stderrTail: string): void {
    if (this.rpc === rpc) this.rpc = null;
    this.loaded.clear();
    this.sessionModels.clear();
    // Prompts that were waiting fail through their rejected requests.
    void code;
    void stderrTail;
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") {
      throw new RpcError(-32601, `Staf does not handle ${method}.`);
    }
    const { sessionId, toolCall, options } = params as {
      sessionId: string;
      toolCall: AcpToolCall;
      options: Array<{ optionId: string; kind: string }>;
    };
    const turn = this.turns.get(sessionId);
    const merged = { ...(turn?.tools.get(toolCall.toolCallId) ?? {}), ...toolCall };
    const allowed =
      turn !== undefined &&
      (this.options.permission ?? defaultPermission)({ toolCall: merged, cwd: turn.cwd, access: turn.access });
    if (turn && !allowed) turn.refused.push(activityFromToolCall(merged).title);
    if (process.env.STAF_DEBUG?.split(",").includes("acp")) {
      console.error(
        `[acp] permission ${allowed ? "allowed" : "refused"}: ${JSON.stringify({ kind: toolCall.kind, title: toolCall.title, locations: toolCall.locations, cwd: turn?.cwd, rawInput: toolCall.rawInput })}`,
      );
    }
    const choice = options.find((option) => option.kind === (allowed ? "allow_once" : "reject_once"));
    if (!choice) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: choice.optionId } };
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") return;
    const { sessionId, update } = params as { sessionId: string; update: Record<string, unknown> };
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    if (process.env.STAF_DEBUG?.split(",").includes("acp") && update.sessionUpdate !== "agent_thought_chunk") {
      console.error(`[acp] update ${JSON.stringify(update).slice(0, 400)}`);
    }

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) turn.answer.append(content.text);
        return;
      }
      case "tool_call": {
        const call = update as unknown as AcpToolCall;
        turn.answer.toolStarted();
        turn.tools.set(call.toolCallId, call);
        turn.emit({ type: "activity", activity: activityFromToolCall(call) });
        return;
      }
      case "tool_call_update": {
        const change = update as unknown as AcpToolCall;
        const merged = { ...(turn.tools.get(change.toolCallId) ?? {}), ...change };
        turn.tools.set(change.toolCallId, merged);
        turn.emit({ type: "activity", activity: activityFromToolCall(merged) });
        return;
      }
    }
  }

  private explain(error: unknown): string {
    const message = describeError(error);
    if (/auth|sign.?in|log.?in|credential/i.test(message) && this.options.signInHint) {
      return `${message}. ${this.options.signInHint}`;
    }
    return message;
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.turns.size === 0) void this.close();
    }, this.options.idleMs ?? IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

function outcomeFor(stopReason: string, aborted: boolean): TurnOutcome {
  if (stopReason === "cancelled" || aborted) return { status: "interrupted" };
  if (stopReason === "refusal") return { status: "failed", error: "The model declined to answer." };
  return { status: "completed" };
}

/**
 * Staf's permission rules for ACP agents: reading, searching, and running commands are
 * allowed (the harness sandbox limits commands), and file changes are allowed only inside
 * the workspace and the agent's writable folders.
 */
export function defaultPermission({ toolCall, cwd, access }: PermissionContext): boolean {
  switch (toolCall.kind) {
    case "edit":
    case "delete":
    case "move": {
      const paths = (toolCall.locations ?? []).map((location) => location.path);
      if (paths.length === 0) return false;
      const roots = [cwd, ...access.writableFolders];
      return paths.every((path) => roots.some((root) => isInside(path, root)));
    }
    default:
      return true;
  }
}

/** Whether `path` is `root` or inside it, after resolving symbolic links. */
export function isInside(path: string, root: string): boolean {
  const target = realish(path);
  const base = realish(root);
  return target === base || target.startsWith(base + sep);
}

/** Resolves symbolic links for the longest part of the path that exists. */
function realish(path: string): string {
  let current = resolve(path);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync(current) : current;
  return rest.length ? resolve(real, ...rest) : real;
}

/** Maps an ACP tool call to a Staf step. */
export function activityFromToolCall(call: AcpToolCall): Activity {
  const now = Date.now();
  const input = call.rawInput ?? {};
  const status =
    call.status === "completed" ? "done" : call.status === "failed" ? "failed" : "running";
  const base = {
    id: call.toolCallId,
    startedAt: now,
    status,
    ...(status === "running" ? {} : { completedAt: now }),
  } as const;
  const paths = (call.locations ?? []).map((location) => location.path);
  const output = contentText(call.content);
  const title = call.title ?? "a tool";

  switch (call.kind) {
    case "search": {
      const query = typeof input.query === "string" ? input.query : null;
      return { ...base, kind: "search", title: query ? `Searched: ${query}` : `Searched ${title}` };
    }
    case "fetch": {
      const url = typeof input.url === "string" ? input.url : typeof input.Url === "string" ? input.Url : null;
      return { ...base, kind: "page", title: url ? `Opened ${hostOf(url)}` : `Opened ${title}` };
    }
    case "execute": {
      const command =
        typeof input.CommandLine === "string"
          ? input.CommandLine
          : typeof input.command === "string"
            ? input.command
            : title;
      const detail = [`$ ${command}`, output].filter(Boolean).join("\n\n");
      // Antigravity reports a command as completed even when it exits with an error.
      const exit = /exited with code (\d+)/.exec(output);
      const failed = base.status === "done" && exit !== null && exit[1] !== "0";
      return {
        ...base,
        ...(failed ? { status: "failed" as const } : {}),
        kind: "command",
        title: `Ran ${firstLine(command)}`,
        detail: truncate(detail),
      };
    }
    case "edit":
    case "delete":
    case "move": {
      const verb = call.kind === "delete" ? "Deleted" : call.kind === "move" ? "Moved" : "Edited";
      const name = paths.length === 1 ? basename(paths[0]!) : `${paths.length} files`;
      return { ...base, kind: "file", title: `${verb} ${paths.length ? name : title}`, detail: paths.join("\n") };
    }
    case "read":
      return {
        ...base,
        kind: "file",
        title: paths.length === 1 ? `Read ${basename(paths[0]!)}` : `Read ${title}`,
      };
    case "think":
      return { ...base, kind: "reasoning", title: "Thought it through", ...(output ? { detail: truncate(output) } : {}) };
    default:
      return { ...base, kind: "tool", title: `Used ${title}`, ...(output ? { detail: truncate(output) } : {}) };
  }
}

function contentText(content: AcpToolCall["content"]): string {
  if (!content) return "";
  const parts: string[] = [];
  for (const item of content) {
    const inner = item.content as { type?: string; text?: string } | undefined;
    if (item.type === "content" && inner?.type === "text" && inner.text) parts.push(inner.text);
  }
  return parts.join("\n").trim();
}
