import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessToolsForAgent, StafClient, type StreamEvent } from "@staf/protocol";
import { createApp, type App } from "../src/app.ts";
import { resolvePaths } from "../src/config.ts";
import type { HarnessAdapter, TurnOutcome, TurnRequest } from "../src/harness/types.ts";
import { parseBridgeArgs } from "../src/mcp/bridge.ts";
import { RunTokenStore, type McpBridgeConfig } from "../src/mcp/tokens.ts";
import { buildFtsQuery, Store } from "../src/store.ts";

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
});

/** A controllable test harness that pauses inside `runTurn` so tests can call Staf MCP tools live. */
class GateHarness implements HarnessAdapter {
  readonly requests: TurnRequest[] = [];
  private gate: (() => void) | null = null;
  private readyResolve: ((req: TurnRequest) => void) | null = null;

  constructor(
    readonly id = "codex",
    readonly label = "Fake Codex",
  ) {}

  async status() {
    return { id: this.id, label: this.label, program: "Fake", signIn: "machine" as const, ready: true };
  }

  async listModels() {
    return [{ id: "fake-1", name: "Fake 1", isDefault: true }];
  }

  async deleteSession() {}
  async close() {
    this.release();
  }

  /** Returns a promise that resolves as soon as the next turn starts running. */
  nextTurn(): Promise<TurnRequest> {
    return new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  release(): void {
    this.gate?.();
    this.gate = null;
  }

  async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(request);
    if (!request.sessionId) request.emit({ type: "session", sessionId: `sess-${this.requests.length}` });
    this.readyResolve?.(request);
    this.readyResolve = null;
    await new Promise<void>((resolve) => {
      this.gate = resolve;
      request.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    request.emit({ type: "text", text: "Done." });
    return { status: "completed" };
  }
}

function startWith(harnesses: HarnessAdapter[], harnessOverride: string | null = null) {
  const home = mkdtempSync(join(tmpdir(), "staf-mcp-"));
  const paths = resolvePaths({ STAF_HOME: home });
  const app = createApp({ paths, hostname: "127.0.0.1", port: 0, harnessOverride, harnesses });
  apps.push(app);
  const url = app.url.href.replace(/\/$/, "");
  return { app, paths, url, client: new StafClient(url) };
}

/** Spawns `staf mcp-bridge` with the exact config given to a harness and sends JSON-RPC lines. */
class BridgeClient {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<number, (msg: any) => void>();
  private nextId = 1;

  constructor(mcp: McpBridgeConfig) {
    this.proc = Bun.spawn([mcp.command, ...mcp.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...mcp.env },
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === "number") {
          this.pending.get(msg.id)?.(msg);
          this.pending.delete(msg.id);
        }
      }
    }
  }

  request(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n");
      void this.proc.stdin.flush();
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }) + "\n");
    void this.proc.stdin.flush();
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; data: any }> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`RPC error ${res.error.code}: ${res.error.message}`);
    const text = res.result.content?.[0]?.text ?? "";
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Plain error text.
    }
    return { isError: res.result.isError === true, text, data };
  }

  async close(): Promise<void> {
    await this.proc.stdin.end();
    await this.proc.exited;
  }
}

