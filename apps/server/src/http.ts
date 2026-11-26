import {
  isHeroFont,
  isMemoryBlock,
  isSidebarMode,
  isThemePreference,
  type AgentMemorySettings,
  type AgentSummary,
  type ApproveMemoryRequest,
  type CreateMemoryRequest,
  type CreateScheduledTaskRequest,
  type HealthInfo,
  type StreamEvent,
  type ThreadSource,
  type UpdateMemoryRequest,
  type UpdatePreferencesRequest,
  type UpdateScheduledTaskRequest,
  type UpdateThreadRequest,
} from "@staf/protocol";
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
import { contentDisposition, isInlineMime } from "./attachments.ts";
import type { EventBus } from "./bus.ts";
import { ChatError, type ChatService } from "./chat.ts";
import { VERSION } from "./config.ts";
import { CodexAdapter } from "./harness/codex/adapter.ts";
import type { HarnessAdapter } from "./harness/types.ts";
import { McpAuthError, type McpServer } from "./mcp/server.ts";
import type { MemoryBackend } from "./memory.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Store } from "./store.ts";

export interface HttpOptions {
  hostname: string;
  port: number;
  store: Store;
  chat: ChatService;
  scheduler: Scheduler;
  memory: MemoryBackend;
  agents: Agents;
  bus: EventBus;
  harnesses: Map<string, HarnessAdapter>;
  mcp?: McpServer;
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
    "/api/preferences": {
      GET: api(() => json(options.store.getPreferences())),
      PATCH: api(async (req) => {
        const patch = readPreferencesPatch(await readJson(req));
        const preferences = options.store.updatePreferences(patch);
        bus.publish({ type: "preferences.changed", preferences });
        return json(preferences);
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
          ...(edit.memory ? { memory: edit.memory } : {}),
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
        options.scheduler.deleteTasksForAgent(id);
        options.memory.deleteForAgent(id);
        options.agents.remove(id);
        bus.publish({ type: "agents.changed" });
        return new Response(null, { status: 204 });
      }),
    },
    "/api/agents/:id/memories": {
      GET: api((req) => json(options.memory.getSnapshot(req.params.id!))),
      POST: api(async (req) => {
        const input = readCreateMemory(await readJson(req));
        return json(options.memory.createActive(req.params.id!, input), 201);
      }),
    },
    "/api/memories/:id": {
      PATCH: api(async (req) => {
        const input = readUpdateMemory(await readJson(req));
        return json(options.memory.updateEntry(req.params.id!, input));
      }),
      DELETE: api((req) => {
        options.memory.deleteEntry(req.params.id!);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/memories/:id/approve": {
      POST: api(async (req) => {
        const input = readApproveMemory(await readJson(req));
        return json(options.memory.approveProposal(req.params.id!, input));
      }),
    },
    "/api/memories/:id/reject": {
      POST: api((req) => {
        options.memory.rejectProposal(req.params.id!);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/agents/:id/tasks": {
      GET: api((req) => json(options.scheduler.listTasks(req.params.id!))),
      POST: api(async (req) => {
        const input = readCreateTask(await readJson(req));
        return json(options.scheduler.createTask(req.params.id!, input), 201);
      }),
    },
    "/api/tasks/:id": {
      PATCH: api(async (req) => {
        const input = readUpdateTask(await readJson(req));
        return json(options.scheduler.updateTask(req.params.id!, input));
      }),
      DELETE: api((req) => {
        options.scheduler.deleteTask(req.params.id!);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/tasks/:id/run": {
      POST: api((req) => json(options.scheduler.runNow(req.params.id!), 201)),
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
        const source = readSource(body.source);
        return json(chat.createThread(agentId, { ...readChoice(body), ...(source ? { source } : {}) }), 201);
      }),
    },
    "/api/threads/:id": {
      GET: api((req) => json(chat.getThread(req.params.id!))),
      PATCH: api(async (req) => {
        return json(chat.updateThread(req.params.id!, readThreadPatch(await readJson(req))));
      }),
      DELETE: api(async (req) => {
        await chat.deleteThread(req.params.id!);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/threads/:id/messages": {
      POST: api(async (req) => {
        const body = await readJson(req);
        if (typeof body.text !== "string") throw new ChatError(400, "Send a text message.");
        const attachmentIds = readAttachmentIds(body.attachmentIds);
        return json(chat.send(req.params.id!, body.text, attachmentIds), 201);
      }),
    },
    "/api/threads/:id/attachments": {
      POST: api(async (req) => {
        const uploaded = await readUploadedFile(req);
        return json(chat.uploadAttachment(req.params.id!, uploaded), 201);
      }),
    },
    "/api/threads/:id/messages/:messageId/attachments": {
      POST: api(async (req) => {
        const uploaded = await readUploadedFile(req);
        return json(chat.attachToMessage(req.params.id!, req.params.messageId!, uploaded), 201);
      }),
    },
    "/api/attachments/:id": {
      GET: api((req) => {
        const { attachment, fullPath } = chat.getAttachmentFile(req.params.id!);
        const url = new URL(req.url);
        const forceDownload = url.searchParams.get("download") === "1";
        const inline = !forceDownload && isInlineMime(attachment.mimeType);
        const headers: Record<string, string> = {
          "content-type": attachment.mimeType,
          "content-disposition": contentDisposition(attachment.name, inline),
          "x-content-type-options": "nosniff",
          "cache-control": "private, max-age=31536000, immutable",
        };
        if (inline && attachment.mimeType !== "application/pdf") {
          headers["content-security-policy"] = "default-src 'none'";
        }
        return new Response(Bun.file(fullPath), { headers });
      }),
    },
    "/api/threads/:id/interrupt": {
      POST: api((req) => {
        chat.interrupt(req.params.id!);
        return new Response(null, { status: 204 });
      }),
    },
    "/api/mcp": {
      POST: api(async (req) => {
        if (!options.mcp) throw new ChatError(404, "The Staf MCP server is not enabled.");
        const auth = req.headers.get("authorization") ?? "";
        const match = /^Bearer\s+(.+)$/i.exec(auth);
        if (!match) return json({ error: "Missing Staf run token." }, 401);
        const body = await readJson(req);
        try {
          const reply = options.mcp.handleMessage(match[1]!.trim(), body);
          if (reply === null) return new Response(null, { status: 202 });
          return json(reply);
        } catch (error) {
          if (error instanceof McpAuthError) return json({ error: error.message }, 401);
          throw error;
        }
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
      memory: agent.memory,
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
    if (body.memory !== undefined) {
      edit.memory = readMemorySettingsPatch(body.memory);
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

function readCreateMemory(body: Record<string, unknown>): CreateMemoryRequest {
  if (!isMemoryBlock(body.block)) throw new ChatError(400, 'Choose either "notes" or "profile".');
  if (typeof body.text !== "string") throw new ChatError(400, "Memory text must be a string.");
  return { block: body.block, text: body.text };
}

function readUpdateMemory(body: Record<string, unknown>): UpdateMemoryRequest {
  const patch: UpdateMemoryRequest = {};
  if (body.block !== undefined) {
    if (!isMemoryBlock(body.block)) throw new ChatError(400, 'Block must be "notes" or "profile".');
    patch.block = body.block;
  }
  if (body.text !== undefined) {
    if (typeof body.text !== "string") throw new ChatError(400, "Memory text must be a string.");
    patch.text = body.text;
  }
  return patch;
}

function readApproveMemory(body: Record<string, unknown>): ApproveMemoryRequest {
  return readUpdateMemory(body);
}

function readMemorySettingsPatch(raw: unknown): Partial<AgentMemorySettings> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ChatError(400, "Memory settings must be an object.");
  }
  const value = raw as Record<string, unknown>;
  const patch: Partial<AgentMemorySettings> = {};
  if (value.notesLimit !== undefined) {
    if (typeof value.notesLimit !== "number") throw new ChatError(400, "notesLimit must be a number.");
    patch.notesLimit = value.notesLimit;
  }
  if (value.profileLimit !== undefined) {
    if (typeof value.profileLimit !== "number") throw new ChatError(400, "profileLimit must be a number.");
    patch.profileLimit = value.profileLimit;
  }
  if (value.nudgeInterval !== undefined) {
    if (typeof value.nudgeInterval !== "number") throw new ChatError(400, "nudgeInterval must be a number.");
    patch.nudgeInterval = value.nudgeInterval;
  }
  return patch;
}

function readCreateTask(body: Record<string, unknown>): CreateScheduledTaskRequest {
  if (typeof body.name !== "string") throw new ChatError(400, "Give the scheduled task a name.");
  if (typeof body.prompt !== "string") throw new ChatError(400, "Write a prompt for the scheduled task.");
  const patch = readUpdateTask(body);
  if (patch.schedule === undefined) throw new ChatError(400, "Include a schedule for the task.");
  return {
    name: body.name,
    prompt: body.prompt,
    schedule: patch.schedule,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.harness !== undefined ? { harness: patch.harness } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.fast !== undefined ? { fast: patch.fast } : {}),
  };
}

function readUpdateTask(body: Record<string, unknown>): UpdateScheduledTaskRequest {
  const patch: UpdateScheduledTaskRequest = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string") throw new ChatError(400, "The task name must be text.");
    patch.name = body.name;
  }
  if (body.prompt !== undefined) {
    if (typeof body.prompt !== "string") throw new ChatError(400, "The task prompt must be text.");
    patch.prompt = body.prompt;
  }
  if (body.schedule !== undefined) {
    patch.schedule = body.schedule as UpdateScheduledTaskRequest["schedule"];
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw new ChatError(400, "Enabled must be true or false.");
    patch.enabled = body.enabled;
  }
  if (body.harness !== undefined) {
    if (body.harness !== null && typeof body.harness !== "string") {
      throw new ChatError(400, "The harness must be text or null.");
    }
    patch.harness = body.harness;
  }
  const model = readModel(body.model);
  if (model !== undefined) patch.model = model;
  const effort = readEffort(body.effort);
  if (effort !== undefined) patch.effort = effort;
  const fast = readFast(body.fast);
  if (fast !== undefined) patch.fast = fast;
  return patch;
}

function readSource(value: unknown): ThreadSource | undefined {
  if (value === undefined) return undefined;
  if (value === "chat" || value === "schedule") return value;
  throw new ChatError(400, 'Thread source must be "chat" or "schedule".');
}

function readThreadPatch(body: Record<string, unknown>): UpdateThreadRequest {
  const patch: UpdateThreadRequest = readChoice(body);
  if (body.settled !== undefined) {
    if (typeof body.settled !== "boolean") throw new ChatError(400, "Settled must be true or false.");
    patch.settled = body.settled;
  }
  return patch;
}

function readAttachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new ChatError(400, "Attachment IDs must be an array of strings.");
  }
  return value as string[];
}

async function readUploadedFile(req: Request): Promise<{ name: string; mimeType: string | null; bytes: Uint8Array }> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("multipart/form-data")) {
    throw new ChatError(400, "Upload files as multipart/form-data.");
  }
  let file: unknown;
  try {
    const form = await req.formData();
    file = form.get("file");
  } catch {
    throw new ChatError(400, "Could not read the uploaded form data.");
  }
  if (!(file instanceof File)) {
    throw new ChatError(400, 'Include a file in the "file" form field.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name || "attachment", mimeType: file.type || null, bytes };
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

function readPreferencesPatch(body: Record<string, unknown>): UpdatePreferencesRequest {
  const patch: UpdatePreferencesRequest = {};
  if (body.theme !== undefined) {
    if (!isThemePreference(body.theme)) {
      throw new ChatError(400, 'Theme must be "system", "light", or "dark".');
    }
    patch.theme = body.theme;
  }
  if (body.heroFont !== undefined) {
    if (!isHeroFont(body.heroFont)) {
      throw new ChatError(400, "Unknown heading font.");
    }
    patch.heroFont = body.heroFont;
  }
  if (body.sidebarMode !== undefined) {
    if (!isSidebarMode(body.sidebarMode)) {
      throw new ChatError(400, 'Sidebar mode must be "inbox" or "list".');
    }
    patch.sidebarMode = body.sidebarMode;
  }
  return patch;
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
