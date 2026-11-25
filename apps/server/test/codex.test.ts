import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityFromItem, CodexAdapter } from "../src/harness/codex/adapter.ts";
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
    instructions: "Be brief.",
    model: null,
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
      config: { web_search: "live" },
    });
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
    const { adapter } = setup("missing-thread");
    const { request, events } = turn({ sessionId: "thread-gone" });

    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });
    expect(events[0]).toEqual({ type: "session", sessionId: "thread-1" });
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
