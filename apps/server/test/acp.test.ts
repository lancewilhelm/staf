import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityFromToolCall, defaultPermission, isInside } from "../src/harness/acp/adapter.ts";
import { antigravityAdapter } from "../src/harness/acp/antigravity.ts";
import type { HarnessAdapter, HarnessEvent, TurnRequest } from "../src/harness/types.ts";

const fixture = join(import.meta.dir, "fixtures", "fake-acp.ts");
const adapters: HarnessAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
  delete process.env.FAKE_ACP_SCENARIO;
  delete process.env.FAKE_ACP_LOG;
});

function setup(scenario = "answer") {
  const dir = mkdtempSync(join(tmpdir(), "staf-acp-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const logPath = join(dir, "messages.jsonl");
  process.env.FAKE_ACP_SCENARIO = scenario;
  process.env.FAKE_ACP_LOG = logPath;
  const adapter = antigravityAdapter({ home: join(dir, "home"), command: ["bun", fixture] });
  adapters.push(adapter);
  const sent = () =>
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: number; method?: string; params?: any; result?: any });
  return { adapter, workspace, sent };
}

function turn(workspace: string, overrides: Partial<TurnRequest> = {}) {
  const events: HarnessEvent[] = [];
  const controller = new AbortController();
  const request: TurnRequest = {
    sessionId: null,
    cwd: workspace,
    access: { network: true, harnessApps: [], writableFolders: [] },
    instructions: "Be brief.",
    model: null,
    input: "Weather?",
    signal: controller.signal,
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { request, events, controller };
}

/** Replays text events into the final answer text. */
function answer(events: HarnessEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text") text += event.text;
    if (event.type === "text.set") text = event.text;
  }
  return text;
}

const titles = (events: HarnessEvent[]) =>
  events.flatMap((event) => (event.type === "activity" ? [`${event.activity.status}: ${event.activity.title}`] : []));

describe("Antigravity over ACP", () => {
  test("streams the answer, moves commentary into a step, and allows edits in the workspace", async () => {
    const { adapter, workspace, sent } = setup();
    const { request, events } = turn(workspace);

    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });

    expect(events[0]).toEqual({ type: "session", sessionId: "session-1" });
    expect(answer(events)).toBe("It is sunny.");
    const steps = titles(events);
    expect(steps).toContain("done: I'll look that up.");
    expect(steps).toContain("done: Searched: lisbon weather");
    expect(steps).toContain("done: Edited notes.txt");
    // The command exited with code 1, so it is a failed step.
    expect(steps.at(-1)).toBe("failed: Ran false");

    const start = sent().find((m) => m.method === "session/new")!;
    expect(start.params).toEqual({
      cwd: workspace,
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: "Be brief." } } },
    });
    const replies = sent().filter((m) => m.result?.outcome);
    expect(replies.map((m) => m.result.outcome.optionId)).toEqual(["allow", "allow"]);
  });

  test("refuses edits outside the workspace and explains the empty answer", async () => {
    const { adapter, workspace } = setup("write-outside");
    const { request, events } = turn(workspace);

    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });
    expect(titles(events)).toContain("failed: Edited x.txt");
    expect(answer(events)).toContain("Staf refused a step that is outside this agent's permissions");
  });

  test("refuses commands that ask to leave the sandbox", async () => {
    const { adapter, workspace, sent } = setup("bypass");
    const { request } = turn(workspace);
    await adapter.runTurn(request);
    expect(sent().find((m) => m.result?.outcome)!.result.outcome.optionId).toBe("deny");
  });

  test("loads a saved session, ignores its replayed history, and sets the model", async () => {
    const { adapter, workspace, sent } = setup();
    const { request, events } = turn(workspace, { sessionId: "saved", model: "gemini-4-neon-low" });

    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });

    expect(events.some((event) => event.type === "session")).toBe(false);
    expect(answer(events)).toBe("It is sunny.");
    const methods = sent().map((m) => m.method);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(sent().find((m) => m.method === "session/set_model")!.params).toEqual({
      sessionId: "saved",
      modelId: "gemini-4-neon-low",
    });
  });

  test("starts a new session when the saved one is gone", async () => {
    const { adapter, workspace } = setup("missing-session");
    const { request, events } = turn(workspace, { sessionId: "gone" });
    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });
    expect(events[0]).toEqual({ type: "session", sessionId: "session-1" });
  });

  test("cancels the prompt when the signal aborts", async () => {
    const { adapter, workspace, sent } = setup("slow");
    const { request, controller } = turn(workspace);
    const outcome = adapter.runTurn(request);
    await Bun.sleep(150);
    controller.abort();
    expect(await outcome).toEqual({ status: "interrupted" });
    expect(sent().map((m) => m.method)).toContain("session/cancel");
  });

  test("notes that writable folders are read-only on Antigravity", async () => {
    const { adapter, workspace } = setup();
    const { request, events } = turn(workspace, {
      access: { network: true, harnessApps: [], writableFolders: ["/srv/notes"] },
    });
    await adapter.runTurn(request);
    expect(titles(events)[0]).toStartWith("failed: Antigravity can only write to the agent's workspace");
  });
});

