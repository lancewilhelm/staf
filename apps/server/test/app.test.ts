import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StafClient, type StreamEvent } from "@staf/protocol";
import { createApp, type App } from "../src/app.ts";
import { resolvePaths } from "../src/config.ts";
import { FakeHarness } from "../src/harness/fake.ts";
import { streamAnswer } from "../src/cli/stream.ts";
import { Store } from "../src/store.ts";

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
});

function start(harness = new FakeHarness()) {
  const home = mkdtempSync(join(tmpdir(), "staf-app-"));
  const paths = resolvePaths({ STAF_HOME: home });
  const app = createApp({ paths, hostname: "127.0.0.1", port: 0, harnessOverride: "fake", harnesses: [harness] });
  apps.push(app);
  const url = app.url.href.replace(/\/$/, "");
  return { app, harness, paths, url, client: new StafClient(url) };
}

/** Collects events until `until` returns true. */
async function collect(client: StafClient, until: (event: StreamEvent) => boolean, action: () => Promise<unknown>) {
  const events: StreamEvent[] = [];
  const controller = new AbortController();
  const iterator = client.events(controller.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ type: "ready" });
  await action();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    events.push(value);
    if (until(value)) break;
  }
  controller.abort();
  return events;
}

describe("chat over HTTP", () => {
  test("creates a thread, streams an answer, and saves it", async () => {
    const { client, harness } = start();
    const thread = await client.createThread();
    expect(thread).toMatchObject({ title: "New chat", agentId: "default", harness: "fake", status: "idle" });

    const events = await collect(
      client,
      (event) => event.type === "message.completed",
      () => client.sendMessage(thread.id, "  Hello there  "),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain("message.delta");
    expect(types).toContain("message.activity");
    const completed = events.find((event) => event.type === "message.completed");
    expect(completed?.type === "message.completed" && completed.message).toMatchObject({
      role: "assistant",
      status: "complete",
      text: "You said: **Hello there**",
    });

    await apps[0]!.chat.idle();
    const detail = await client.getThread(thread.id);
    expect(detail.thread).toMatchObject({ title: "Hello there", status: "idle" });
    expect(detail.messages.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(detail.messages[1]!.activities).toHaveLength(1);
    expect(detail.messages[1]!.activities[0]!.status).toBe("done");

    // The harness session is kept for the next turn.
    await client.sendMessage(thread.id, "Again");
    await apps[0]!.chat.idle();
    expect(harness.requests[0]!.sessionId).toBeNull();
    expect(harness.requests[1]!.sessionId).toStartWith("fake-");
  });

  test("rejects a second message while an answer is running, and can stop it", async () => {
    const { client, app } = start(new FakeHarness({ delayMs: 200 }));
    const thread = await client.createThread();
    await client.sendMessage(thread.id, "First");

    await expect(client.sendMessage(thread.id, "Second")).rejects.toMatchObject({ status: 409 });

    await client.interrupt(thread.id);
    await app.chat.idle();
    const detail = await client.getThread(thread.id);
    expect(detail.messages[1]!.status).toBe("interrupted");
  });

  test("records a harness failure on the message", async () => {
    const { client, app } = start(new FakeHarness({ fail: "Codex is not signed in." }));
    const thread = await client.createThread();
    await client.sendMessage(thread.id, "Hi");
    await app.chat.idle();
    const detail = await client.getThread(thread.id);
    expect(detail.messages[1]).toMatchObject({ status: "failed", error: "Codex is not signed in." });
  });

  test("the CLI stream helper prints the answer and its steps", async () => {
    const { client } = start();
    const thread = await client.createThread();
    let printed = "";
    const steps: string[] = [];
    const message = await streamAnswer(client, thread.id, "Ping", {
      text: (chunk) => (printed += chunk),
      activity: (activity) => steps.push(activity.title),
    });
    expect(message.status).toBe("complete");
    expect(printed).toBe("You said: **Ping**");
    expect(steps).toEqual(["Searched: Ping"]);
  });

  test("the CLI prints commentary once, and the web state drops it from the answer", async () => {
    const { client, app } = start(new FakeHarness({ commentary: true }));
    const thread = await client.createThread();
    let printed = "";
    const steps: string[] = [];
    const message = await streamAnswer(client, thread.id, "Ping", {
      text: (chunk) => (printed += chunk),
      activity: (activity) => steps.push(activity.title),
    });
    expect(printed).toBe("Let me look.\nYou said: **Ping**");
    expect(steps).toEqual(["Searched: Ping"]);
    expect(message.text).toBe("You said: **Ping**");
    await app.chat.idle();
    expect((await client.getThread(thread.id)).messages[1]!.activities.map((a) => a.title)).toEqual([
      "Let me look.",
      "Searched: Ping",
    ]);
  });

  test("deletes a thread and its messages", async () => {
    const { client, app } = start();
    const thread = await client.createThread();
    await client.sendMessage(thread.id, "Hi");
    await app.chat.idle();
    await client.deleteThread(thread.id);
    expect(await client.listThreads()).toEqual([]);
    await expect(client.getThread(thread.id)).rejects.toMatchObject({ status: 404 });
  });

  test("validates input", async () => {
    const { client } = start();
    const thread = await client.createThread();
    await expect(client.sendMessage(thread.id, "   ")).rejects.toMatchObject({ status: 400 });
    await expect(client.createThread({ agentId: "../etc" })).rejects.toMatchObject({ status: 404 });
    await expect(client.sendMessage("missing", "hi")).rejects.toMatchObject({ status: 404 });
  });
});

describe("agents", () => {
  test("lists agents with their harness, and refuses an unknown harness", async () => {
    const { client, paths } = start();
    mkdirSync(join(paths.agents, "odd"));
    writeFileSync(join(paths.agents, "odd", "agent.json"), JSON.stringify({ name: "Odd", harness: "nope" }));
    mkdirSync(join(paths.agents, "broken"));
    writeFileSync(join(paths.agents, "broken", "agent.json"), "{");

    const agents = await client.listAgents();
    // The default agent comes first; an agent with broken settings is left out.
    expect(agents.map((a) => a.id)).toEqual(["default", "odd"]);
    expect(agents[0]).toMatchObject({ name: "Staf", harness: "codex" });

    await expect(client.createThread({ agentId: "broken" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("request checks", () => {
  test("rejects changes without the Staf client header", async () => {
    const { url } = start();
    const res = await fetch(`${url}/api/threads`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("rejects a Host header that is not local", async () => {
    const { url } = start();
    const res = await fetch(`${url}/api/threads`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
  });

  test("reports harness readiness", async () => {
    const { client } = start();
    const health = await client.health();
    expect(health.harnesses).toEqual([{ id: "fake", label: "Fake harness", program: "Fake", signIn: "machine", ready: true }]);
  });
});

describe("Store", () => {
  test("marks answers that a previous process left unfinished", () => {
    const home = mkdtempSync(join(tmpdir(), "staf-store-"));
    const store = new Store(join(home, "staf.db"));
    const thread = store.createThread({ title: "t", agentId: "default", harness: "fake", model: null });
    store.updateThread(thread.id, { status: "running" });
    const message = store.addMessage({ threadId: thread.id, role: "assistant", text: "", status: "streaming" });

    expect(store.recoverInterrupted()).toBe(1);

    expect(store.getMessage(message.id)).toMatchObject({
      status: "interrupted",
      error: "Staf restarted before this answer finished.",
    });
    expect(store.getThread(thread.id)!.status).toBe("idle");
    store.close();
  });
});

/** An app with two fake harnesses and no override, so that agents and threads choose. */
function startTwo() {
  const alpha = new FakeHarness({ id: "alpha" });
  const beta = new FakeHarness({ id: "beta" });
  const home = mkdtempSync(join(tmpdir(), "staf-app-"));
  const paths = resolvePaths({ STAF_HOME: home });
  const app = createApp({ paths, hostname: "127.0.0.1", port: 0, harnesses: [alpha, beta] });
  apps.push(app);
  const url = app.url.href.replace(/\/$/, "");
  return { app, alpha, beta, paths, client: new StafClient(url) };
}

async function ask(client: StafClient, threadId: string, text: string) {
  return streamAnswer(client, threadId, text, { text: () => {}, activity: () => {} });
}

describe("agents over HTTP", () => {
  test("creates, edits, and deletes agents, and keeps access settings out of reach", async () => {
    const { client, paths, alpha } = startTwo();
    const created = await client.createAgent({ name: "Morning Paper", harness: "beta", model: null, instructions: "Write the paper." });
    expect(created).toMatchObject({ id: "morning-paper", name: "Morning Paper", harness: "beta", network: true, isDefault: false });

    // Access fields in the request are ignored.
    const edited = await client.updateAgent("morning-paper", {
      name: "Paper",
      model: "fake-large",
      writableFolders: ["/"],
      network: false,
    } as never);
    expect(edited).toMatchObject({ name: "Paper", harness: "beta", model: "fake-large", network: true, writableFolders: [] });
    const saved = JSON.parse(readFileSync(join(paths.agents, "morning-paper", "agent.json"), "utf8"));
    expect(saved).toMatchObject({ name: "Paper", model: "fake-large", network: true, writableFolders: [] });

    await expect(client.createAgent({ name: "X", harness: "nope", model: null, instructions: "" })).rejects.toThrow(/does not have/);
    await expect(client.deleteAgent("default")).rejects.toThrow(/cannot be deleted/);

    // Deleting an agent deletes its conversations and moves its folder to the trash.
    const thread = await client.createThread({ agentId: "morning-paper" });
    await ask(client, thread.id, "Hi");
    await client.deleteAgent("morning-paper");
    expect(await client.listThreads()).toEqual([]);
    expect(existsSync(join(paths.agents, "morning-paper"))).toBe(false);
    expect(readdirSync(join(paths.home, "trash", "agents"))[0]).toStartWith("morning-paper-");
    expect(alpha.deleted).toEqual([]);
  });

  test("lists a harness's models", async () => {
    const { client } = startTwo();
    expect((await client.listModels("alpha")).map((m) => m.id)).toEqual(["fake-small", "fake-large"]);
    await expect(client.listModels("nope")).rejects.toThrow(/no harness/);
  });
});

describe("changing the harness of a conversation", () => {
  test("hands the conversation to a new session and deletes every copy", async () => {
    const { client, alpha, beta } = startTwo();
    await client.updateAgent("default", { harness: "alpha" });
    const thread = await client.createThread();
    expect(thread).toMatchObject({ harness: "alpha", model: null });

    const first = await ask(client, thread.id, "What is the capital of France?");
    expect(first).toMatchObject({ harness: "alpha", model: null, status: "complete" });

    // A model change stays in the same session.
    await client.updateThread(thread.id, { model: "fake-large" });
    await ask(client, thread.id, "And of Spain?");
    expect(alpha.requests[1]).toMatchObject({ model: "fake-large", input: "And of Spain?" });
    expect(alpha.requests[1]!.sessionId).toStartWith("fake-");

    // A harness change starts a new session that receives the conversation so far.
    const moved = await client.updateThread(thread.id, { harness: "beta" });
    expect(moved).toMatchObject({ harness: "beta", model: null });
    const third = await ask(client, thread.id, "And Italy?");
    expect(third).toMatchObject({ harness: "beta", status: "complete" });
    const handoff = beta.requests[0]!;
    expect(handoff.sessionId).toBeNull();
    expect(handoff.input).toContain("<person>\nWhat is the capital of France?\n</person>");
    expect(handoff.input).toContain("You said: **And of Spain?**");
    expect(handoff.input.endsWith("And Italy?")).toBe(true);

    // The next message continues the new session without the earlier conversation.
    await ask(client, thread.id, "Thanks");
    expect(beta.requests[1]!.input).toBe("Thanks");

    const detail = await client.getThread(thread.id);
    expect(detail.messages.filter((m) => m.role === "assistant").map((m) => `${m.harness}/${m.model}`)).toEqual([
      "alpha/null",
      "alpha/fake-large",
      "beta/null",
      "beta/null",
    ]);

    await client.deleteThread(thread.id);
    expect(alpha.deleted).toHaveLength(1);
    expect(beta.deleted).toHaveLength(1);
    expect(alpha.deleted[0]).not.toBe(beta.deleted[0]);
  });

  test("starts a conversation on another harness and model than the agent's", async () => {
    const { client } = startTwo();
    await client.updateAgent("default", { harness: "alpha", model: "fake-large" });
    expect(await client.createThread()).toMatchObject({ harness: "alpha", model: "fake-large" });
    expect(await client.createThread({ harness: "beta" })).toMatchObject({ harness: "beta", model: null });
    expect(await client.createThread({ harness: "beta", model: "fake-small" })).toMatchObject({ model: "fake-small" });
  });

  test("keeps the conversation when a harness cannot delete its copy", async () => {
    const { client, alpha } = startTwo();
    await client.updateAgent("default", { harness: "alpha" });
    const thread = await client.createThread();
    await ask(client, thread.id, "Hi");
    alpha.deleteSession = async () => {
      throw new Error("disk is read-only");
    };
    await expect(client.deleteThread(thread.id)).rejects.toThrow(/could not delete Fake alpha's copy.*read-only/);
    expect((await client.listThreads()).map((t) => t.id)).toEqual([thread.id]);
  });
});

describe("Store migration", () => {
  test("upgrades a version 1 database and records its sessions", () => {
    const home = mkdtempSync(join(tmpdir(), "staf-store-"));
    const path = join(home, "staf.db");
    const v1 = new Database(path);
    v1.run(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent_id TEXT NOT NULL, harness TEXT NOT NULL,
      session_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    v1.run(`CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL, text TEXT NOT NULL, activities TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
      created_at INTEGER NOT NULL, completed_at INTEGER)`);
    v1.run("INSERT INTO threads VALUES ('t1', 'Old', 'default', 'codex', 'codex-session', 'idle', 1, 1)");
    v1.run("INSERT INTO messages VALUES ('m1', 't1', 'user', 'Hi', '[]', 'complete', NULL, 1, 1)");
    v1.run("INSERT INTO messages VALUES ('m2', 't1', 'assistant', 'Hello', '[]', 'complete', NULL, 2, 2)");
    v1.run("PRAGMA user_version = 1");
    v1.close();

    const store = new Store(path);
    expect(store.getThread("t1")).toMatchObject({ harness: "codex", model: null, sessionId: "codex-session" });
    expect(store.listSessions("t1")).toEqual([{ harness: "codex", sessionId: "codex-session", threadId: "t1" }]);
    const [user, assistant] = store.listMessages("t1");
    expect(user!.harness).toBeUndefined();
    expect(assistant).toMatchObject({ harness: "codex", model: null });
    store.close();
  });
});
