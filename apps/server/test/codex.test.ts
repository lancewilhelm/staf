import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityFromItem, CodexAdapter, codexThreadConfig } from "../src/harness/codex/adapter.ts";
import type { HarnessEvent, TurnRequest } from "../src/harness/types.ts";

const fixture = join(import.meta.dir, "fixtures", "fake-codex.ts");
const adapters: CodexAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  delete process.env.FAKE_CODEX_SCENARIO;
  delete process.env.FAKE_CODEX_LOG;
});

function setup(scenario = "answer") {
  const dir = mkdtempSync(join(tmpdir(), "staf-codex-"));
  const logPath = join(dir, "requests.jsonl");
  process.env.FAKE_CODEX_SCENARIO = scenario;
  process.env.FAKE_CODEX_LOG = logPath;
  const adapter = new CodexAdapter({ codexHome: dir, command: ["bun", fixture] });
  adapters.push(adapter);
  const requests = () =>
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: any });
  return { adapter, dir, requests };
}

function turn(overrides: Partial<TurnRequest> = {}) {
  const events: HarnessEvent[] = [];
  const controller = new AbortController();
  const request: TurnRequest = {
    sessionId: null,
    cwd: "/tmp/agent",
    access: { network: true, harnessApps: [], writableFolders: [] },
    instructions: "Be brief.",
    model: null,
    effort: null,
    fast: false,
    input: "What leads AP?",
    signal: controller.signal,
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { request, events, controller };
}

const text = (events: HarnessEvent[]) =>
  events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");

describe("CodexAdapter", () => {
  test("streams the answer, a session ID, and readable steps", async () => {
    const { adapter, requests } = setup();
    const { request, events } = turn();

    const outcome = await adapter.runTurn(request);

    expect(outcome).toEqual({ status: "completed" });
    expect(events[0]).toEqual({ type: "session", sessionId: "thread-1" });
    // Commentary becomes a step, not part of the answer.
    expect(text(events)).toBe("AP leads with **news**.");
    const titles = events.flatMap((event) => (event.type === "activity" ? [event.activity.title] : []));
    expect(titles).toEqual(["I'll check AP.", "Searching the web", "Opened apnews.com"]);

    const start = requests().find((r) => r.method === "thread/start")!;
    expect(start.params).toMatchObject({
      cwd: "/tmp/agent",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      developerInstructions: "Be brief.",
      config: {
        web_search: "live",
        features: { apps: false, plugins: false, computer_use: false, browser_use: false },
        sandbox_workspace_write: { network_access: true, writable_roots: [] },
      },
    });
    expect(start.params.config.apps).toBeUndefined();
  });

  test("passes the same access settings when it resumes a thread", async () => {
    const { adapter, requests } = setup();
    const { request } = turn({
      sessionId: "thread-saved",
      access: { network: false, harnessApps: [], writableFolders: ["/srv/notes"] },
    });
    await adapter.runTurn(request);
    const resume = requests().find((r) => r.method === "thread/resume")!;
    expect(resume.params.config.sandbox_workspace_write).toEqual({
      network_access: false,
      writable_roots: ["/srv/notes"],
    });
  });

  test("lists the account's apps and caches them for name lookups", async () => {
    const { adapter, dir, requests } = setup();
    const apps = await adapter.listApps();
    expect(apps.map((app) => app.name)).toEqual(["Expedia", "Gmail"]);
    expect(requests().find((r) => r.method === "app/list")!.params.threadId).toBe("thread-1");

    // A later turn can name the app instead of using its ID.
    const { request, events } = turn({ access: { network: true, harnessApps: ["expedia", "Hilton"], writableFolders: [] } });
    await adapter.runTurn(request);
    const start = requests().filter((r) => r.method === "thread/start").at(-1)!;
    expect(start.params.config.apps).toEqual({
      _default: { enabled: false, destructive_enabled: false },
      connector_expedia: { enabled: true, destructive_enabled: false },
    });
    const skipped = events.find((e) => e.type === "activity" && e.activity.id === "app-missing-Hilton");
    expect(skipped?.type === "activity" && skipped.activity.status).toBe("failed");
    expect(JSON.parse(readFileSync(join(dir, "staf-apps.json"), "utf8"))).toHaveLength(2);
  });

  test("resumes a saved session instead of starting a new one", async () => {
    const { adapter, requests } = setup();
    const { request, events } = turn({ sessionId: "thread-saved" });

    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });

    expect(events.some((event) => event.type === "session")).toBe(false);
    const methods = requests().map((r) => r.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(requests().find((r) => r.method === "turn/start")!.params.threadId).toBe("thread-saved");
  });

  test("starts a new session when the saved one is gone", async () => {
    const { adapter, requests } = setup("missing-thread");
    const { request, events } = turn({ sessionId: "thread-gone", inputWithHistory: "HISTORY + What leads AP?" });

    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });
    expect(events[0]).toEqual({ type: "session", sessionId: "thread-1" });
    // The new session gets the conversation so far.
    expect(requests().find((r) => r.method === "turn/start")!.params.input[0].text).toBe("HISTORY + What leads AP?");
  });

  test("interrupts a turn when the signal aborts", async () => {
    const { adapter, requests } = setup("slow");
    const { request, controller } = turn();

    const outcome = adapter.runTurn(request);
    await Bun.sleep(100);
    controller.abort();

    expect(await outcome).toEqual({ status: "interrupted" });
    expect(requests().map((r) => r.method)).toContain("turn/interrupt");
  });

  test("fails the turn with the error output when Codex exits", async () => {
    const { adapter } = setup("crash");
    const { request } = turn();

    const outcome = await adapter.runTurn(request);

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.error).toContain("something broke");
  });

  test("reports that it is not signed in when the Codex home has no login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "staf-codex-"));
    const adapter = new CodexAdapter({ codexHome: dir });
    const status = await adapter.status();
    // Without the codex command, or without a login, the harness is not ready.
    expect(status.ready).toBe(false);
  });
});

