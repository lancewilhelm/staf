import type { HealthInfo, StreamEvent } from "@staf/protocol";
import type { HTMLBundle, Server } from "bun";
import type { EventBus } from "./bus.ts";
import { ChatError, type ChatService } from "./chat.ts";
import { VERSION } from "./config.ts";
import type { HarnessAdapter } from "./harness/types.ts";

export interface HttpOptions {
  hostname: string;
  port: number;
  chat: ChatService;
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
    "/api/threads": {
      GET: api(() => json(chat.listThreads())),
      POST: api(async (req) => {
        const body = (await readJson(req)) as { agentId?: unknown };
        const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
        return json(chat.createThread(agentId), 201);
      }),
    },
    "/api/threads/:id": {
      GET: api((req) => json(chat.getThread(req.params.id!))),
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