describe("RunTokenStore", () => {
  test("pins single-turn tokens to one turn and revokes them on end", () => {
    const tokens = new RunTokenStore();
    const run = tokens.beginRun({
      agentId: "default",
      threadId: "t1",
      messageId: "m1",
      trigger: "chat",
      taskId: null,
      harnessId: "claude",
      singleTurn: true,
    });
    expect(tokens.verifyHandshake(run.token)?.agentId).toBe("default");
    expect(tokens.verifyActiveRun(run.token)).toMatchObject({ messageId: "m1", trigger: "chat" });

    run.end();
    expect(tokens.verifyHandshake(run.token)).toBeNull();
    expect(tokens.verifyActiveRun(run.token)).toBeNull();
  });

  test("reuses persistent session tokens across turns but rejects tool calls while idle", () => {
    const tokens = new RunTokenStore();
    const turn1 = tokens.beginRun({
      agentId: "default",
      threadId: "t1",
      messageId: "m1",
      trigger: "schedule",
      taskId: "task-1",
      harnessId: "codex",
    });
    expect(tokens.verifyActiveRun(turn1.token)).toMatchObject({
      messageId: "m1",
      trigger: "schedule",
      taskId: "task-1",
    });

    turn1.end();
    // Handshake stays valid for the loaded session, but tool calls fail while no turn runs.
    expect(tokens.verifyHandshake(turn1.token)).not.toBeNull();
    expect(tokens.verifyActiveRun(turn1.token)).toBeNull();

    // A later chat reply in the same thread reuses the session token with the new turn context.
    const turn2 = tokens.beginRun({
      agentId: "default",
      threadId: "t1",
      messageId: "m2",
      trigger: "chat",
      taskId: "task-1",
      harnessId: "codex",
    });
    expect(turn2.token).toBe(turn1.token);
    expect(tokens.verifyActiveRun(turn2.token)).toMatchObject({ messageId: "m2", trigger: "chat" });
    turn2.end();

    tokens.revokeThread("t1");
    expect(tokens.verifyHandshake(turn1.token)).toBeNull();
  });

  test("parseBridgeArgs reads token from CLI flag or STAF_RUN_TOKEN", () => {
    expect(parseBridgeArgs(["--token", "abc", "--url", "http://127.0.0.1:9999/"], {})).toEqual({
      token: "abc",
      url: "http://127.0.0.1:9999",
    });
    expect(parseBridgeArgs(["--url", "http://127.0.0.1:4280"], { STAF_RUN_TOKEN: "env-tok" })).toEqual({
      token: "env-tok",
      url: "http://127.0.0.1:4280",
    });
    expect(() => parseBridgeArgs([], {})).toThrow("requires a run token");
  });
});

