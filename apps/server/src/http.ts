import type { AgentSummary, HealthInfo, StreamEvent } from "@staf/protocol";
import type { HTMLBundle, Server } from "bun";
import {
  type Agent,
  AgentConfigError,
  type AgentEdit,
  AgentInputError,
  AgentNotFoundError,
  type Agents,
  DEFAULT_AGENT_ID,
} from "./agents.ts";
import type { EventBus } from "./bus.ts";
import { ChatError, type ChatService } from "./chat.ts";
import { VERSION } from "./config.ts";
import { CodexAdapter } from "./harness/codex/adapter.ts";
import type { HarnessAdapter } from "./harness/types.ts";

export interface HttpOptions {
  hostname: string;
  port: number;
  chat: ChatService;
  agents: Agents;
  bus: EventBus;
  harnesses: Map<string, HarnessAdapter>;
  /** The web app. Tests can leave it out. */
  web?: HTMLBundle;
  development?: boolean;
}

const PING_MS = 15_000;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function startHttp(options: HttpOptions): Server<undefined> {
  const { chat, bus } = options;

  const api = (handler: (req: Bun.BunRequest, server: Server<undefined>) => Response | Promise<Response>) =>
    async (req: Bun.BunRequest, server: Server<undefined>): Promise<Response> => {
      const rejected = checkRequest(req);
      if (rejected) return rejected;
      try {
        return await handler(req, server);
      } catch (error) {
        if (error instanceof ChatError) return json({ error: error.message }, error.status);
        if (error instanceof AgentNotFoundError) return json({ error: error.message }, 404);
        if (error instanceof AgentInputError || error instanceof AgentConfigError) {
          return json({ error: error.message }, 400);
        }
        if (error instanceof SyntaxError) return json({ error: "The request body is not valid JSON." }, 400);
        console.error(error);
        return json({ error: "Something went wrong in Staf." }, 500);
      }
    };

  const routes: Record<string, unknown> = {
    "/api/health": {
      GET: api(async () => {
        const harnesses = await Promise.all(
          [...options.harnesses.values()].map((harness) => harness.status()),
        );
        const body: HealthInfo = { version: VERSION, harnesses };
        return json(body);
      }),
    },
    "/api/agents": {
      GET: api(() => json(options.agents.list().map(summary))),
      POST: api(async (req) => {
        const edit = readAgentEdit(await readJson(req));
        if (edit.name === undefined || edit.harness === undefined) {
          throw new ChatError(400, "Give the agent a name and a harness.");
        }
        const agent = options.agents.create({
          name: edit.name,
          harness: edit.harness,
          model: edit.model ?? null,
          effort: edit.effort ?? null,
          fast: edit.fast ?? false,
          instructions: edit.instructions ?? "",
        });
        bus.publish({ type: "agents.changed" });
        return json(summary(agent), 201);
      }),
    },
    "/api/agents/:id": {
      GET: api((req) => {
        const agent = options.agents.get(req.params.id!);
        if (!agent) throw new AgentNotFoundError(req.params.id!);
        return json(summary(agent));
      }),
      PATCH: api(async (req) => {
        const agent = options.agents.update(req.params.id!, readAgentEdit(await readJson(req)));
        bus.publish({ type: "agents.changed" });
        return json(summary(agent));
      }),
      DELETE: api(async (req) => {
        const id = req.params.id!;
        if (id === DEFAULT_AGENT_ID) throw new ChatError(400, "The default agent cannot be deleted.");
        if (!options.agents.get(id)) throw new AgentNotFoundError(id);
        await chat.deleteThreadsOf(id);
        options.agents.remove(id);
        bus.publish({ type: "agents.changed" });
        return new Response(null, { status: 204 });
      }),
    },
    "/api/harnesses/:id/models": {
      GET: api(async (req) => {
        const harness = options.harnesses.get(req.params.id!);
        if (!harness) throw new ChatError(404, `Staf has no harness named "${req.params.id}".`);
        try {
          return json(await harness.listModels());
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new ChatError(502, `${harness.label} could not list its models. ${reason}`);
        }
      }),
    },
    "/api/harnesses/:id/login": {
      POST: api(async (req) => {
        const harness = options.harnesses.get(req.params.id!);
        if (!(harness instanceof CodexAdapter)) {
          throw new ChatError(400, "Only ChatGPT signs in through Staf. The other harnesses use this computer's sign-in.");
        }
        return json(await harness.startLogin());
      }),
    },
    "/api/threads": {
      GET: api(() => json(chat.listThreads())),
      POST: api(async (req) => {
        const body = await readJson(req);
        const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
        return json(chat.createThread(agentId, readChoice(body)), 201);
      }),
    },
    "/api/threads/:id": {
      GET: api((req) => json(chat.getThread(req.params.id!))),
      PATCH: api(async (req) => {
        return json(chat.updateThread(req.params.id!, readChoice(await readJson(req))));
      }),
      DELETE: api(async (req) => {
        await chat.deleteThread(req.params.id!);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/threads/:id/messages": {
      POST: api(async (req) => {
        const body = (await readJson(req)) as { text?: unknown };
        if (typeof body.text !== "string") throw new ChatError(400, "Send a text message.");
        return json(chat.send(req.params.id!, body.text), 201);
      }),
    },
    "/api/threads/:id/interrupt": {
      POST: api((req) => {
        chat.interrupt(req.params.id!);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/events": {
      GET: api((req, server) => eventStream(req, server, bus)),
    },
    "/api/*": api(() => json({ error: "There is no such API route." }, 404)),
  };
  if (options.web) routes["/*"] = options.web;

  function summary(agent: Agent): AgentSummary {
    return {
      id: agent.id,
      name: agent.name,
      harness: agent.harness,
      harnessLabel: options.harnesses.get(agent.harness)?.label ?? agent.harness,
      model: agent.model,
      effort: agent.effort,
      fast: agent.fast,
      instructions: agent.instructions,
      network: agent.access.network,
      writableFolders: agent.access.writableFolders,
      harnessApps: agent.access.harnessApps,
      isDefault: agent.id === DEFAULT_AGENT_ID,
    };
  }

  function readAgentEdit(body: Record<string, unknown>): AgentEdit {
    const edit: AgentEdit = {};
    if (body.name !== undefined) {
      if (typeof body.name !== "string") throw new ChatError(400, "The name must be text.");
      edit.name = body.name;
    }
    if (body.harness !== undefined) {
      if (typeof body.harness !== "string") throw new ChatError(400, "The harness must be text.");
      chat.checkHarness(body.harness, null);
      edit.harness = body.harness;
    }
    const model = readModel(body.model);
    if (model !== undefined) edit.model = model;
    const effort = readEffort(body.effort);
    if (effort !== undefined) edit.effort = effort;
    const fast = readFast(body.fast);
    if (fast !== undefined) edit.fast = fast;
    if (body.instructions !== undefined) {
      if (typeof body.instructions !== "string") throw new ChatError(400, "The instructions must be text.");
      edit.instructions = body.instructions;
    }
    return edit;
  }

  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    development: options.development ? { hmr: true, console: false } : false,
    routes: routes as never,
    fetch: () => new Response("Not found", { status: 404 }),
  });
}

/**
 * Rejects requests that could come from a web page on another site: a Host header
 * that is not local (DNS rebinding), and changes without Staf's client header (CSRF).
 */
function checkRequest(req: Request): Response | null {
  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "");
  if (!LOCAL_HOSTS.has(hostname)) {
    return json({ error: "Staf only accepts local connections." }, 403);
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !req.headers.has("x-staf-client")) {
    return json({ error: "Missing the x-staf-client header." }, 403);
  }
  return null;
}

function eventStream(req: Request, server: Server<undefined>, bus: EventBus): Response {
  server.timeout(req, 0);
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const send = (event: StreamEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
      const unsubscribe = bus.subscribe(send);
      const ping = setInterval(() => write(": ping\n\n"), PING_MS);
      cleanup = () => {
        unsubscribe();
        clearInterval(ping);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
      send({ type: "ready" });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/** Reads the harness, model, reasoning level, and fast mode that a conversation asks for. */
function readChoice(body: Record<string, unknown>): {
  harness?: string;
  model?: string | null;
  effort?: string | null;
  fast?: boolean;
} {
  if (body.harness !== undefined && typeof body.harness !== "string") {
    throw new ChatError(400, "The harness must be text.");
  }
  const choice: { harness?: string; model?: string | null; effort?: string | null; fast?: boolean } = {};
  if (typeof body.harness === "string") choice.harness = body.harness;
  const model = readModel(body.model);
  if (model !== undefined) choice.model = model;
  const effort = readEffort(body.effort);
  if (effort !== undefined) choice.effort = effort;
  const fast = readFast(body.fast);
  if (fast !== undefined) choice.fast = fast;
  return choice;
}

/** Reads an optional reasoning level, such as "high", or null for the model's default. */
function readEffort(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && /^[a-z]{1,16}$/.test(value)) return value;
  throw new ChatError(400, 'The reasoning level must be a word such as "high", or null.');
}

function readFast(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new ChatError(400, "Fast mode must be true or false.");
}

/** Reads an optional model field: a model ID, null for the harness's default, or undefined. */
function readModel(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ChatError(400, "The model must be a model ID or null.");
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text) return {};
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ChatError(400, "The request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
