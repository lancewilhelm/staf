import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import {
  formatScheduleSummary,
  type CreateScheduledTaskRequest,
  type ScheduledTask,
  type TaskSchedule,
  type UpdateScheduledTaskRequest,
} from "@staf/protocol";
import type { Agents } from "../agents.ts";
import { MAX_ATTACHMENT_BYTES } from "../attachments.ts";
import { ChatError, type ChatService } from "../chat.ts";
import { VERSION } from "../config.ts";
import type { Scheduler } from "../scheduler.ts";
import type { Store } from "../store.ts";
import type { RunContext, RunTokenStore } from "./tokens.ts";

const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const SCHEDULE_SCHEMA = {
  oneOf: [
    {
      type: "object",
      required: ["type", "timeOfDay"],
      properties: {
        type: { const: "daily" },
        timeOfDay: {
          type: "string",
          description: '24-hour local time in HH:MM format, such as "05:30" or "18:00".',
        },
        weekdays: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 6 },
          description: "Optional list of weekdays (0 = Sunday through 6 = Saturday). Omit for every day.",
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "everyMinutes"],
      properties: {
        type: { const: "interval" },
        everyMinutes: {
          type: "integer",
          minimum: 5,
          maximum: 10080,
          description: "Minutes between runs (5 to 10080).",
        },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["type", "runAt"],
      properties: {
        type: { const: "once" },
        runAt: {
          description: 'When to run once, either an ISO-8601 date-time string (such as "2026-11-27T08:00:00-05:00") or a Unix timestamp in milliseconds.',
        },
      },
      additionalProperties: false,
    },
  ],
};

export const STAF_TOOLS: McpToolDefinition[] = [
  {
    name: "attach_file",
    description:
      "Attach a file from your workspace directly to your current reply so the person can preview or download it in Staf (for example, a generated PDF, image, CSV, or report).",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Path to the file inside your workspace (relative to your workspace root, or an absolute path inside it).",
        },
        name: {
          type: "string",
          description: "Optional display filename shown to the person. Defaults to the file's basename.",
        },
        mimeType: {
          type: "string",
          description: "Optional MIME type, such as application/pdf or image/png. Inferred from the filename if omitted.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_scheduled_tasks",
    description: "List all scheduled tasks that belong to this agent, including their schedules, status, and last run outcome.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_scheduled_task",
    description:
      "Create a new scheduled task for this agent. Scheduled tasks run on Codex or Claude (never Antigravity) and keep fast mode off by default.",
    inputSchema: {
      type: "object",
      required: ["name", "prompt", "schedule"],
      properties: {
        name: { type: "string", description: "Short name for the task (up to 80 characters)." },
        prompt: { type: "string", description: "The prompt that runs each time the task fires." },
        schedule: SCHEDULE_SCHEMA,
        enabled: { type: "boolean", description: "Whether the task starts enabled. Defaults to true." },
        harness: {
          type: ["string", "null"],
          enum: ["codex", "claude", null],
          description: 'Optional provider override ("codex" or "claude"). Omit or pass null to use this agent\'s default harness.',
        },
        model: { type: ["string", "null"], description: "Optional model ID override, or null for the default." },
        effort: { type: ["string", "null"], description: "Optional reasoning level override, such as low or high." },
        fast: { type: "boolean", description: "Whether to use fast mode (costs more). Defaults to false." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_scheduled_task",
    description: "Update one of this agent's scheduled tasks, such as changing its schedule, prompt, or pausing and resuming it.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string", description: "The ID of the scheduled task to update." },
        name: { type: "string", description: "New short name for the task." },
        prompt: { type: "string", description: "New prompt for the task." },
        schedule: SCHEDULE_SCHEMA,
        enabled: { type: "boolean", description: "Set false to pause the task or true to resume it." },
        harness: {
          type: ["string", "null"],
          enum: ["codex", "claude", null],
          description: 'Optional provider override ("codex" or "claude"), or null to use the agent\'s default.',
        },
        model: { type: ["string", "null"], description: "Optional model ID override, or null for the default." },
        effort: { type: ["string", "null"], description: "Optional reasoning level override, or null for the default." },
        fast: { type: "boolean", description: "Whether to use fast mode." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "delete_scheduled_task",
    description: "Delete one of this agent's scheduled tasks by ID.",
    inputSchema: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string", description: "The ID of the scheduled task to delete." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "conversation_search",
    description:
      "Search this agent's past conversations using full-text search to recall earlier discussions, facts, or decisions.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Keywords or quoted phrases to search for." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "Maximum number of matching messages to return. Defaults to 10.",
        },
        excludeCurrentThread: {
          type: "boolean",
          description: "Set true to skip matches from the current thread. Defaults to false.",
        },
      },
      additionalProperties: false,
    },
  },
];

export interface McpServerDeps {
  tokens: RunTokenStore;
  store: Store;
  agents: Agents;
  chat: ChatService;
  scheduler: Scheduler;
}

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpAuthError";
  }
}

class ToolInputError extends Error {}

