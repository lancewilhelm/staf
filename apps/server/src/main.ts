#!/usr/bin/env bun
import { mkdirSync } from "node:fs";
import web from "../../web/index.html";
import { createApp } from "./app.ts";
import { apps, ask, chat, CliError, login, status, threads } from "./cli/commands.ts";
import { DEFAULT_HOST, resolvePaths, resolvePort, VERSION } from "./config.ts";

const HELP = `Staf ${VERSION}: a personal agent host

Usage:
  staf serve                 Run the host and the web app
  staf ask "question"        Ask one question and print the answer
                             --agent <id>     pick an agent
                             --harness <id>   use another harness: codex, claude, antigravity
                             --model <id>     use another model
                             --effort <level> reasoning level, such as low or high
                             --fast, --no-fast  turn fast mode on or off (it costs more)
                             --thread <id>    continue a conversation
  staf chat [thread-id]      Chat in the terminal (takes the same options, except --thread)
  staf threads               List conversations
  staf status                Show whether the host and harnesses are ready
  staf login codex           Sign Staf in to ChatGPT through Codex
  staf apps [--all]          List the ChatGPT apps that agents can be given

Environment:
  STAF_HOME      Data folder (default ~/.staf)
  STAF_PORT      Port for the host (default 4280)
  STAF_URL       Address that CLI commands use to reach the host
  STAF_HARNESS   Run every thread on one harness, for example "fake" for offline work
`;

async function serve(): Promise<number> {
  const paths = resolvePaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const app = createApp({
    paths,
    hostname: DEFAULT_HOST,
    port: resolvePort(),
    harnessOverride: process.env.STAF_HARNESS ?? null,
    web,
    development: process.env.NODE_ENV !== "production",
  });
  process.stdout.write(`Staf is running at ${app.url}\n`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    process.stdout.write("Stopping Staf…\n");
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise<number>(() => {});
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case "serve":
      return serve();
    case "ask":
      return ask(args);
    case "chat":
      return chat(args);
    case "threads":
      return threads();
    case "status":
      return status();
    case "login":
      return login(args);
    case "apps":
      return apps(args);
    case "version":
    case "--version":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof CliError || error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
