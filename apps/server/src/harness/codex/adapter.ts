import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, HarnessInfo, ModelInfo, TokenUsage } from "@staf/protocol";
import type { AgentAccess } from "../../agents.ts";
import { VERSION } from "../../config.ts";
import type { McpBridgeConfig } from "../../mcp/tokens.ts";
import type { HarnessAdapter, HarnessEvent, TurnOutcome, TurnRequest, TurnUsageReport } from "../types.ts";
import type {
  AgentMessageDelta,
  ErrorNotification,
  ItemNotification,
  ThreadItem,
  ThreadOptions,
  ThreadResponse,
  TurnCompletedNotification,
  TurnStartResponse,
} from "./protocol.ts";
import {
  basename,
  describeError as describe,
  describeStafTool,
  firstLine,
  hostOf,
  noteActivity,
  truncate,
} from "../activities.ts";
import { RpcError, RpcProcess } from "../rpc.ts";

export interface CodexOptions {
  /** CODEX_HOME for Staf's own sign-in and configuration. */
  codexHome: string;
  /** Command that starts the app server. Tests replace it with a fake. */
  command?: string[];
  /** Stop the app server after this long without a turn. */
  idleMs?: number;
  /** Called when the sign-in changes, for example after a sign-in in the browser. */
  onStatusChange?: () => void;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  emit: (event: HarnessEvent) => void;
  /** Agent message phases by item ID, such as "commentary" or "final_answer". */
  phases: Map<string, string | null>;
  /** Item IDs of answer messages that have streamed at least one delta. */
  streamed: Set<string>;
  wroteAnswer: boolean;
  lastError: string | null;
  resolvedModel: string | null;
  recovered: boolean;
  modelCalls: number;
  report?: TurnUsageReport;
  /** The thread's token totals before this turn, worked out from the first usage update. */
  usageBase?: Record<string, number>;
  finish: (outcome: TurnOutcome) => void;
}

/** One app that comes with the ChatGPT account, such as a connector. */
export interface CodexApp {
  id: string;
  name: string;
  /** Whether Codex reports the app as connected and usable. */
  accessible: boolean;
}

/** Where `staf apps` caches the account's apps, so that turns can map names to IDs. */
const APP_CATALOG = "staf-apps.json";
const IDLE_MS = 10 * 60 * 1000;
const MODELS_TTL_MS = 10 * 60 * 1000;
/** Codex's service tier for fast mode, which ChatGPT names "Fast". */
const FAST_TIER = "priority";

/** The fields of a `model/list` entry that Staf uses. */
interface CodexModel {
  id: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort?: string | null;
  serviceTiers?: Array<{ id: string; name: string; description?: string }>;
}

