import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, claudeModels, ClaudeAdapter, claudeSettings, CLAUDE_TOOLS } from "../src/harness/claude/adapter.ts";
import type { HarnessEvent, TurnRequest } from "../src/harness/types.ts";

const fixture = join(import.meta.dir, "fixtures", "fake-claude.ts");

afterEach(() => {
  delete process.env.FAKE_CLAUDE_SCENARIO;
  delete process.env.FAKE_CLAUDE_LOG;
});

function setup(scenario = "answer") {
  const dir = mkdtempSync(join(tmpdir(), "staf-claude-"));
  const logPath = join(dir, "calls.jsonl");
  process.env.FAKE_CLAUDE_SCENARIO = scenario;
  process.env.FAKE_CLAUDE_LOG = logPath;
  const adapter = new ClaudeAdapter({ command: ["bun", fixture] });
  const calls = () =>
    readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; prompt: string; cwd: string });
  return { adapter, dir, calls };
}

function turn(cwd: string, overrides: Partial<TurnRequest> = {}) {
  const events: HarnessEvent[] = [];
  const controller = new AbortController();
  const request: TurnRequest = {
    sessionId: null,
    cwd,
    access: { network: true, harnessApps: [], writableFolders: [] },
    instructions: "Be brief.",
    model: null,
    effort: null,
    fast: false,
    input: "What day is it?",
    signal: controller.signal,
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { request, events, controller };
}

function answer(events: HarnessEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "text") text += event.text;
    if (event.type === "text.set") text = event.text;
  }
  return text;
}

describe("ClaudeAdapter", () => {
  test("streams the answer and turns commentary and tools into steps", async () => {
    const { adapter, dir, calls } = setup();
    const { request, events } = turn(dir);

    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });

    expect(events[0]).toEqual({ type: "session", sessionId: "claude-session-1" });
    expect(answer(events)).toBe("It is Wednesday.");
    const steps = events.flatMap((e) => (e.type === "activity" ? [`${e.activity.status}: ${e.activity.title}`] : []));
    expect(steps).toEqual([
      "done: Let me check.",
      "running: Running a command",
      "running: Ran date",
      "done: Ran date",
    ]);
    const call = calls()[0]!;
    expect(call.prompt).toBe("What day is it?");
    expect(realpathSync(call.cwd)).toBe(realpathSync(dir));
  });

  test("resumes a saved session", async () => {
    const { adapter, dir, calls } = setup();
    const { request, events } = turn(dir, { sessionId: "saved-1" });
    expect(await adapter.runTurn(request)).toEqual({ status: "completed" });
    expect(events.some((e) => e.type === "session")).toBe(false);
    const args = calls()[0]!.args;
    expect(args[args.indexOf("--resume") + 1]).toBe("saved-1");
  });

  test("starts a new session when the saved one is gone", async () => {
    const { adapter, dir, calls } = setup("missing-session");
    const { request, events } = turn(dir, { sessionId: "gone", inputWithHistory: "HISTORY + What day is it?" });
    // The fake refuses any --resume, so the retry without it must succeed.
    process.env.FAKE_CLAUDE_SCENARIO = "missing-session";
    const outcome = await adapter.runTurn(request);
    expect(calls()).toHaveLength(2);
    expect(calls()[1]!.args).not.toContain("--resume");
    expect(calls()[1]!.prompt).toBe("HISTORY + What day is it?");
    expect(outcome).toEqual({ status: "completed" });
    expect(events.find((e) => e.type === "session")).toEqual({ type: "session", sessionId: "claude-session-1" });
  });

  test("reports an error result", async () => {
    const { adapter, dir } = setup("error");
    const { request } = turn(dir);
    expect(await adapter.runTurn(request)).toEqual({ status: "failed", error: "API overloaded" });
  });

  test("interrupts the process when the signal aborts", async () => {
    const { adapter, dir } = setup("slow");
    const { request, controller } = turn(dir);
    const outcome = adapter.runTurn(request);
    await Bun.sleep(300);
    controller.abort();
    expect(await outcome).toEqual({ status: "interrupted" });
  });
});