describe("ACP permission rules", () => {
  const access = { network: true, harnessApps: [], writableFolders: [] as string[] };

  test("allow file changes only inside the workspace or writable folders", () => {
    const root = mkdtempSync(join(tmpdir(), "staf-perm-"));
    const workspace = join(root, "workspace");
    const notes = join(root, "notes");
    mkdirSync(workspace);
    mkdirSync(notes);
    const edit = (path: string) => ({ toolCallId: "1", kind: "edit", locations: [{ path }] });

    expect(defaultPermission({ toolCall: edit(join(workspace, "a.txt")), cwd: workspace, access })).toBe(true);
    expect(defaultPermission({ toolCall: edit(join(workspace, "new", "b.txt")), cwd: workspace, access })).toBe(true);
    expect(defaultPermission({ toolCall: edit(join(workspace, "..", "a.txt")), cwd: workspace, access })).toBe(false);
    expect(defaultPermission({ toolCall: edit(join(notes, "a.txt")), cwd: workspace, access })).toBe(false);
    expect(
      defaultPermission({
        toolCall: edit(join(notes, "a.txt")),
        cwd: workspace,
        access: { ...access, writableFolders: [notes] },
      }),
    ).toBe(true);
    expect(defaultPermission({ toolCall: { toolCallId: "1", kind: "edit" }, cwd: workspace, access })).toBe(false);
    expect(defaultPermission({ toolCall: { toolCallId: "1", kind: "search" }, cwd: workspace, access })).toBe(true);
  });

  test("follow symbolic links before comparing paths", () => {
    const root = mkdtempSync(join(tmpdir(), "staf-link-"));
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    symlinkSync(root, join(workspace, "escape"));
    expect(isInside(join(workspace, "escape", "x.txt"), workspace)).toBe(false);
    expect(isInside(join(workspace, "x.txt"), workspace)).toBe(true);
  });
});

describe("activityFromToolCall", () => {
  test("describes tool calls in plain words", () => {
    expect(
      activityFromToolCall({ toolCallId: "1", kind: "fetch", rawInput: { url: "https://www.apnews.com/x" }, status: "completed" }),
    ).toMatchObject({ kind: "page", title: "Opened apnews.com", status: "done" });
    expect(activityFromToolCall({ toolCallId: "2", kind: "read", locations: [{ path: "/a/b.md" }] })).toMatchObject({
      kind: "file",
      title: "Read b.md",
      status: "running",
    });
    expect(activityFromToolCall({ toolCallId: "3", kind: "other", title: "calendar lookup", status: "failed" })).toMatchObject({
      kind: "tool",
      title: "Used calendar lookup",
      status: "failed",
    });
  });
});