function toModelInfo(model: CodexModel): ModelInfo {
  const efforts = (model.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  const fast = model.serviceTiers?.find((tier) => tier.id === FAST_TIER);
  return {
    id: model.id,
    name: model.displayName,
    ...(model.isDefault ? { isDefault: true } : {}),
    ...(efforts.length > 1 ? { efforts } : {}),
    ...(efforts.length > 1 && model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
    ...(fast ? { fast: true, ...(fast.description ? { fastNote: fast.description } : {}) } : {}),
  };
}

export const CODEX_NOTE = "Uses Staf's own ChatGPT sign-in. Account apps such as Gmail stay off unless an agent allows them.";

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly label = "ChatGPT";

  private rpc: RpcProcess | null = null;
  private starting: Promise<RpcProcess> | null = null;
  /** Codex threads that the current app server has started or resumed. */
  private readonly loaded = new Set<string>();
  private readonly turns = new Map<string, ActiveTurn>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private models: { list: ModelInfo[]; at: number } | null = null;
  /** The signed-in account, read after the app server starts. */
  private account: string | null = null;

  constructor(private readonly options: CodexOptions) {}

  async status(): Promise<HarnessInfo> {
    const base: HarnessInfo = {
      id: this.id,
      label: this.label,
      program: "Codex",
      signIn: "staf",
      note: CODEX_NOTE,
      ready: true,
    };
    if (!this.options.command && !Bun.which("codex")) {
      return { ...base, ready: false, detail: "The codex command is not installed." };
    }
    if (!this.options.command && !existsSync(join(this.options.codexHome, "auth.json"))) {
      return { ...base, ready: false, signedIn: false, detail: "Not signed in. Sign in under Settings → Providers, or run `staf login codex`." };
    }
    return { ...base, signedIn: true, ...(this.account ? { account: this.account } : {}) };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.models && Date.now() - this.models.at < MODELS_TTL_MS) return this.models.list;
    const ready = await this.status();
    if (!ready.ready) throw new Error(ready.detail ?? "Codex is not ready.");
    const rpc = await this.connect();
    const list: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: CodexModel[]; nextCursor: string | null } = await rpc.request("model/list", { cursor, limit: 100 });
      for (const model of page.data) {
        if (!model.hidden) list.push(toModelInfo(model));
      }
      cursor = page.nextCursor;
    } while (cursor);
    this.models = { list, at: Date.now() };
    this.startIdleTimerIfIdle();
    return list;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const ready = await this.status();
    if (!ready.ready) throw new Error(ready.detail ?? "Codex is not ready.");
    const rpc = await this.connect();
    try {
      await rpc.request("thread/delete", { threadId: sessionId });
    } catch (error) {
      // A thread that Codex no longer has is already gone.
      if (!(error instanceof RpcError) || !/not found|no thread|unknown thread/i.test(error.message)) throw error;
    } finally {
      this.loaded.delete(sessionId);
      this.startIdleTimerIfIdle();
    }
  }

  /**
   * Starts a ChatGPT sign-in for Staf's Codex home and returns the page to open. Codex
   * listens for the browser's answer on this computer, so the browser must run here too.
   */
  async startLogin(): Promise<{ url: string }> {
    if (!this.options.command && !Bun.which("codex")) throw new Error("The codex command is not installed.");
    const rpc = await this.connect();
    const started = await rpc.request<{ type: string; authUrl?: string }>("account/login/start", { type: "chatgpt" });
    if (!started.authUrl) throw new Error("Codex did not return a sign-in page.");
    return { url: started.authUrl };
  }

  async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.clearIdleTimer();
    try {
      return await this.run(request);
    } catch (error) {
      return { status: "failed", error: describe(error) };
    } finally {
      if (this.turns.size === 0) this.startIdleTimer();
    }
  }

  async close(): Promise<void> {
    this.clearIdleTimer();
    this.rpc?.kill();
    this.rpc = null;
    this.loaded.clear();
  }

  private async run(request: TurnRequest): Promise<TurnOutcome> {
    const ready = await this.status();
    if (!ready.ready) return { status: "failed", error: ready.detail ?? "Codex is not ready." };

    const rpc = await this.connect();
    const { config, unresolved } = codexThreadConfig(request.access, this.readAppCatalog(), request.mcp);
    for (const name of unresolved) {
      const now = Date.now();
      request.emit({
        type: "activity",
        activity: {
          id: `app-missing-${name}`,
          kind: "note",
          title: `Skipped the app "${name}"`,
          detail: `Staf could not find an app named "${name}" on this ChatGPT account. Run \`staf apps\` to list the apps and refresh Staf's list.`,
          status: "failed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
    const threadOptions: ThreadOptions = {
      cwd: request.cwd,
      model: request.model,
      sandbox: "workspace-write",
      approvalPolicy: "never",
      developerInstructions: request.instructions,
      config,
    };

    let threadId = request.sessionId;
    let input = request.input;
    let threadModel: string | null = null;
    let recovered = false;
    if (threadId && !this.loaded.has(threadId)) {
      try {
        const resumed = await rpc.request<ThreadResponse>("thread/resume", {
          ...threadOptions,
          threadId,
          excludeTurns: true,
        });
        threadModel = resumed.model ?? null;
      } catch (error) {
        // The saved Codex thread is gone. Continue in a new one that gets the conversation so far.
        if (!(error instanceof RpcError)) throw error;
        threadId = null;
        recovered = true;
        input = request.inputWithHistory ?? request.input;
      }
    }
    if (!threadId) {
      const started = await rpc.request<ThreadResponse>("thread/start", threadOptions);
      threadId = started.thread.id;
      threadModel = started.model ?? null;
      request.emit({ type: "session", sessionId: threadId });
    }
    this.loaded.add(threadId);

    if (this.turns.has(threadId)) {
      return { status: "failed", error: "This conversation already has an answer in progress." };
    }

    const outcome = new Promise<TurnOutcome>((resolve) => {
      const turn: ActiveTurn = {
        threadId: threadId!,
        turnId: null,
        emit: request.emit,
        phases: new Map(),
        streamed: new Set(),
        wroteAnswer: false,
        lastError: null,
        resolvedModel: threadModel,
        recovered,
        modelCalls: 0,
        finish: (result) => {
          if (this.turns.get(turn.threadId) !== turn) return;
          this.turns.delete(turn.threadId);
          request.signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
      };
      const onAbort = () => {
        if (turn.turnId) {
          rpc
            .request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId })
            .catch(() => turn.finish({ status: "interrupted", report: buildCodexReport(turn, "interrupted") }));
        }
      };
      this.turns.set(turn.threadId, turn);
      request.signal.addEventListener("abort", onAbort, { once: true });
    });

    const turn = this.turns.get(threadId)!;
    try {
      // The model, level, and tier apply to this turn and later ones, so a change takes
      // effect at once. Defaults are named, in case the thread used something else before.
      const models = await this.listModels().catch(() => [] as ModelInfo[]);
      const info = request.model ? models.find((m) => m.id === request.model) : models.find((m) => m.isDefault);
      const model = request.model ?? info?.id ?? null;
      if (model) turn.resolvedModel = model;
      const effort =
        request.effort && info?.efforts?.includes(request.effort) ? request.effort : (info?.defaultEffort ?? null);
      const started = await rpc.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: input, text_elements: [] }],
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        serviceTier: request.fast && info?.fast ? FAST_TIER : null,
      });
      turn.turnId = started.turn.id;
      if (request.signal.aborted) {
        await rpc.request("turn/interrupt", { threadId, turnId: turn.turnId }).catch(() => {});
      }
    } catch (error) {
      turn.finish({ status: "failed", error: describe(error) });
    }
    return outcome;
  }

  /**
   * Asks Codex for the apps that it knows about, and caches the connected ones for name
   * lookups.
   * Codex can take up to a minute to answer the first time.
   */
  async listApps(): Promise<CodexApp[]> {
    const ready = await this.status();
    if (!ready.ready) throw new Error(ready.detail ?? "Codex is not ready.");
    const rpc = await this.connect();
    // Listing apps for a thread is much faster than listing them without one.
    const thread = await rpc.request<ThreadResponse>("thread/start", {
      cwd: tmpdir(),
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    });
    const apps: CodexApp[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: Array<{ id: string; name: string; isAccessible: boolean }>; nextCursor?: string | null } =
        await rpc.request("app/list", { threadId: thread.thread.id, limit: 200, cursor });
      for (const app of page.data) apps.push({ id: app.id, name: app.name, accessible: app.isAccessible });
      // The list includes ChatGPT's whole app directory; most of it is not connected.
      cursor = page.nextCursor ?? null;
    } while (cursor);
    apps.sort((a, b) => a.name.localeCompare(b.name));
    const connected = apps.filter((app) => app.accessible);
    writeFileSync(join(this.options.codexHome, APP_CATALOG), JSON.stringify(connected, null, 2) + "\n");
    return apps;
  }

  private readAppCatalog(): CodexApp[] {
    try {
      return JSON.parse(readFileSync(join(this.options.codexHome, APP_CATALOG), "utf8")) as CodexApp[];
    } catch {
      return [];
    }
  }

  private async connect(): Promise<RpcProcess> {
    if (this.rpc?.alive) return this.rpc;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const rpc = new RpcProcess(
        this.options.command ?? ["codex", "app-server"],
        { ...process.env, CODEX_HOME: this.options.codexHome },
        {
          onNotification: (method, params) => this.onNotification(method, params),
          onRequest: async (method) => {
            // Chat runs use approvalPolicy "never", so Codex should not ask.
            // Anything that still arrives is declined until Staf has approvals.
            throw new RpcError(-32601, `Staf does not handle ${method} yet.`);
          },
          onExit: (code, stderrTail) => this.onExit(rpc, code, stderrTail),
        },
      );
      try {
        await rpc.request("initialize", {
          clientInfo: { name: "staf", title: "Staf", version: VERSION },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
      } catch (error) {
        rpc.kill();
        throw error;
      }
      rpc.notify("initialized");
      this.rpc = rpc;
      void this.readAccount(rpc);
      return rpc;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async readAccount(rpc: RpcProcess): Promise<void> {
    try {
      const result = await rpc.request<{ account: { type: string; email?: string | null } | null }>("account/read", {});
      const next = result.account?.email ?? (result.account ? "ChatGPT account" : null);
      if (next !== this.account) {
        this.account = next;
        this.options.onStatusChange?.();
      }
    } catch {
      // Older Codex versions do not have account/read.
    }
  }

  private onExit(rpc: RpcProcess, code: number | null, stderrTail: string): void {
    if (this.rpc === rpc) this.rpc = null;
    this.loaded.clear();
    const tail = stderrTail.trim().split("\n").slice(-3).join("\n");
    const error = `Codex stopped unexpectedly (exit code ${code})${tail ? `: ${tail}` : "."}`;
    for (const turn of [...this.turns.values()]) turn.finish({ status: "failed", error });
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "account/login/completed" || method === "account/updated") {
      this.models = null;
      if (this.rpc) void this.readAccount(this.rpc);
      this.options.onStatusChange?.();
      return;
    }
    const threadId = (params as { threadId?: string } | null)?.threadId;
    if (!threadId) return;
    const turn = this.turns.get(threadId);
    if (!turn) return;
    const turnId = (params as { turnId?: string }).turnId;
    if (turnId && turn.turnId && turnId !== turn.turnId) return;

    switch (method) {
      case "item/started":
        this.onItem(turn, (params as ItemNotification).item, false);
        break;
      case "item/completed":
        this.onItem(turn, (params as ItemNotification).item, true);
        break;
      case "item/agentMessage/delta": {
        const delta = params as AgentMessageDelta;
        if (turn.phases.get(delta.itemId) === "commentary") break;
        this.writeAnswer(turn, delta.itemId, delta.delta);
        break;
      }
      case "error": {
        const error = params as ErrorNotification;
        if (!error.willRetry) turn.lastError = error.error.message;
        break;
      }
      case "thread/tokenUsage/updated": {
        const parsed = parseCodexUsage(params, turn.usageBase);
        turn.usageBase = parsed.base;
        turn.modelCalls += 1;
        turn.report = parsed.report;
        break;
      }
      case "turn/completed": {
        const { turn: done } = params as TurnCompletedNotification;
        if (turn.turnId && done.id !== turn.turnId) break;
        const report = buildCodexReport(turn, done.status);
        if (done.status === "interrupted") turn.finish({ status: "interrupted", report });
        else if (done.status === "failed") {
          turn.finish({
            status: "failed",
            error: done.error?.message ?? turn.lastError ?? "Codex could not finish the answer.",
            report,
          });
        } else turn.finish({ status: "completed", report });
        break;
      }
    }
  }

  private onItem(turn: ActiveTurn, item: ThreadItem, completed: boolean): void {
    if (item.type === "agentMessage") {
      const message = item as Extract<ThreadItem, { type: "agentMessage" }>;
      turn.phases.set(message.id, message.phase);
      if (!completed) return;
      if (message.phase === "commentary") {
        if (message.text.trim()) {
          turn.emit({ type: "activity", activity: noteActivity(message.id, message.text) });
        }
      } else if (!turn.streamed.has(message.id) && message.text) {
        // No deltas arrived for this message, so send the whole text now.
        this.writeAnswer(turn, message.id, message.text);
      }
      return;
    }
    const activity = activityFromItem(item, completed);
    if (activity) turn.emit({ type: "activity", activity });
  }

  private writeAnswer(turn: ActiveTurn, itemId: string, text: string): void {
    if (!text) return;
    if (!turn.streamed.has(itemId)) {
      // A second answer message in the same turn starts a new paragraph.
      if (turn.wroteAnswer) turn.emit({ type: "text", text: "\n\n" });
      turn.streamed.add(itemId);
    }
    turn.wroteAnswer = true;
    turn.emit({ type: "text", text });
  }

  private startIdleTimerIfIdle(): void {
    if (this.turns.size === 0 && !this.idleTimer) this.startIdleTimer();
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    const idleMs = this.options.idleMs ?? IDLE_MS;
    this.idleTimer = setTimeout(() => {
      if (this.turns.size === 0) void this.close();
    }, idleMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

/**
 * Turns an agent's access settings into Codex thread config. Account apps are off unless
 * the agent names them, and the named ones cannot take destructive actions. Computer use,
 * browser use, and Codex plugins are always off.
 */
export function codexThreadConfig(
  access: AgentAccess,
  catalog: CodexApp[],
  mcp?: McpBridgeConfig,
): { config: Record<string, unknown>; unresolved: string[] } {
  const ids: string[] = [];
  const unresolved: string[] = [];
  for (const wanted of access.harnessApps) {
    const byId = catalog.find((app) => app.id === wanted);
    const byName = catalog.find((app) => app.name.toLowerCase() === wanted.toLowerCase());
    const looksLikeId = /^(connector|asdk_app)_/.test(wanted);
    const id = byId?.id ?? byName?.id ?? (looksLikeId ? wanted : null);
    if (id) ids.push(id);
    else unresolved.push(wanted);
  }

  const config: Record<string, unknown> = {
    web_search: "live",
    analytics: {
      enabled: false,
    },
    features: {
      apps: ids.length > 0,
      plugins: false,
      computer_use: false,
      browser_use: false,
      browser_use_external: false,
      in_app_browser: false,
      // Staf keeps memory itself, per agent. Codex's memory belongs to the whole account.
      memories: false,
    },
    sandbox_workspace_write: {
      network_access: access.network,
      writable_roots: access.writableFolders,
    },
  };
  if (ids.length > 0) {
    const apps: Record<string, unknown> = { _default: { enabled: false, destructive_enabled: false } };
    for (const id of ids) apps[id] = { enabled: true, destructive_enabled: false };
    config.apps = apps;
  }
  if (mcp) {
    config.mcp_servers = {
      staf: {
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
        // Approvals for Staf tools are enforced inside Staf's MCP server, not by Codex.
        default_tools_approval_mode: "approve",
      },
    };
  }
  return { config, unresolved };
}

/** Maps a Codex thread item to a Staf activity, or null if it is not worth showing. */
export function activityFromItem(item: ThreadItem, completed: boolean): Activity | null {
  const now = Date.now();
  const base = {
    id: item.id,
    startedAt: now,
    status: completed ? ("done" as const) : ("running" as const),
    ...(completed ? { completedAt: now } : {}),
  };
  switch (item.type) {
    case "webSearch": {
      const search = item as Extract<ThreadItem, { type: "webSearch" }>;
      return { ...base, ...describeSearch(search, completed) };
    }
    case "commandExecution": {
      const command = item as Extract<ThreadItem, { type: "commandExecution" }>;
      const failed =
        command.status === "failed" ||
        command.status === "declined" ||
        (command.exitCode !== null && command.exitCode !== 0);
      const detail = [
        `$ ${command.command}`,
        truncate(command.aggregatedOutput?.trim() ?? ""),
        command.exitCode !== null && command.exitCode !== 0 ? `Exit code ${command.exitCode}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        ...base,
        kind: "command",
        title: `Ran ${firstLine(command.command)}`,
        detail,
        status: completed ? (failed ? "failed" : "done") : "running",
      };
    }
    case "mcpToolCall": {
      const call = item as Extract<ThreadItem, { type: "mcpToolCall" }>;
      const args =
        typeof call.arguments === "object" && call.arguments !== null && !Array.isArray(call.arguments)
          ? (call.arguments as Record<string, unknown>)
          : {};
      const stafStep = call.server === "staf" ? describeStafTool(call.tool, args) : null;
      const activity: Activity = {
        ...base,
        kind: stafStep?.kind ?? "tool",
        // Account apps all arrive through Codex's "codex_apps" server, so name the tool instead.
        title:
          stafStep?.title ??
          (call.server === "codex_apps" ? `Used ${call.tool}` : `Used ${call.server} · ${call.tool}`),
        status: completed ? (call.status === "failed" ? "failed" : "done") : "running",
      };
      if (call.error?.message) activity.detail = call.error.message;
      return activity;
    }
    case "dynamicToolCall": {
      const call = item as Extract<ThreadItem, { type: "dynamicToolCall" }>;
      return {
        ...base,
        kind: "tool",
        title: `Used ${call.namespace ? `${call.namespace} · ` : ""}${call.tool}`,
        status: completed ? (call.success === false ? "failed" : "done") : "running",
      };
    }
    case "fileChange": {
      const change = item as Extract<ThreadItem, { type: "fileChange" }>;
      const paths = change.changes.map((c) => c.path);
      return {
        ...base,
        kind: "file",
        title: paths.length === 1 ? `Edited ${basename(paths[0]!)}` : `Edited ${paths.length} files`,
        detail: paths.join("\n"),
      };
    }
    case "reasoning": {
      if (!completed) return null;
      const reasoning = item as Extract<ThreadItem, { type: "reasoning" }>;
      const summary = reasoning.summary.join("\n\n").trim();
      if (!summary) return null;
      return { ...base, kind: "reasoning", title: "Thought it through", detail: truncate(summary) };
    }
    default:
      return null;
  }
}

function describeSearch(
  item: Extract<ThreadItem, { type: "webSearch" }>,
  completed: boolean,
): Pick<Activity, "kind" | "title"> {
  if (!completed) return { kind: "search", title: "Searching the web" };
  const action = item.action;
  if (action?.type === "openPage" && action.url) {
    return { kind: "page", title: `Opened ${hostOf(action.url)}` };
  }
  if (action?.type === "findInPage") {
    return { kind: "page", title: action.url ? `Read ${hostOf(action.url)}` : "Read a page" };
  }
  const query =
    (action?.type === "search" && (action.query ?? action.queries?.join(", "))) || item.query;
  if (query) return { kind: "search", title: `Searched: ${query}` };
  return { kind: "page", title: "Read a page" };
}

const CODEX_TOKEN_FIELDS = [
  ["inputTokens", "inputTokens"],
  ["outputTokens", "outputTokens"],
  ["cachedInputTokens", "cachedInputTokens"],
  ["reasoningOutputTokens", "reasoningTokens"],
  ["totalTokens", "totalTokens"],
] as const;

/**
 * Reads a Codex `thread/tokenUsage/updated` notification. Codex reports the thread's running
 * `total` and the `last` model call. A turn can make several model calls, so the turn's usage
 * is the current total minus the total from before the turn. The first update of a turn gives
 * that starting total: its `total` minus its `last`.
 */
export function parseCodexUsage(
  params: unknown,
  base?: Record<string, number>,
): { report: TurnUsageReport; base?: Record<string, number> } {
  const record = (value: unknown) =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
  const tokenUsage = record(record(params)?.tokenUsage) ?? {};
  const total = record(tokenUsage.total);
  const last = record(tokenUsage.last);

  let start = base;
  if (!start && total) {
    start = {};
    for (const [field] of CODEX_TOKEN_FIELDS) {
      const value = num(total[field]);
      if (value !== undefined) start[field] = Math.max(0, value - (num(last?.[field]) ?? 0));
    }
  }

  const usage: TokenUsage = {};
  const source = total ?? last;
  if (source) {
    for (const [field, key] of CODEX_TOKEN_FIELDS) {
      const value = num(source[field]);
      if (value === undefined) continue;
      usage[key] = total && start ? Math.max(0, value - (start[field] ?? 0)) : value;
    }
  }
  const contextWindow = num(tokenUsage.modelContextWindow);
  if (contextWindow !== undefined) usage.contextWindow = contextWindow;

  return {
    report: {
      ...(Object.keys(usage).length > 0 ? { usage } : {}),
      ...(Object.keys(tokenUsage).length > 0 ? { providerMeta: { tokenUsage } } : {}),
    },
    ...(start ? { base: start } : {}),
  };
}

function buildCodexReport(turn: ActiveTurn, stopReason: string): TurnUsageReport {
  return {
    ...(turn.report ?? {}),
    stopReason,
    ...(turn.resolvedModel ? { resolvedModel: turn.resolvedModel } : {}),
    ...(turn.modelCalls > 0 ? { turns: turn.modelCalls } : {}),
    ...(turn.recovered ? { sessionAction: "recovered" } : {}),
  };
}
