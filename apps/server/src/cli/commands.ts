import { createInterface } from "node:readline/promises";
import {
  isMemoryBlock,
  memoryBlockLabel,
  type Activity,
  type Message,
  StafApiError,
  StafClient,
} from "@staf/protocol";
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
interface CliChoice {
  agentId?: string;
  harness?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
}

function readChoice(args: string[], i: number, choice: CliChoice): number {
  const flag = args[i];
  if (flag === "--agent") choice.agentId = args[++i];
  else if (flag === "--harness") choice.harness = args[++i];
  else if (flag === "--model") choice.model = args[++i];
  else if (flag === "--effort") choice.effort = args[++i];
  else if (flag === "--fast") choice.fast = true;
  else if (flag === "--no-fast") choice.fast = false;
  else return -1;
  return i;
}

export async function ask(args: string[]): Promise<number> {
  let threadId: string | null = null;
  const choice: CliChoice = {};
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
  if (threadId) {
    const { agentId: _agentId, ...change } = choice;
    if (Object.keys(change).length > 0) await api.updateThread(threadId, change);
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
  const choice: CliChoice = {};
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

const MEMORY_HELP = `Usage:
  staf memory [list] [--agent <id>]
  staf memory add [--agent <id>] <notes|profile> "<text>"
  staf memory edit <id> "<text>"
  staf memory rm <id>
  staf memory approve <id> ["<text>"]
  staf memory reject <id>
  staf memory limits [--agent <id>] [--notes <chars>] [--profile <chars>] [--nudge <count>]
`;

export async function memory(args: string[]): Promise<number> {
  let agentId = "default";
  let notesLimit: number | undefined;
  let profileLimit: number | undefined;
  let nudgeInterval: number | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--agent") agentId = args[++i] ?? agentId;
    else if (arg === "--notes") notesLimit = parseIntFlag("--notes", args[++i]);
    else if (arg === "--profile") profileLimit = parseIntFlag("--profile", args[++i]);
    else if (arg === "--nudge") nudgeInterval = parseIntFlag("--nudge", args[++i]);
    else rest.push(arg);
  }

  const [sub = "list", ...subArgs] = rest;
  if (sub === "help" || sub === "--help" || sub === "-h") {
    process.stdout.write(MEMORY_HELP);
    return 0;
  }

  const api = await connect();

  switch (sub) {
    case "list": {
      const snap = await api.getAgentMemory(agentId);
      process.stdout.write(
        bold(`Memory for ${snap.agentId}`) +
          dim(
            `  (Notes ${snap.usage.notes.used}/${snap.usage.notes.limit} chars · Profile ${snap.usage.profile.used}/${snap.usage.profile.limit} chars · Reminder every ${snap.settings.nudgeInterval || "off"} messages)\n`,
          ),
      );
      if (snap.proposed.length > 0) {
        process.stdout.write(`\n${bold("Pending proposals")}\n`);
        for (const item of snap.proposed) {
          const action = item.proposedAction ?? "add";
          process.stdout.write(
            `  ${item.id.slice(0, 8)}  [${action} · ${memoryBlockLabel(item.block)}]  ${item.text}\n`,
          );
          if (item.targetText) process.stdout.write(dim(`    replaces: ${item.targetText}\n`));
          if (item.flaggedReason) process.stdout.write(dim(`    warning: ${item.flaggedReason}\n`));
        }
      }
      for (const block of ["profile", "notes"] as const) {
        const items = snap.active.filter((e) => e.block === block);
        process.stdout.write(`\n${bold(memoryBlockLabel(block))}\n`);
        if (items.length === 0) {
          process.stdout.write(dim("  (empty)\n"));
        } else {
          for (const item of items) {
            process.stdout.write(`  ${item.id.slice(0, 8)}  ${item.text}\n`);
            if (item.flaggedReason) {
              process.stdout.write(dim(`    [withheld from model: ${item.flaggedReason}]\n`));
            }
          }
        }
      }
      return 0;
    }
    case "add": {
      const [block, ...words] = subArgs;
      const text = words.join(" ").trim();
      if (!isMemoryBlock(block) || !text) {
        throw new CliError('Usage: staf memory add [--agent <id>] <notes|profile> "<text>"');
      }
      const created = await api.createMemory(agentId, { block, text });
      process.stdout.write(`Saved ${created.id.slice(0, 8)} in ${memoryBlockLabel(block)}.\n`);
      return 0;
    }
    case "edit": {
      const [idOrPrefix, ...words] = subArgs;
      const text = words.join(" ").trim();
      if (!idOrPrefix || !text) throw new CliError('Usage: staf memory edit <id> "<text>"');
      const id = await resolveMemoryId(api, agentId, idOrPrefix);
      await api.updateMemory(id, { text });
      process.stdout.write(`Updated ${id.slice(0, 8)}.\n`);
      return 0;
    }
    case "rm":
    case "remove":
    case "delete": {
      const idOrPrefix = subArgs[0];
      if (!idOrPrefix) throw new CliError("Usage: staf memory rm <id>");
      const id = await resolveMemoryId(api, agentId, idOrPrefix);
      await api.deleteMemory(id);
      process.stdout.write(`Removed ${id.slice(0, 8)}.\n`);
      return 0;
    }
    case "approve": {
      const [idOrPrefix, ...words] = subArgs;
      if (!idOrPrefix) throw new CliError('Usage: staf memory approve <id> ["<text>"]');
      const id = await resolveMemoryId(api, agentId, idOrPrefix);
      const edited = words.join(" ").trim();
      await api.approveMemory(id, edited ? { text: edited } : {});
      process.stdout.write(`Approved ${id.slice(0, 8)}.\n`);
      return 0;
    }
    case "reject": {
      const idOrPrefix = subArgs[0];
      if (!idOrPrefix) throw new CliError("Usage: staf memory reject <id>");
      const id = await resolveMemoryId(api, agentId, idOrPrefix);
      await api.rejectMemory(id);
      process.stdout.write(`Rejected ${id.slice(0, 8)}.\n`);
      return 0;
    }
    case "limits": {
      const patch = {
        ...(notesLimit !== undefined ? { notesLimit } : {}),
        ...(profileLimit !== undefined ? { profileLimit } : {}),
        ...(nudgeInterval !== undefined ? { nudgeInterval } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await api.updateAgent(agentId, { memory: patch });
      }
      const snap = await api.getAgentMemory(agentId);
      process.stdout.write(
        `Notes limit: ${snap.settings.notesLimit} chars\nProfile limit: ${snap.settings.profileLimit} chars\nReminder interval: ${snap.settings.nudgeInterval} messages\n`,
      );
      return 0;
    }
    default:
      throw new CliError(`Unknown memory subcommand "${sub}".\n\n${MEMORY_HELP}`);
  }
}

function parseIntFlag(flag: string, value: string | undefined): number {
  const n = Number(value);
  if (!value || !Number.isInteger(n)) throw new CliError(`${flag} requires a whole number.`);
  return n;
}

/** Resolves a full memory ID or unique short prefix (such as the 8-char ID printed by `staf memory list`). */
async function resolveMemoryId(api: StafClient, agentId: string, idOrPrefix: string): Promise<string> {
  if (idOrPrefix.length >= 32) return idOrPrefix;
  const snap = await api.getAgentMemory(agentId);
  const all = [...snap.active, ...snap.proposed];
  const matches = all.filter((entry) => entry.id === idOrPrefix || entry.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new CliError(`Multiple memories start with "${idOrPrefix}". Pass more characters.`);
  return idOrPrefix;
}
