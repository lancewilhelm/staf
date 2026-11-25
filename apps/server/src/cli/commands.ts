import { createInterface } from "node:readline/promises";
import { type Activity, type Message, StafApiError, StafClient } from "@staf/protocol";
import { resolvePaths, resolveServerUrl } from "../config.ts";
import { CodexAdapter } from "../harness/codex/adapter.ts";
import { streamAnswer, type AnswerOutput } from "./stream.ts";

const tty = process.stdout.isTTY === true;
const dim = (text: string) => (tty ? `\x1b[2m${text}\x1b[22m` : text);
const bold = (text: string) => (tty ? `\x1b[1m${text}\x1b[22m` : text);

function client(): StafClient {
  return new StafClient(resolveServerUrl());
}

/** Fails with a helpful message when the host is not running. */
async function connect(): Promise<StafClient> {
  const api = client();
  try {
    await api.health();
  } catch (error) {
    if (error instanceof StafApiError) throw error;
    throw new CliError(`Staf is not running at ${api.baseUrl}. Start it with \`staf serve\`.`);
  }
  return api;
}

export class CliError extends Error {}

const terminalOutput: AnswerOutput = {
  text: (chunk) => process.stdout.write(chunk),
  activity: (activity: Activity) => {
    const mark = activity.status === "failed" ? "✗" : "·";
    process.stderr.write(dim(`${mark} ${activity.title}\n`));
  },
};

function finishAnswer(message: Message): void {
  if (message.text && !message.text.endsWith("\n")) process.stdout.write("\n");
  if (message.status === "failed") process.stderr.write(`Staf could not answer: ${message.error}\n`);
  if (message.status === "interrupted") process.stderr.write(dim("Stopped.\n"));
}

/** Reads --agent, --harness, and --model, which choose who answers a new conversation. */
function readChoice(args: string[], i: number, choice: { agentId?: string; harness?: string; model?: string }): number {
  const flag = args[i];
  if (flag === "--agent") choice.agentId = args[++i];
  else if (flag === "--harness") choice.harness = args[++i];
  else if (flag === "--model") choice.model = args[++i];
  else return -1;
  return i;
}

export async function ask(args: string[]): Promise<number> {
  let threadId: string | null = null;
  const choice: { agentId?: string; harness?: string; model?: string } = {};
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--thread") threadId = args[++i] ?? null;
    else {
      const next = readChoice(args, i, choice);
      if (next >= 0) i = next;
      else words.push(args[i]!);
    }
  }
  const question = words.join(" ").trim() || (process.stdin.isTTY ? "" : await Bun.stdin.text());
  if (!question.trim()) throw new CliError('Ask a question, for example: staf ask "Is it going to rain today?"');

  const api = await connect();
  if (threadId && (choice.harness || choice.model)) {
    await api.updateThread(threadId, { ...(choice.harness ? { harness: choice.harness } : {}), ...(choice.model ? { model: choice.model } : {}) });
  }
  threadId ??= (await api.createThread(choice)).id;
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  const message = await streamAnswer(api, threadId, question, terminalOutput, stop.signal);
  finishAnswer(message);
  process.stderr.write(dim(`Continue with: staf chat ${threadId}\n`));
  return message.status === "failed" ? 1 : 0;
}

export async function chat(args: string[]): Promise<number> {
  const api = await connect();
  const choice: { agentId?: string; harness?: string; model?: string } = {};
  let threadId: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const next = readChoice(args, i, choice);
    if (next >= 0) i = next;
    else threadId = args[i] ?? null;
  }
  if (threadId) {
    const detail = await api.getThread(threadId);
    process.stdout.write(dim(`Continuing "${detail.thread.title}"\n`));
  }
  process.stdout.write(dim("Type a message. /new starts a new chat, /exit quits.\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let current: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (current) current.abort();
    else rl.close();
  });

  try {
    for (;;) {
      let line: string;
      try {
        line = (await rl.question(bold("› "))).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === "/exit" || line === "/quit") break;
      if (line === "/new") {
        threadId = null;
        process.stdout.write(dim("Started a new chat.\n"));
        continue;
      }
      threadId ??= (await api.createThread(choice)).id;
      current = new AbortController();
      try {
        finishAnswer(await streamAnswer(api, threadId, line, terminalOutput, current.signal));
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      } finally {
        current = null;
      }
    }
  } finally {
    rl.close();
  }
  return 0;
}

export async function threads(): Promise<number> {
  const api = await connect();
  const list = await api.listThreads();
  if (list.length === 0) {
    process.stdout.write("No conversations yet.\n");
    return 0;
  }
  for (const thread of list) {
    const when = new Date(thread.updatedAt).toLocaleString();
    process.stdout.write(`${thread.id}  ${dim(when)}  ${thread.title}\n`);
  }
  return 0;
}

export async function status(): Promise<number> {
  const api = client();
  try {
    const health = await api.health();
    process.stdout.write(`Staf ${health.version} is running at ${api.baseUrl}\n`);
    for (const harness of health.harnesses) {
      const state = harness.ready ? "ready" : `not ready: ${harness.detail ?? "unknown reason"}`;
      const tag = harness.experimental ? " (experimental)" : "";
      process.stdout.write(`  ${harness.label} via ${harness.program}${tag}: ${state}\n`);
      if (harness.note) process.stdout.write(dim(`    ${harness.note}\n`));
    }
    return 0;
  } catch {
    process.stdout.write(`Staf is not running at ${api.baseUrl}.\n`);
    return 1;
  }
}

export async function login(args: string[]): Promise<number> {
  const harness = args[0];
  if (harness !== "codex") throw new CliError("Usage: staf login codex");
  const { codexHome } = resolvePaths();
  if (!Bun.which("codex")) throw new CliError("Install the Codex CLI first: https://github.com/openai/codex");
  process.stdout.write(`Signing Staf in to ChatGPT. Staf keeps this login in ${codexHome}.\n`);
  const proc = Bun.spawn(["codex", "login", ...args.slice(1)], {
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}

export async function apps(args: string[]): Promise<number> {
  const showAll = args.includes("--all");
  const { codexHome } = resolvePaths();
  const adapter = new CodexAdapter({ codexHome });
  process.stderr.write(dim("Asking ChatGPT for the apps on Staf's account. This can take a minute.\n"));
  try {
    let list: Awaited<ReturnType<CodexAdapter["listApps"]>>;
    try {
      list = await adapter.listApps();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new CliError(`Codex could not list the apps (${reason}). Try again in a moment.`);
    }
    const hidden = showAll ? 0 : list.filter((app) => !app.accessible).length;
    if (!showAll) list = list.filter((app) => app.accessible);
    if (list.length === 0) {
      process.stdout.write("No apps are connected to Staf's ChatGPT account.\n");
      return 0;
    }
    const width = Math.max(...list.map((app) => app.name.length));
    for (const app of list) {
      const note = app.accessible ? "" : dim("  (not connected)");
      process.stdout.write(`${app.name.padEnd(width)}  ${dim(app.id)}${note}\n`);
    }
    if (hidden > 0) process.stdout.write(dim(`\n${hidden} apps in ChatGPT's directory are not connected. Run \`staf apps --all\` to see them.\n`));
    process.stdout.write(
      dim('\nTo let an agent use an app, add its name to "harnessApps" in the agent\'s agent.json.\n'),
    );
    return 0;
  } finally {
    await adapter.close();
  }
}
