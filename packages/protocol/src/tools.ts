/** Built-in Staf MCP tool capability IDs that can be enabled or restricted per agent. */
export type StafToolId = "attach_file" | "memory" | "conversation_search" | "scheduled_tasks";

export interface StafToolDefinition {
  id: StafToolId;
  name: string;
  description: string;
  /** The MCP tool names exposed on the Staf MCP server when this capability is enabled. */
  mcpTools: readonly string[];
  /** Whether new agents have this capability enabled by default. */
  defaultEnabled: boolean;
}

/** Catalog of built-in Staf tools that every harness receives through `staf mcp-bridge`. */
export const STAF_TOOL_CATALOG: readonly StafToolDefinition[] = [
  {
    id: "attach_file",
    name: "Attach files",
    description: "Attach generated PDFs, images, or other files from the agent's workspace directly to replies.",
    mcpTools: ["attach_file"],
    defaultEnabled: true,
  },
  {
    id: "memory",
    name: "Memory",
    description: "Read and update this agent's saved About you and Agent notes blocks across conversations.",
    mcpTools: ["memory"],
    defaultEnabled: true,
  },
  {
    id: "conversation_search",
    name: "Conversation search",
    description: "Search this agent's past conversations with full-text search to recall earlier details.",
    mcpTools: ["conversation_search"],
    defaultEnabled: true,
  },
  {
    id: "scheduled_tasks",
    name: "Scheduled tasks",
    description: "View, create, update, pause, or delete scheduled tasks that belong to this agent.",
    mcpTools: [
      "list_scheduled_tasks",
      "create_scheduled_task",
      "update_scheduled_task",
      "delete_scheduled_task",
    ],
    defaultEnabled: true,
  },
];

const TOOL_IDS = new Set<string>(STAF_TOOL_CATALOG.map((tool) => tool.id));
const MCP_NAME_TO_ID = new Map<string, StafToolId>(
  STAF_TOOL_CATALOG.flatMap((tool) => tool.mcpTools.map((mcpName) => [mcpName, tool.id] as const)),
);

export function isStafToolId(value: unknown): value is StafToolId {
  return typeof value === "string" && TOOL_IDS.has(value);
}

/** Resolves an agent's per-tool overrides against Staf's default tool catalog. */
export function resolveEnabledTools(
  overrides?: Partial<Record<StafToolId, boolean>>,
): Record<StafToolId, boolean> {
  const result = {} as Record<StafToolId, boolean>;
  for (const tool of STAF_TOOL_CATALOG) {
    result[tool.id] = overrides?.[tool.id] ?? tool.defaultEnabled;
  }
  return result;
}

/** Returns whether a specific MCP tool name is enabled given an agent's resolved tool map. */
export function isMcpToolEnabled(
  mcpToolName: string,
  tools: Partial<Record<StafToolId, boolean>>,
): boolean {
  const id = MCP_NAME_TO_ID.get(mcpToolName);
  if (!id) return false;
  const def = STAF_TOOL_CATALOG.find((t) => t.id === id)!;
  return tools[id] ?? def.defaultEnabled;
}
