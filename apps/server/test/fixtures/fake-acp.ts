// A stand-in for `agy acp` that replays message shapes recorded from agy 1.5.14.
// FAKE_ACP_SCENARIO: answer (default), write-outside, bypass, slow, or missing-session.
// FAKE_ACP_LOG names a file that receives each message from Staf as one JSON line.

import { appendFileSync } from "node:fs";

const scenario = process.env.FAKE_ACP_SCENARIO ?? "answer";
const log = process.env.FAKE_ACP_LOG;
const cwdBySession = new Map<string, string>();
let sessions = 0;
let nextRequest = 1000;
const waiting = new Map<number, (result: any) => void>();
let cancel: (() => void) | null = null;

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
function update(sessionId: string, value: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: value } });
}
function ask(method: string, params: unknown): Promise<any> {
  const id = nextRequest++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}
function chunk(sessionId: string, text: string): void {
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}
function tool(sessionId: string, call: Record<string, unknown>, status: string): void {
  update(sessionId, { sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update", status, ...call });
}

async function permission(sessionId: string, call: Record<string, unknown>): Promise<boolean> {
  tool(sessionId, call, "pending");
  const reply = await ask("session/request_permission", {
    sessionId,
    toolCall: { sessionUpdate: "tool_call", status: "pending", ...call },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  });
  return reply.outcome?.optionId === "allow";
}

async function prompt(sessionId: string): Promise<string> {
  const cwd = cwdBySession.get(sessionId) ?? "/tmp";
  if (scenario === "slow") {
    chunk(sessionId, "Starting…");
    await new Promise<void>((resolve) => (cancel = resolve));
    return "cancelled";
  }
  if (scenario === "write-outside" || scenario === "bypass") {
    const call =
      scenario === "bypass"
        ? { toolCallId: "t1", kind: "execute", title: "touch ../x", rawInput: { CommandLine: "touch ../x", BypassSandbox: true } }
        : { toolCallId: "t1", kind: "edit", title: "File ../x", locations: [{ path: `${cwd}/../x.txt` }] };
    tool(sessionId, call, "in_progress");
    const ok = await permission(sessionId, call);
    tool(sessionId, call, ok ? "completed" : "failed");
    return "end_turn";
  }
  chunk(sessionId, "I'll look that up.");
  const search = { toolCallId: "s1", kind: "search", title: "\"lisbon weather\" on Web", rawInput: { query: "lisbon weather" } };
  tool(sessionId, search, "in_progress");
  tool(sessionId, search, "completed");
  const write = { toolCallId: "w1", kind: "edit", title: "File notes.txt", locations: [{ path: `${cwd}/notes.txt` }] };
  tool(sessionId, write, "in_progress");
  const ok = await permission(sessionId, write);
  tool(sessionId, write, ok ? "completed" : "failed");
  const command = {
    toolCallId: "c1",
    kind: "execute",
    title: "false",
    rawInput: { CommandLine: "false", BypassSandbox: false },
  };
  tool(sessionId, command, "in_progress");
  await permission(sessionId, command);
  tool(sessionId, { ...command, content: [{ type: "content", content: { type: "text", text: "Command exited with code 1." } }] }, "completed");
  chunk(sessionId, "It is ");
  chunk(sessionId, "sunny.");
  return "end_turn";
}

async function handle(message: any): Promise<void> {
  if (log) appendFileSync(log, JSON.stringify(message) + "\n");
  if (message.id !== undefined && message.method === undefined) {
    waiting.get(message.id)?.(message.result);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
      return;
    case "session/new": {
      const sessionId = `session-${++sessions}`;
      cwdBySession.set(sessionId, params.cwd);
      send({ id, result: { sessionId } });
      return;
    }
    case "session/load":
      if (scenario === "missing-session") {
        send({ id, error: { code: -32002, message: "Resource not found" } });
        return;
      }
      cwdBySession.set(params.sessionId, params.cwd);
      // Real agents replay the conversation before they answer.
      chunk(params.sessionId, "an old answer that must not appear");
      send({ id, result: {} });
      return;
    case "session/set_model":
      send({ id, result: {} });
      return;
    case "session/prompt":
      send({ id, result: { stopReason: await prompt(params.sessionId) } });
      return;
    case "session/cancel":
      cancel?.();
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
}

const decoder = new TextDecoder();
let buffer = "";
for await (const piece of Bun.stdin.stream()) {
  buffer += decoder.decode(piece, { stream: true });
  let end: number;
  while ((end = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line) void handle(JSON.parse(line));
  }
}