describe("CodexAdapter models, sign-in, and deletion", () => {
  test("lists visible models and names the default when a thread asks for it", async () => {
    const { adapter, requests } = setup();
    expect(await adapter.listModels()).toEqual([
      { id: "gpt-a", name: "GPT-A", isDefault: true },
      { id: "gpt-b", name: "GPT-B", efforts: ["low", "high"], defaultEffort: "low", fast: true, fastNote: "2x speed" },
    ]);
    await adapter.runTurn(turn().request);
    await adapter.runTurn(turn({ sessionId: "thread-1", model: "gpt-b" }).request);
    const starts = requests().filter((r) => r.method === "turn/start");
    expect(starts.map((r) => r.params.model)).toEqual(["gpt-a", "gpt-b"]);
  });

  test("sends the reasoning level and fast tier, and leaves out what the model lacks", async () => {
    const { adapter, requests } = setup();
    await adapter.runTurn(turn({ model: "gpt-b", effort: "high", fast: true }).request);
    await adapter.runTurn(turn({ sessionId: "thread-1", model: "gpt-b", effort: null, fast: false }).request);
    await adapter.runTurn(turn({ sessionId: "thread-1", model: "gpt-a", effort: "high", fast: true }).request);
    const starts = requests()
      .filter((r) => r.method === "turn/start")
      .map((r) => ({ effort: r.params.effort, serviceTier: r.params.serviceTier }));
    expect(starts).toEqual([
      { effort: "high", serviceTier: "priority" },
      // Back to the model's own level, and fast mode cleared.
      { effort: "low", serviceTier: null },
      // GPT-A has neither.
      { effort: undefined, serviceTier: null },
    ]);
  });

  test("deletes a thread, and treats a missing one as deleted", async () => {
    const { adapter, requests } = setup();
    await adapter.deleteSession("thread-7");
    await adapter.deleteSession("thread-gone");
    expect(requests().filter((r) => r.method === "thread/delete").map((r) => r.params.threadId)).toEqual([
      "thread-7",
      "thread-gone",
    ]);
  });

  test("reports the signed-in account after it starts", async () => {
    const { adapter } = setup();
    await adapter.listModels();
    await Bun.sleep(20);
    expect(await adapter.status()).toMatchObject({ ready: true, signIn: "staf", account: "person@example.com" });
  });
});

describe("codexThreadConfig", () => {
  const catalog = [
    { id: "connector_gmail", name: "Gmail", accessible: true },
    { id: "connector_expedia", name: "Expedia", accessible: true },
  ];

  test("turns Codex's own memory and browser features off", () => {
    const { config } = codexThreadConfig({ network: true, harnessApps: [], writableFolders: [] }, []);
    expect(config.features).toMatchObject({ memories: false, browser_use: false, in_app_browser: false, computer_use: false });
  });

  test("turns account apps off unless an agent names them", () => {
    const { config, unresolved } = codexThreadConfig(
      { network: false, harnessApps: [], writableFolders: [] },
      catalog,
    );
    expect(config.features).toMatchObject({ apps: false, computer_use: false, browser_use: false });
    expect(config.apps).toBeUndefined();
    expect(config.sandbox_workspace_write).toEqual({ network_access: false, writable_roots: [] });
    expect(unresolved).toEqual([]);
  });

  test("allows named apps by name or ID, without destructive actions", () => {
    const { config, unresolved } = codexThreadConfig(
      { network: true, harnessApps: ["gmail", "connector_new_one", "Nope"], writableFolders: ["/srv/x"] },
      catalog,
    );
    expect(config.features).toMatchObject({ apps: true });
    expect(config.apps).toEqual({
      _default: { enabled: false, destructive_enabled: false },
      connector_gmail: { enabled: true, destructive_enabled: false },
      connector_new_one: { enabled: true, destructive_enabled: false },
    });
    expect(unresolved).toEqual(["Nope"]);
    expect(config.sandbox_workspace_write).toEqual({ network_access: true, writable_roots: ["/srv/x"] });
  });
});

describe("activityFromItem", () => {
  test("describes searches, commands, and tools in plain words", () => {
    const search = activityFromItem(
      { type: "webSearch", id: "1", query: "", action: { type: "search", query: "lisbon weather", queries: null } },
      true,
    );
    expect(search).toMatchObject({ kind: "search", title: "Searched: lisbon weather", status: "done" });

    const command = activityFromItem(
      { type: "commandExecution", id: "2", command: "ls -la", status: "completed", aggregatedOutput: "x", exitCode: 1 },
      true,
    );
    expect(command).toMatchObject({ kind: "command", title: "Ran ls -la", status: "failed" });

    const tool = activityFromItem(
      { type: "mcpToolCall", id: "3", server: "gmail", tool: "search", status: "inProgress", error: null },
      false,
    );
    expect(tool).toMatchObject({ kind: "tool", title: "Used gmail · search", status: "running" });

    expect(activityFromItem({ type: "userMessage", id: "4" }, true)).toBeNull();
  });
});
