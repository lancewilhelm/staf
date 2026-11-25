// A stand-in for `claude -p --output-format stream-json`, replaying message shapes
// recorded from Claude Code 2.1.331. FAKE_CLAUDE_SCENARIO: answer (default), slow,
// missing-session, or error. FAKE_CLAUDE_LOG receives the arguments and the prompt.

import { appendFileSync } from "node:fs";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "answer";
const args = process.argv.slice(2);
const prompt = await Bun.stdin.text();
if (process.env.FAKE_CLAUDE_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd() }) + "\n");
}

const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : null;
if (scenario === "missing-session" && resume) {
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  process.exit(1);
}

const sessionId = resume ?? "claude-session-1";
const out = (message: Record<string, unknown>) => process.stdout.write(JSON.stringify(message) + "\n");
const event = (value: Record<string, unknown>) => out({ type: "stream_event", event: value });

out({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash"], mcp_servers: [] });

if (scenario === "slow") {
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Working" } });
  process.on("SIGINT", () => process.exit(130));
  await new Promise(() => {});
}

if (scenario === "error") {
  out({ type: "result", subtype: "error_during_execution", is_error: true, result: "", errors: ["API overloaded"] });
  process.exit(1);
}

// Commentary, a tool call with its result, then the answer in two deltas.
event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me check." } });
event({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } });
out({
  type: "assistant",
  message: {
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "date" } },
    ],
  },
});
out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Wed Nov 25", is_error: false }] } });
event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It is " } });
event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Wednesday." } });
out({ type: "assistant", message: { content: [{ type: "text", text: "It is Wednesday." }] } });
out({ type: "result", subtype: "success", is_error: false, result: "It is Wednesday.", session_id: sessionId });