describe("Staf MCP bridge and attach_file end-to-end", () => {
  test("bridges stdio JSON-RPC to the host, attaches workspace files, blocks escapes, and expires after the turn", async () => {
    const harness = new GateHarness("codex", "ChatGPT");
    const { app, paths, url, client } = startWith([harness]);

    // Unauthenticated /api/mcp requests are rejected.
    const noAuth = await fetch(`${url}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-staf-client": "test" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(noAuth.status).toBe(401);

    const thread = await client.createThread();
    const workspace = join(paths.agents, "default", "workspace");
    mkdirSync(join(workspace, "reports"), { recursive: true });
    writeFileSync(join(workspace, "reports", "briefing.pdf"), "%PDF-1.4\nhello");
    writeFileSync(join(workspace, "empty.txt"), "");
    symlinkSync(join(paths.agents, "default", "AGENTS.md"), join(workspace, "escape-link.md"));

    // Listen for live SSE attachment events while the turn runs.
    const events: StreamEvent[] = [];
    const sseStop = new AbortController();
    const sseReady = (async () => {
      const iter = client.events(sseStop.signal)[Symbol.asyncIterator]();
      expect((await iter.next()).value).toEqual({ type: "ready" });
      void (async () => {
        try {
          for (;;) {
            const { value, done } = await iter.next();
            if (done) break;
            events.push(value);
          }
        } catch {
          // Stream aborted when test ends.
        }
      })();
    })();
    await sseReady;

    const turnStarted = harness.nextTurn();
    const sent = await client.sendMessage(thread.id, "Make a briefing PDF");
    const req = await turnStarted;
    expect(req.mcp).toBeDefined();

    const bridge = new BridgeClient(req.mcp!);
    try {
      const init = await bridge.request("initialize", { protocolVersion: "2025-03-26" });
      expect(init.result).toMatchObject({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "staf" },
      });
      bridge.notify("notifications/initialized");
      expect((await bridge.request("ping")).result).toEqual({});

      const listed = await bridge.request("tools/list");
      const toolNames = listed.result.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toEqual([
        "attach_file",
        "list_scheduled_tasks",
        "create_scheduled_task",
        "update_scheduled_task",
        "delete_scheduled_task",
        "conversation_search",
        "memory",
      ]);

      // Attach a valid workspace PDF to the active assistant message.
      const attached = await bridge.callTool("attach_file", {
        path: "reports/briefing.pdf",
        name: "Morning Briefing.pdf",
      });
      expect(attached.isError).toBe(false);
      expect(attached.data).toMatchObject({
        attached: true,
        name: "Morning Briefing.pdf",
        mimeType: "application/pdf",
      });

      // Security checks: traversal, symlinks escaping workspace, directories, empty files, missing files.
      expect((await bridge.callTool("attach_file", { path: "../AGENTS.md" })).isError).toBe(true);
      expect((await bridge.callTool("attach_file", { path: "escape-link.md" })).isError).toBe(true);
      expect((await bridge.callTool("attach_file", { path: "reports" })).isError).toBe(true);
      expect((await bridge.callTool("attach_file", { path: "empty.txt" })).isError).toBe(true);
      expect((await bridge.callTool("attach_file", { path: "missing.pdf" })).isError).toBe(true);

      // Finish the turn; tool calls must immediately be rejected once idle.
      harness.release();
      await app.chat.idle();

      const afterEnd = await bridge.request("tools/call", { name: "list_scheduled_tasks", arguments: {} });
      expect(afterEnd.error).toMatchObject({ code: -32000 });
      expect(afterEnd.error.message).toContain("no longer active");
    } finally {
      await bridge.close();
      sseStop.abort();
    }

    // Verify the attachment landed on the assistant message and streamed live.
    const detail = await client.getThread(thread.id);
    const assistant = detail.messages.find((m) => m.id === sent.assistantMessage.id)!;
    expect(assistant.attachments).toHaveLength(1);
    expect(assistant.attachments[0]).toMatchObject({
      name: "Morning Briefing.pdf",
      mimeType: "application/pdf",
    });
    expect(events.some((e) => e.type === "message.attachment" && e.messageId === sent.assistantMessage.id)).toBe(true);

    const download = await fetch(`${url}${assistant.attachments[0]!.url}`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("%PDF-1.4\nhello");
  });

  test("filters tools/list and blocks tools/call when an agent restricts Staf tools", async () => {
    const harness = new GateHarness("codex", "ChatGPT");
    const { app, client } = startWith([harness]);

    // Create an agent with scheduled_tasks and memory disabled.
    const locked = await client.createAgent({
      name: "Locked",
      harness: "codex",
      model: null,
      effort: null,
      fast: false,
      instructions: "",
      tools: { scheduled_tasks: false, memory: false },
    });
    expect(locked.tools).toEqual({
      attach_file: true,
      memory: false,
      conversation_search: true,
      scheduled_tasks: false,
    });

    // Reject unknown tool IDs.
    await expect(
      client.updateAgent(locked.id, { tools: { bogus: false } as any }),
    ).rejects.toMatchObject({ status: 400 });

    const thread = await client.createThread({ agentId: locked.id });
    const started = harness.nextTurn();
    await client.sendMessage(thread.id, "Check my tools");
    const req = await started;
    // Instructions omit disabled tools.
    expect(req.instructions).not.toContain("memory tool");
    expect(req.instructions).toContain("attach_file");
    expect(req.instructions).toContain("conversation_search");

    const bridge = new BridgeClient(req.mcp!);
    try {
      const listed = await bridge.request("tools/list");
      expect(listed.result.tools.map((t: { name: string }) => t.name)).toEqual([
        "attach_file",
        "conversation_search",
      ]);

      // Calling a disabled tool returns a clear error instead of executing.
      const blocked = await bridge.callTool("list_scheduled_tasks");
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("disabled for this agent");

      const blockedMem = await bridge.callTool("memory", { action: "list" });
      expect(blockedMem.isError).toBe(true);
      expect(blockedMem.text).toContain("disabled for this agent");

      // Re-enabling a tool takes effect immediately.
      await client.updateAgent(locked.id, { tools: { scheduled_tasks: true } });
      const allowed = await bridge.callTool("list_scheduled_tasks");
      expect(allowed.isError).toBe(false);
    } finally {
      harness.release();
      await bridge.close();
      await app.chat.idle();
    }
  });

  test("harnessToolsForAgent describes built-in capabilities for Codex, Claude, and Antigravity", () => {
    const codex = harnessToolsForAgent({
      harness: "codex",
      harnessLabel: "ChatGPT",
      network: false,
      writableFolders: ["/srv/notes"],
      harnessApps: ["Expedia"],
    });
    expect(codex.capabilities.find((c) => c.id === "shell")?.statusLabel).toBe("Offline only");
    expect(codex.capabilities.find((c) => c.id === "apps")).toMatchObject({
      status: "limited",
      names: ["Expedia"],
    });

    const claude = harnessToolsForAgent({
      harness: "claude",
      harnessLabel: "Claude",
      network: true,
      writableFolders: [],
      harnessApps: [],
    });
    expect(claude.capabilities.flatMap((c) => c.names ?? [])).toEqual([
      "WebSearch",
      "WebFetch",
      "Bash",
      "Read",
      "Edit",
      "Write",
      "Skill",
    ]);

    const agy = harnessToolsForAgent({
      harness: "antigravity",
      harnessLabel: "Gemini",
      network: true,
      writableFolders: ["/srv/notes"],
      harnessApps: [],
    });
    expect(agy.capabilities.find((c) => c.id === "shell")?.statusLabel).toBe("Offline only");
    expect(agy.capabilities.find((c) => c.id === "files")?.statusLabel).toBe("Workspace only");
  });
});

describe("MCP scheduled task tools", () => {
  test("scopes list, create, update, and delete strictly to the calling agent and enforces harness rules", async () => {
    const codex = new GateHarness("codex", "ChatGPT");
    const claude = new GateHarness("claude", "Claude");
    const agy = new GateHarness("antigravity", "Gemini");
    const { app, client } = startWith([codex, claude, agy]);

    const helper = await client.createAgent({
      name: "Helper",
      harness: "codex",
      model: null,
      effort: null,
      fast: false,
      instructions: "",
    });
    const geminiAgent = await client.createAgent({
      name: "Gemini Agent",
      harness: "antigravity",
      model: null,
      effort: null,
      fast: false,
      instructions: "",
    });
    const helperTask = await client.createScheduledTask(helper.id, {
      name: "Helper job",
      prompt: "Check helper",
      schedule: { type: "daily", timeOfDay: "07:00" },
    });

    // Start a live turn on the default agent.
    const thread = await client.createThread({ agentId: "default" });
    const started = codex.nextTurn();
    await client.sendMessage(thread.id, "Manage my schedules");
    const req = await started;
    const bridge = new BridgeClient(req.mcp!);

    try {
      // Cannot see helper's tasks.
      const initial = await bridge.callTool("list_scheduled_tasks");
      expect(initial.isError).toBe(false);
      expect(initial.data.tasks).toEqual([]);

      // Create a daily task and verify fast defaults to false.
      const created = await bridge.callTool("create_scheduled_task", {
        name: "Morning Intel",
        prompt: "Prepare the daily paper.",
        schedule: { type: "daily", timeOfDay: "05:30", weekdays: [1, 2, 3, 4, 5] },
      });
      expect(created.isError).toBe(false);
      expect(created.data.task).toMatchObject({
        name: "Morning Intel",
        enabled: true,
        fast: false,
        scheduleSummary: "Weekdays at 5:30 AM",
      });
      const taskId = created.data.task.id as string;

      // Create a one-time task using an ISO timestamp string.
      const futureIso = new Date(Date.now() + 3600_000).toISOString();
      const onceTask = await bridge.callTool("create_scheduled_task", {
        name: "One-off reminder",
        prompt: "Check flights",
        schedule: { type: "once", runAt: futureIso },
        harness: "claude",
      });
      expect(onceTask.isError).toBe(false);
      expect(onceTask.data.task.harness).toBe("claude");

      // Cannot update or delete another agent's task.
      const crossUpdate = await bridge.callTool("update_scheduled_task", {
        taskId: helperTask.id,
        enabled: false,
      });
      expect(crossUpdate.isError).toBe(true);
      const crossDelete = await bridge.callTool("delete_scheduled_task", { taskId: helperTask.id });
      expect(crossDelete.isError).toBe(true);

      // Can update and delete its own task.
      const updated = await bridge.callTool("update_scheduled_task", { taskId, enabled: false });
      expect(updated.isError).toBe(false);
      expect(updated.data.task.enabled).toBe(false);

      const deleted = await bridge.callTool("delete_scheduled_task", { taskId });
      expect(deleted.isError).toBe(false);
      expect(deleted.data).toEqual({ deleted: true, taskId });
    } finally {
      codex.release();
      await bridge.close();
      await app.chat.idle();
    }

    // Helper's task was never touched.
    expect(await client.listScheduledTasks(helper.id)).toHaveLength(1);

    // An Antigravity agent cannot schedule on Antigravity unless it overrides to Codex or Claude.
    const agyThread = await client.createThread({ agentId: geminiAgent.id });
    const agyTurn = agy.nextTurn();
    await client.sendMessage(agyThread.id, "Schedule something");
    const agyReq = await agyTurn;
    const agyBridge = new BridgeClient(agyReq.mcp!);
    try {
      const blocked = await agyBridge.callTool("create_scheduled_task", {
        name: "Bad schedule",
        prompt: "Run on gemini",
        schedule: { type: "interval", everyMinutes: 60 },
      });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain("Antigravity");

      const allowed = await agyBridge.callTool("create_scheduled_task", {
        name: "Codex schedule",
        prompt: "Run on codex",
        schedule: { type: "interval", everyMinutes: 60 },
        harness: "codex",
      });
      expect(allowed.isError).toBe(false);
    } finally {
      agy.release();
      await agyBridge.close();
      await app.chat.idle();
    }
  });
});

describe("MCP conversation_search and FTS5", () => {
  test("searches only the calling agent's past conversations and handles punctuation safely", async () => {
    const codex = new GateHarness("codex", "ChatGPT");
    const { app, client } = startWith([codex]);

    const other = await client.createAgent({
      name: "Other",
      harness: "codex",
      model: null,
      effort: null,
      fast: false,
      instructions: "",
    });

    // Seed past conversations on both agents.
    const tDefault = app.store.createThread({
      title: "Lisbon planning",
      agentId: "default",
      harness: "codex",
      model: null,
      effort: null,
      fast: false,
    });
    app.store.addMessage({
      threadId: tDefault.id,
      role: "user",
      text: "Book the Alfama boutique hotel for the morning-intel trip.",
      status: "complete",
    });
    app.store.addMessage({
      threadId: tDefault.id,
      role: "assistant",
      text: "Noted: doctor's appointment is at 5:30 PM before the Lisbon flight.",
      status: "complete",
    });

    const tOther = app.store.createThread({
      title: "Private other agent",
      agentId: other.id,
      harness: "codex",
      model: null,
      effort: null,
      fast: false,
    });
    app.store.addMessage({
      threadId: tOther.id,
      role: "user",
      text: "Secret Alfama boutique hotel note belonging strictly to Other.",
      status: "complete",
    });

    // Start an active turn on default agent and run conversation_search.
    const currentThread = await client.createThread({ agentId: "default" });
    const started = codex.nextTurn();
    await client.sendMessage(currentThread.id, "Find my Alfama notes");
    const req = await started;
    const bridge = new BridgeClient(req.mcp!);

    try {
      const hits = await bridge.callTool("conversation_search", { query: "Alfama" });
      expect(hits.isError).toBe(false);
      // Should find tDefault + currentThread's user message, NEVER tOther.
      expect(hits.data.results.every((r: { threadId: string }) => r.threadId !== tOther.id)).toBe(true);
      expect(hits.data.results.some((r: { threadId: string }) => r.threadId === tDefault.id)).toBe(true);

      // excludeCurrentThread skips currentThread.
      const pastOnly = await bridge.callTool("conversation_search", {
        query: "Alfama",
        excludeCurrentThread: true,
      });
      expect(pastOnly.data.results.map((r: { threadId: string }) => r.threadId)).toEqual([tDefault.id]);

      // Punctuation-heavy queries do not cause FTS5 syntax errors.
      const hyphen = await bridge.callTool("conversation_search", { query: "morning-intel" });
      expect(hyphen.isError).toBe(false);
      expect(hyphen.data.count).toBe(1);

      const apostrophe = await bridge.callTool("conversation_search", { query: "doctor's 5:30" });
      expect(apostrophe.isError).toBe(false);
      expect(apostrophe.data.count).toBe(1);

      const punctOnly = await bridge.callTool("conversation_search", { query: "??? ---" });
      expect(punctOnly.isError).toBe(false);
      expect(punctOnly.data.count).toBe(0);
    } finally {
      codex.release();
      await bridge.close();
      await app.chat.idle();
    }
  });

  test("migrates an older database to v8 and backfills messages_fts", () => {
    const dir = mkdtempSync(join(tmpdir(), "staf-fts-migrate-"));
    const dbPath = join(dir, "staf.db");
    const old = new Database(dbPath);
    old.run(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT NOT NULL,
        harness TEXT NOT NULL, session_id TEXT, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL, text TEXT NOT NULL, activities TEXT NOT NULL,
        status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER
      );
      INSERT INTO threads VALUES ('t1', 'Garden', 'default', 'codex', NULL, 'idle', 1, 1);
      INSERT INTO messages VALUES ('m1', 't1', 'user', 'Plant heirloom tomatoes in May', '[]', 'complete', NULL, 1, 1);
      PRAGMA user_version = 1;
    `);
    old.close();

    const store = new Store(dbPath);
    const hits = store.searchMessages("default", "heirloom tomatoes");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ threadId: "t1", messageId: "m1" });

    // Deleting the thread also cleans up the FTS index.
    store.deleteThread("t1");
    expect(store.searchMessages("default", "heirloom")).toEqual([]);
    store.close();
  });

  test("buildFtsQuery quotes tokens safely and skips pure punctuation", () => {
    expect(buildFtsQuery('morning-intel "exact phrase" ???')).toBe('"morning-intel" "exact phrase"');
    expect(buildFtsQuery("   ---   ")).toBe("");
  });
});
