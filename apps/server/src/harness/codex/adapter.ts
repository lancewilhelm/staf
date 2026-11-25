import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Activity, HarnessInfo } from "@staf/protocol";
import type { AgentAccess } from "../../agents.ts";
import { VERSION } from "../../config.ts";
import type { HarnessAdapter, HarnessEvent, TurnOutcome, TurnRequest } from "../types.ts";
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
import { RpcError, RpcProcess } from "./rpc.ts";

export interface CodexOptions {
  /** CODEX_HOME for Staf's own sign-in and configuration. */
  codexHome: string;
  /** Command that starts the app server. Tests replace it with a fake. */
  command?: string[];
  /** Stop the app server after this long without a turn. */
  idleMs?: number;
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
const MAX_DETAIL = 4000;

export class CodexAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly label = "ChatGPT (Codex)";

  private rpc: RpcProcess | null = null;
  private starting: Promise<RpcProcess> | null = null;
  /** Codex threads that the current app server has started or resumed. */
  private readonly loaded = new Set<string>();
  private readonly turns = new Map<string, ActiveTurn>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CodexOptions) {}

  async status(): Promise<HarnessInfo> {
    const base = { id: this.id, label: this.label };
    if (!this.options.command && !Bun.which("codex")) {
      return { ...base, ready: false, detail: "The codex command is not installed." };
    }
    if (!this.options.command && !existsSync(join(this.options.codexHome, "auth.json"))) {
      return { ...base, ready: false, detail: "Not signed in. Run `staf login codex`." };
    }
    return { ...base, ready: true };
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
    const { config, unresolved } = codexThreadConfig(request.access, this.readAppCatalog());
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
    if (threadId && !this.loaded.has(threadId)) {
      try {
        await rpc.request<ThreadResponse>("thread/resume", {
          ...threadOptions,
          threadId,
          excludeTurns: true,
        });
      } catch (error) {
        // The saved Codex thread is gone. Continue in a new one.
        if (!(error instanceof RpcError)) throw error;
        threadId = null;
      }
    }
    if (!threadId) {
      const started = await rpc.request<ThreadResponse>("thread/start", threadOptions);
      threadId = started.thread.id;
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
            .catch(() => turn.finish({ status: "interrupted" }));
        }
      };
      this.turns.set(turn.threadId, turn);
      request.signal.addEventListener("abort", onAbort, { once: true });
    });

    const turn = this.turns.get(threadId)!;
    try {
      const started = await rpc.request<TurnStartResponse>("turn/start", {
        threadId,
        input: [{ type: "text", text: request.input, text_elements: [] }],
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
    const tail = stderrTail.trim().split("\n").slice(-3).join("\n");
    const error = `Codex stopped unexpectedly (exit code ${code})${tail ? `: ${tail}` : "."}`;
    for (const turn of [...this.turns.values()]) turn.finish({ status: "failed", error });
  }

  private onNotification(method: string, params: unknown): void {
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
      case "turn/completed": {
        const { turn: done } = params as TurnCompletedNotification;
        if (turn.turnId && done.id !== turn.turnId) break;
        if (done.status === "interrupted") turn.finish({ status: "interrupted" });
        else if (done.status === "failed") {
          turn.finish({
            status: "failed",
            error: done.error?.message ?? turn.lastError ?? "Codex could not finish the answer.",
          });
        } else turn.finish({ status: "completed" });
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
          turn.emit({ type: "activity", activity: commentaryActivity(message.id, message.text) });
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

  private startIdleTimer(): void {
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
    features: {
      apps: ids.length > 0,
      plugins: false,
      computer_use: false,
      browser_use: false,
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
      const activity: Activity = {
        ...base,
        kind: "tool",
        // Account apps all arrive through Codex's "codex_apps" server, so name the tool instead.
        title: call.server === "codex_apps" ? `Used ${call.tool}` : `Used ${call.server} · ${call.tool}`,
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

function commentaryActivity(id: string, text: string): Activity {
  const now = Date.now();
  const line = firstLine(text);
  const activity: Activity = {
    id,
    kind: "note",
    title: line,
    status: "done",
    startedAt: now,
    completedAt: now,
  };
  if (text.trim() !== line) activity.detail = text.trim();
  return activity;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
