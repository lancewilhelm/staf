import { mkdirSync } from "node:fs";
import type { HTMLBundle } from "bun";
import { Agents } from "./agents.ts";
import { EventBus } from "./bus.ts";
import { ChatService } from "./chat.ts";
import type { Paths } from "./config.ts";
import { CodexAdapter } from "./harness/codex/adapter.ts";
import { FakeHarness } from "./harness/fake.ts";
import type { HarnessAdapter } from "./harness/types.ts";
import { startHttp } from "./http.ts";
import { Store } from "./store.ts";

export interface AppOptions {
  paths: Paths;
  hostname: string;
  port: number;
  /** Run every thread on this harness instead of the agent's choice, such as "fake". */
  harnessOverride?: string | null;
  /** Replaces the default harnesses. Tests pass fakes here. */
  harnesses?: HarnessAdapter[];
  web?: HTMLBundle;
  development?: boolean;
}

export interface App {
  url: URL;
  chat: ChatService;
  store: Store;
  stop(): Promise<void>;
}

export function createApp(options: AppOptions): App {
  const { paths } = options;
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  mkdirSync(paths.agents, { recursive: true, mode: 0o700 });
  mkdirSync(paths.codexHome, { recursive: true, mode: 0o700 });

  const store = new Store(paths.db);
  store.recoverInterrupted();
  const agents = new Agents(paths.agents, paths.home);
  agents.ensureDefault();
  const bus = new EventBus();

  const list =
    options.harnesses ??
    [
      new CodexAdapter({ codexHome: paths.codexHome }),
      ...(options.harnessOverride === "fake" ? [new FakeHarness({ delayMs: 40 })] : []),
    ];
  const harnesses = new Map(list.map((harness) => [harness.id, harness]));
  const chat = new ChatService(store, agents, harnesses, bus, options.harnessOverride ?? null);

  const server = startHttp({
    hostname: options.hostname,
    port: options.port,
    chat,
    bus,
    harnesses,
    web: options.web,
    development: options.development,
  });

  return {
    url: server.url,
    chat,
    store,
    async stop() {
      await chat.stopAll();
      await server.stop(true);
      await Promise.all(list.map((harness) => harness.close()));
      store.close();
    },
  };
}
