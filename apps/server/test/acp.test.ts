import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityFromToolCall, defaultPermission, isInside } from "../src/harness/acp/adapter.ts";
import { antigravityAdapter, deleteAntigravitySession } from "../src/harness/acp/antigravity.ts";
import type { HarnessAdapter, HarnessEvent, TurnRequest } from "../src/harness/types.ts";
import { groupLevels, resolveLevel } from "../src/harness/acp/levels.ts";

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
  return { adapter, dir, workspace, sent };
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
    effort: null,
    fast: false,
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

    expect(await adapter.runTurn(request)).toMatchObject({ status: "completed" });

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

    expect(await adapter.runTurn(request)).toMatchObject({ status: "completed" });
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

    expect(await adapter.runTurn(request)).toMatchObject({ status: "completed" });

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
    const { adapter, workspace, sent } = setup("missing-session");
    const { request, events } = turn(workspace, { sessionId: "gone", inputWithHistory: "HISTORY + Weather?" });
    expect(await adapter.runTurn(request)).toMatchObject({
      status: "completed",
      report: { sessionAction: "recovered" },
    });
    expect(events[0]).toEqual({ type: "session", sessionId: "session-1" });
    expect(sent().find((m) => m.method === "session/prompt")!.params.prompt[0].text).toBe("HISTORY + Weather?");
  });

  test("cancels the prompt when the signal aborts", async () => {
    const { adapter, workspace, sent } = setup("slow");
    const { request, controller } = turn(workspace);
    const outcome = adapter.runTurn(request);
    await Bun.sleep(150);
    controller.abort();
    expect(await outcome).toMatchObject({ status: "interrupted" });
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

  test("passes the Staf MCP bridge in session/new mcpServers", async () => {
    const { adapter, workspace, sent } = setup();
    const { request } = turn(workspace, {
      mcp: {
        command: "/usr/local/bin/staf",
        args: ["mcp-bridge", "--url", "http://127.0.0.1:4280"],
        env: { STAF_RUN_TOKEN: "tok-acp" },
      },
    });
    await adapter.runTurn(request);
    const start = sent().find((m) => m.method === "session/new")!;
    expect(start.params.mcpServers).toEqual([
      {
        name: "staf",
        command: "/usr/local/bin/staf",
        args: ["mcp-bridge", "--url", "http://127.0.0.1:4280"],
        env: [{ name: "STAF_RUN_TOKEN", value: "tok-acp" }],
      },
    ]);
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

describe("Antigravity models and deletion", () => {
  test("switches models within a session only when the choice changes", async () => {
    const { adapter, workspace, sent } = setup();
    await adapter.runTurn(turn(workspace).request);
    await adapter.runTurn(turn(workspace, { sessionId: "session-1", model: "gem-low" }).request);
    await adapter.runTurn(turn(workspace, { sessionId: "session-1", model: "gem-low" }).request);
    await adapter.runTurn(turn(workspace, { sessionId: "session-1", model: null }).request);
    const switches = sent().filter((m) => m.method === "session/set_model").map((m) => m.params.modelId);
    expect(switches).toEqual(["gem-low", "gem-high"]);
  });

  test("turns a model and reasoning level into the matching Antigravity model", async () => {
    const { adapter, workspace, sent } = setup();
    await adapter.runTurn(turn(workspace).request);
    await adapter.runTurn(turn(workspace, { sessionId: "session-1", model: "gem", effort: "low" }).request);
    await adapter.runTurn(turn(workspace, { sessionId: "session-1", model: "gem", effort: null }).request);
    await adapter.runTurn(turn(workspace, { sessionId: "session-1", model: null, effort: "low" }).request);
    const switches = sent().filter((m) => m.method === "session/set_model").map((m) => m.params.modelId);
    expect(switches).toEqual(["gem-low", "gem-high", "gem-low"]);
  });

  test("lists models from a session that it then deletes, and caches the list", async () => {
    const { adapter, dir, sent } = setup();
    const models = await adapter.listModels();
    // Each level is its own model in Antigravity. Staf shows one model with its levels.
    expect(models).toEqual([{ id: "gem", name: "Gem", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" }]);
    expect(sent().filter((m) => m.method === "session/close")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "home", "staf-models.json"), "utf8")).defaultId).toBe("gem-high");
  });

  test("merges levels only for models that come in several levels", () => {
    const raw = [
      { id: "neon-high", name: "Neon (High)", isDefault: true },
      { id: "neon-low", name: "Neon (Low)" },
      { id: "carbon-low", name: "Carbon (Low)" },
      { id: "carbon-medium", name: "Carbon (Medium)" },
      { id: "carbon-high", name: "Carbon (High)" },
      { id: "orchestrator", name: "Orchestrator (Neon)" },
      { id: "oss-medium", name: "OSS (Medium)" },
    ];
    expect(groupLevels(raw)).toEqual([
      { id: "neon", name: "Neon", isDefault: true, efforts: ["low", "high"], defaultEffort: "high" },
      // The default model's level is used where the model has it.
      { id: "carbon", name: "Carbon", efforts: ["low", "medium", "high"], defaultEffort: "high" },
      { id: "orchestrator", name: "Orchestrator (Neon)" },
      { id: "oss-medium", name: "OSS (Medium)" },
    ]);
    expect(resolveLevel(raw, "carbon", null)).toBe("carbon-high");
    expect(resolveLevel(raw, "carbon", "medium")).toBe("carbon-medium");
    expect(resolveLevel(raw, "carbon", "xhigh")).toBe("carbon-high");
    expect(resolveLevel(raw, "oss-medium", "high")).toBe("oss-medium");
    expect(resolveLevel(raw, null, null)).toBe("neon-high");
  });

  test("deletes a conversation's files and summary", () => {
    const data = mkdtempSync(join(tmpdir(), "staf-agy-"));
    const id = "0d1f43ff-23cc-4efa-9ec4-f106a71986de";
    const other = "11111111-2222-3333-4444-555555555555";
    for (const folder of ["conversations", "annotations", `brain/${id}/scratch`, `brain/${other}`]) {
      mkdirSync(join(data, folder), { recursive: true });
    }
    for (const file of [`conversations/${id}.db`, `conversations/${id}.db-wal`, `conversations/${other}.db`, `annotations/${id}.pbtxt`]) {
      writeFileSync(join(data, file), "x");
    }
    const db = new Database(join(data, "conversation_summaries.db"));
    db.run("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT)");
    db.run(`INSERT INTO conversation_summaries VALUES ('${id}', 'Mine'), ('${other}', 'Other')`);
    db.close();

    deleteAntigravitySession(data, id);

    expect(existsSync(join(data, "conversations", `${id}.db`))).toBe(false);
    expect(existsSync(join(data, "conversations", `${id}.db-wal`))).toBe(false);
    expect(existsSync(join(data, "annotations", `${id}.pbtxt`))).toBe(false);
    expect(existsSync(join(data, "brain", id))).toBe(false);
    expect(existsSync(join(data, "conversations", `${other}.db`))).toBe(true);
    expect(existsSync(join(data, "brain", other))).toBe(true);
    const left = new Database(join(data, "conversation_summaries.db"));
    expect(left.query("SELECT conversation_id FROM conversation_summaries").all()).toEqual([{ conversation_id: other }]);
    left.close();
    expect(() => deleteAntigravitySession(data, "../escape")).toThrow();
  });
});