export class McpServer {
  constructor(private readonly deps: McpServerDeps) {}

  /**
   * Handles one MCP JSON-RPC 2.0 message authenticated by a run token.
   * Returns `null` for notifications (which expect no JSON-RPC response),
   * or throws `McpAuthError` when the token is missing, revoked, or has no active run.
   */
  handleMessage(token: string, raw: unknown): JsonRpcResponse | null {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return rpcError(null, -32600, "Invalid JSON-RPC request.");
    }
    const req = raw as JsonRpcRequest;
    const isNotification = req.id === undefined;
    const id = req.id ?? null;

    if (typeof req.method !== "string" || !req.method) {
      return isNotification ? null : rpcError(id, -32600, "Missing JSON-RPC method.");
    }

    const binding = this.deps.tokens.verifyHandshake(token);
    if (!binding) {
      throw new McpAuthError("Invalid or revoked Staf run token.");
    }

    if (req.method.startsWith("notifications/")) {
      return null;
    }

    switch (req.method) {
      case "initialize": {
        const requested = typeof req.params?.protocolVersion === "string" ? req.params.protocolVersion : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
        return rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "staf", version: VERSION },
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: STAF_TOOLS });
      case "tools/call": {
        const run = this.deps.tokens.verifyActiveRun(token);
        if (!run) {
          throw new McpAuthError("This Staf run is no longer active.");
        }
        return this.handleToolCall(id, run, req.params);
      }
      default:
        return isNotification ? null : rpcError(id, -32601, `Method not found: ${req.method}`);
    }
  }

  private handleToolCall(
    id: string | number | null,
    run: RunContext,
    params: Record<string, unknown> | undefined,
  ): JsonRpcResponse {
    const name = typeof params?.name === "string" ? params.name : "";
    const args =
      typeof params?.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};

    try {
      switch (name) {
        case "attach_file":
          return rpcResult(id, toolSuccess(this.attachFile(run, args)));
        case "list_scheduled_tasks":
          return rpcResult(id, toolSuccess(this.listScheduledTasks(run)));
        case "create_scheduled_task":
          return rpcResult(id, toolSuccess(this.createScheduledTask(run, args)));
        case "update_scheduled_task":
          return rpcResult(id, toolSuccess(this.updateScheduledTask(run, args)));
        case "delete_scheduled_task":
          return rpcResult(id, toolSuccess(this.deleteScheduledTask(run, args)));
        case "conversation_search":
          return rpcResult(id, toolSuccess(this.conversationSearch(run, args)));
        default:
          return rpcError(id, -32602, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof ToolInputError || error instanceof ChatError) {
        return rpcResult(id, toolFailure(error.message));
      }
      const message = error instanceof Error ? error.message : String(error);
      return rpcResult(id, toolFailure(message));
    }
  }

  private attachFile(run: RunContext, args: Record<string, unknown>): Record<string, unknown> {
    const rawPath = requireString(args.path, "Provide a file path inside your workspace.");
    const customName = optionalString(args.name, "name");
    const customMime = optionalString(args.mimeType, "mimeType");

    const agent = this.deps.agents.get(run.agentId);
    if (!agent) throw new ToolInputError(`The agent "${run.agentId}" no longer exists.`);

    const workspaceReal = realpathSync(agent.workspace);
    const candidate = resolve(workspaceReal, rawPath);
    if (!existsSync(candidate)) {
      throw new ToolInputError(`The file "${rawPath}" does not exist in your workspace.`);
    }
    const targetReal = realpathSync(candidate);
    if (targetReal !== workspaceReal && !targetReal.startsWith(workspaceReal + sep)) {
      throw new ToolInputError("You can only attach files that live inside your workspace.");
    }
    const stat = statSync(targetReal);
    if (!stat.isFile()) {
      throw new ToolInputError(`"${rawPath}" is not a regular file.`);
    }
    if (stat.size === 0) {
      throw new ToolInputError("The file is empty.");
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new ToolInputError("Attachments must be 25 MB or smaller.");
    }

    const bytes = new Uint8Array(readFileSync(targetReal));
    const attachment = this.deps.chat.attachToMessage(run.threadId, run.messageId, {
      name: customName ?? basename(targetReal),
      mimeType: customMime ?? null,
      bytes,
    });
    return {
      attached: true,
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    };
  }

  private listScheduledTasks(run: RunContext): Record<string, unknown> {
    const tasks = this.deps.scheduler.listTasks(run.agentId);
    return {
      tasks: tasks.map(formatTaskForTool),
    };
  }

  private createScheduledTask(run: RunContext, args: Record<string, unknown>): Record<string, unknown> {
    const name = requireString(args.name, "Give the scheduled task a name.");
    const prompt = requireString(args.prompt, "Write a prompt for the scheduled task.");
    if (args.schedule === undefined) {
      throw new ToolInputError("Include a schedule for the task.");
    }
    const schedule = parseToolSchedule(args.schedule);
    const enabled = optionalBoolean(args.enabled, "enabled");
    const harness = optionalNullableString(args.harness, "harness");
    const model = optionalNullableString(args.model, "model");
    const effort = optionalEffort(args.effort);
    const fast = optionalBoolean(args.fast, "fast");

    const input: CreateScheduledTaskRequest = {
      name,
      prompt,
      schedule,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(harness !== undefined ? { harness } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fast !== undefined ? { fast } : {}),
    };
    const task = this.deps.scheduler.createTask(run.agentId, input);
    return { task: formatTaskForTool(task) };
  }

  private updateScheduledTask(run: RunContext, args: Record<string, unknown>): Record<string, unknown> {
    const taskId = requireString(args.taskId, "Provide the taskId of the scheduled task to update.");
    const existing = this.deps.store.getScheduledTask(taskId);
    if (!existing || existing.agentId !== run.agentId) {
      throw new ToolInputError("That scheduled task does not exist for this agent.");
    }

    const patch: UpdateScheduledTaskRequest = {};
    if (args.name !== undefined) patch.name = requireString(args.name, "The task name must be non-empty text.");
    if (args.prompt !== undefined) patch.prompt = requireString(args.prompt, "The task prompt must be non-empty text.");
    if (args.schedule !== undefined) patch.schedule = parseToolSchedule(args.schedule);
    const enabled = optionalBoolean(args.enabled, "enabled");
    if (enabled !== undefined) patch.enabled = enabled;
    const harness = optionalNullableString(args.harness, "harness");
    if (harness !== undefined) patch.harness = harness;
    const model = optionalNullableString(args.model, "model");
    if (model !== undefined) patch.model = model;
    const effort = optionalEffort(args.effort);
    if (effort !== undefined) patch.effort = effort;
    const fast = optionalBoolean(args.fast, "fast");
    if (fast !== undefined) patch.fast = fast;

    const updated = this.deps.scheduler.updateTask(taskId, patch);
    return { task: formatTaskForTool(updated) };
  }

  private deleteScheduledTask(run: RunContext, args: Record<string, unknown>): Record<string, unknown> {
    const taskId = requireString(args.taskId, "Provide the taskId of the scheduled task to delete.");
    const existing = this.deps.store.getScheduledTask(taskId);
    if (!existing || existing.agentId !== run.agentId) {
      throw new ToolInputError("That scheduled task does not exist for this agent.");
    }
    this.deps.scheduler.deleteTask(taskId);
    return { deleted: true, taskId };
  }

  private conversationSearch(run: RunContext, args: Record<string, unknown>): Record<string, unknown> {
    const query = requireString(args.query, "Provide a search query.");
    let limit = 10;
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 25) {
        throw new ToolInputError("limit must be an integer between 1 and 25.");
      }
      limit = args.limit;
    }
    const excludeCurrentThread = optionalBoolean(args.excludeCurrentThread, "excludeCurrentThread") ?? false;
    const results = this.deps.store.searchMessages(run.agentId, query, {
      limit,
      ...(excludeCurrentThread ? { excludeThreadId: run.threadId } : {}),
    });
    return {
      query,
      count: results.length,
      results: results.map((hit) => ({
        threadId: hit.threadId,
        threadTitle: hit.threadTitle,
        threadSource: hit.threadSource,
        messageId: hit.messageId,
        role: hit.role,
        createdAt: hit.createdAt,
        createdAtIso: new Date(hit.createdAt).toISOString(),
        snippet: hit.snippet,
      })),
    };
  }
}