describe("claudeArgs", () => {
  test("keeps the person's setup out and limits tools and access", () => {
    const args = claudeArgs({
      sessionId: null,
      instructions: "Be brief.",
      model: "claude-sonnet-5-5",
      effort: null,
      fast: false,
      access: { network: false, harnessApps: [], writableFolders: ["/srv/notes"] },
    });
    expect(args).toContain("--safe-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(args.slice(args.indexOf("--tools") + 1, args.indexOf("--tools") + 1 + CLAUDE_TOOLS.length)).toEqual(CLAUDE_TOOLS);
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("Be brief.");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5-5");
    expect(args[args.indexOf("--add-dir") + 1]).toBe("/srv/notes");
    expect(args).not.toContain("--resume");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual(claudeSettings({ network: false, harnessApps: [], writableFolders: [] }));
  });

  test("opens the sandbox network only when the agent allows it", () => {
    const closed = claudeSettings({ network: false, harnessApps: [], writableFolders: [] });
    const open = claudeSettings({ network: true, harnessApps: [], writableFolders: [] });
    expect(closed).toEqual({
      fastMode: false,
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
    });
    expect(open.sandbox).toMatchObject({ network: { allowedDomains: ["*"] } });
  });

  test("passes the reasoning level and fast mode", () => {
    const access = { network: true, harnessApps: [], writableFolders: [] };
    const args = claudeArgs({ sessionId: null, instructions: "", model: "opus", effort: "high", fast: true, access });
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!).fastMode).toBe(true);
    expect(claudeArgs({ sessionId: null, instructions: "", model: null, effort: null, fast: false, access })).not.toContain("--effort");
  });

  test("turns Claude Code's model list into Staf's", () => {
    const models = claudeModels(
      [
        { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", supportsFastMode: true },
        {
          value: "opus",
          resolvedModel: "claude-opus-5-5",
          displayName: "Opus 5.5",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
          supportsFastMode: true,
        },
        { value: "claude-haiku-4-5", resolvedModel: "claude-haiku-4-5", displayName: "Haiku 4.5" },
      ],
      true,
    );
    expect(models).toEqual([
      { id: "opus", name: "Opus 5.5", isDefault: true, efforts: ["low", "high"], fast: true, fastNote: expect.any(String) },
      { id: "claude-haiku-4-5", name: "Haiku 4.5" },
    ]);
    // Fast mode is left out when the account cannot use it.
    expect(claudeModels([{ value: "opus", displayName: "Opus", supportsFastMode: true }], false)[0]!.fast).toBeUndefined();
  });
});

describe("ClaudeAdapter deletion", () => {
  test("deletes a session's transcript and the files beside it, and nothing else", async () => {
    const root = mkdtempSync(join(tmpdir(), "staf-claude-home-"));
    const id = "05c6c067-4e8c-4cc6-bcf9-11af43785ca7";
    const project = join(root, "projects", "-Users-x--staf-agents-default-workspace");
    mkdirSync(join(project, id, "subagents"), { recursive: true });
    mkdirSync(join(root, "session-env", id), { recursive: true });
    mkdirSync(join(root, "todos"), { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), "{}");
    writeFileSync(join(project, "other.jsonl"), "{}");
    writeFileSync(join(root, "todos", `${id}-agent-${id}.json`), "[]");

    await new ClaudeAdapter({ command: ["true"], configDir: root }).deleteSession(id);

    expect(existsSync(join(project, `${id}.jsonl`))).toBe(false);
    expect(existsSync(join(project, id))).toBe(false);
    expect(existsSync(join(root, "session-env", id))).toBe(false);
    expect(existsSync(join(root, "todos", `${id}-agent-${id}.json`))).toBe(false);
    expect(existsSync(join(project, "other.jsonl"))).toBe(true);
    await expect(new ClaudeAdapter({ configDir: root }).deleteSession("../x")).rejects.toThrow();
  });
});
