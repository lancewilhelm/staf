// A stand-in for `codex app-server` that replays messages recorded from codex-cli 0.172.0.
// FAKE_CODEX_SCENARIO picks the behavior: answer (default), slow, crash, or missing-thread.
// FAKE_CODEX_LOG names a file that receives each request as one JSON line.

import { appendFileSync } from "node:fs";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "answer";
const log = process.env.FAKE_CODEX_LOG;

let threadCounter = 0;
let turnCounter = 0;
let slowTurn: { threadId: string; turnId: string } | null = null;

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function note(method: string, params: unknown): void {
  send({ method, params });
}

function item(threadId: string, turnId: string, value: Record<string, unknown>, done: boolean): void {
  note(done ? "item/completed" : "item/started", { item: value, threadId, turnId });
}

function completeTurn(threadId: string, turnId: string, status: string): void {
  note("turn/completed", {
    threadId,
    turn: { id: turnId, status, error: status === "failed" ? { message: "boom" } : null },
  });
}

async function runAnswer(threadId: string, turnId: string): Promise<void> {
  await Bun.sleep(5);
  note("turn/started", { threadId, turn: { id: turnId, status: "inProgress", error: null } });
  const commentary = { type: "agentMessage", id: "msg-1", text: "", phase: "commentary" };
  item(threadId, turnId, commentary, false);
  note("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: "I'll check AP." });
  item(threadId, turnId, { ...commentary, text: "I'll check AP." }, true);

  item(threadId, turnId, { type: "webSearch", id: "ws-1", query: "", action: null }, false);
  item(
    threadId,
    turnId,
    { type: "webSearch", id: "ws-1", query: "https://apnews.com/", action: { type: "openPage", url: "https://apnews.com/" } },
    true,
  );

  const answer = { type: "agentMessage", id: "msg-2", text: "", phase: "final_answer" };
  item(threadId, turnId, answer, false);
  for (const delta of ["AP leads ", "with **news**."]) {
    note("item/agentMessage/delta", { threadId, turnId, itemId: "msg-2", delta });
  }
  item(threadId, turnId, { ...answer, text: "AP leads with **news**." }, true);
  completeTurn(threadId, turnId, "completed");
}

async function handle(message: { id?: number; method?: string; params?: any }): Promise<void> {
  if (log && message.method) appendFileSync(log, JSON.stringify(message) + "\n");
  const { id, method, params } = message;
  if (id === undefined) return;

  switch (method) {
    case "initialize":
      send({ id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" } });
      return;
    case "thread/start":
      send({ id, result: { thread: { id: `thread-${++threadCounter}` } } });
      return;
    case "thread/resume":
      if (scenario === "missing-thread") {
        send({ id, error: { code: -32600, message: "thread not found" } });
      } else {
        send({ id, result: { thread: { id: params.threadId } } });
      }
      return;
    case "turn/start": {
      const turnId = `turn-${++turnCounter}`;
      send({ id, result: { turn: { id: turnId, status: "inProgress", error: null } } });
      if (scenario === "slow") slowTurn = { threadId: params.threadId, turnId };
      else if (scenario === "crash") {
        await Bun.sleep(5);
        process.stderr.write("fatal: something broke\n");
        process.exit(3);
      } else await runAnswer(params.threadId, turnId);
      return;
    }
    case "app/list":
      send({
        id,
        result: {
          data: [
            { id: "connector_gmail", name: "Gmail", isAccessible: true },
            { id: "connector_expedia", name: "Expedia", isAccessible: true },
          ],
          nextCursor: null,
        },
      });
      return;
    case "model/list":
      send({
        id,
        result: {
          data: [
            { id: "gpt-a", displayName: "GPT-A", hidden: false, isDefault: true },
            {
              id: "gpt-b",
              displayName: "GPT-B",
              hidden: false,
              isDefault: false,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
              defaultReasoningEffort: "low",
              serviceTiers: [{ id: "priority", name: "Fast", description: "2x speed" }],
            },
            { id: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
          ],
          nextCursor: null,
        },
      });
      return;
    case "account/read":
      send({ id, result: { account: { type: "chatgpt", email: "person@example.com", planType: "plus" }, requiresOpenaiAuth: true } });
      return;
    case "thread/delete":
      if (params.threadId === "thread-gone") send({ id, error: { code: -32600, message: "thread not found" } });
      else send({ id, result: {} });
      return;
    case "turn/interrupt":
      send({ id, result: {} });
      if (slowTurn) completeTurn(slowTurn.threadId, slowTurn.turnId, "interrupted");
      slowTurn = null;
      return;
    default:
      send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line) await handle(JSON.parse(line));
  }
}