function formatTaskForTool(task: ScheduledTask): Record<string, unknown> {
  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    schedule: task.schedule,
    scheduleSummary: formatScheduleSummary(task.schedule),
    enabled: task.enabled,
    harness: task.harness,
    model: task.model,
    effort: task.effort,
    fast: task.fast,
    nextRunAt: task.nextRunAt,
    nextRunAtIso: task.nextRunAt ? new Date(task.nextRunAt).toISOString() : null,
    lastRunAt: task.lastRunAt,
    lastRunAtIso: task.lastRunAt ? new Date(task.lastRunAt).toISOString() : null,
    lastRunStatus: task.lastRunStatus,
    lastRunError: task.lastRunError,
  };
}

/** Accepts ISO-8601 strings as well as Unix timestamps for `once.runAt`. */
function parseToolSchedule(raw: unknown): TaskSchedule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ToolInputError("The schedule must be an object.");
  }
  const data = raw as Record<string, unknown>;
  if (data.type === "once" && typeof data.runAt === "string") {
    const parsed = Date.parse(data.runAt);
    if (!Number.isFinite(parsed)) {
      throw new ToolInputError(`"${data.runAt}" is not a valid date and time.`);
    }
    return { type: "once", runAt: parsed };
  }
  return data as unknown as TaskSchedule;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ToolInputError(message);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalNullableString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ToolInputError(`${field} must be a non-empty string or null.`);
}

function optionalEffort(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" && /^[a-z]{1,16}$/.test(value)) return value;
  throw new ToolInputError('effort must be a word such as "low" or "high", or null.');
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new ToolInputError(`${field} must be true or false.`);
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolSuccess(data: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
