import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    expect(health.harnesses).toEqual([{ id: "fake", label: "Fake harness", ready: true }]);
  });
});

describe("Store", () => {
  test("marks answers that a previous process left unfinished", () => {
    const home = mkdtempSync(join(tmpdir(), "staf-store-"));
    const store = new Store(join(home, "staf.db"));
    const thread = store.createThread({ title: "t", agentId: "default", harness: "fake" });
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
