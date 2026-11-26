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

export interface HarnessToolCapability {
  id: string;
  name: string;
  description: string;
  /** Exact built-in tool or app names exposed by this harness, when applicable. */
  names?: readonly string[];
  status: "enabled" | "limited" | "off";
  statusLabel: string;
}

export interface HarnessToolsSummary {
  harness: string;
  harnessLabel: string;
  capabilities: HarnessToolCapability[];
  disabledNote: string;
}

/**
 * Describes the built-in tools that an agent's selected harness exposes under Staf's
 * sandbox and access settings.
 */
export function harnessToolsForAgent(agent: {
  harness: string;
  harnessLabel: string;
  network: boolean;
  writableFolders: string[];
  harnessApps: string[];
}): HarnessToolsSummary {
  const extraFolders = agent.writableFolders.length;
  const folderNote =
    extraFolders > 0
      ? `Workspace plus ${extraFolders} extra writable folder${extraFolders === 1 ? "" : "s"}.`
      : "Confined to this agent's workspace folder.";

  switch (agent.harness) {
    case "codex":
      return {
        harness: agent.harness,
        harnessLabel: agent.harnessLabel,
        capabilities: [
          {
            id: "web_search",
            name: "Web search",
            description: "Live web search and page reading built into Codex.",
            names: ["web_search"],
            status: "enabled",
            statusLabel: "On",
          },
          {
            id: "shell",
            name: "Shell commands",
            description: agent.network
              ? "Runs sandboxed commands inside the workspace with internet access."
              : "Runs sandboxed commands inside the workspace with no internet access.",
            names: ["shell"],
            status: agent.network ? "enabled" : "limited",
            statusLabel: agent.network ? "Internet on" : "Offline only",
          },
          {
            id: "files",
            name: "Workspace files",
            description: `Reads and edits files. ${folderNote}`,
            status: "enabled",
            statusLabel: "On",
          },
          {
            id: "apps",
            name: "ChatGPT account apps",
            description:
              agent.harnessApps.length > 0
                ? "Allowed connectors from Staf's ChatGPT account (non-destructive actions only)."
                : "Account connectors (such as Gmail or Expedia) are turned off unless listed in agent.json.",
            ...(agent.harnessApps.length > 0 ? { names: agent.harnessApps } : {}),
            status: agent.harnessApps.length > 0 ? "limited" : "off",
            statusLabel: agent.harnessApps.length > 0 ? "Read-only" : "Off",
          },
        ],
        disabledNote: "Off in Staf: Codex memory, browser use, computer use, and Codex plugins.",
      };

    case "claude":
      return {
        harness: agent.harness,
        harnessLabel: agent.harnessLabel,
        capabilities: [
          {
            id: "web",
            name: "Web search & fetch",
            description: "Searches the web and fetches web pages.",
            names: ["WebSearch", "WebFetch"],
            status: "enabled",
            statusLabel: "On",
          },
          {
            id: "shell",
            name: "Shell commands",
            description: agent.network
              ? "Runs sandboxed Bash commands with internet access."
              : "Runs sandboxed Bash commands with no internet access.",
            names: ["Bash"],
            status: agent.network ? "enabled" : "limited",
            statusLabel: agent.network ? "Internet on" : "Offline only",
          },
          {
            id: "files",
            name: "Workspace files",
            description: `Reads, creates, and edits files. ${folderNote}`,
            names: ["Read", "Edit", "Write"],
            status: "enabled",
            statusLabel: "On",
          },
          {
            id: "skills",
            name: "Skills",
            description: "Loads skills placed in this agent's workspace.",
            names: ["Skill"],
            status: "enabled",
            statusLabel: "On",
          },
        ],
        disabledNote:
          "Off in Staf: Claude auto-memory, personal CLAUDE.md, hooks, plugins, Chrome, personal MCP servers, and cloud tools.",
      };

    case "antigravity":
      return {
        harness: agent.harness,
        harnessLabel: agent.harnessLabel,
        capabilities: [
          {
            id: "web",
            name: "Web search & fetch",
            description: "Built-in web search and page reading.",
            status: "enabled",
            statusLabel: "On",
          },
          {
            id: "shell",
            name: "Shell commands",
            description: "Runs commands inside Antigravity's sandbox. Commands cannot reach the internet.",
            status: "limited",
            statusLabel: "Offline only",
          },
          {
            id: "files",
            name: "Workspace files",
            description:
              extraFolders > 0
                ? "Writes stay inside the workspace; extra writable folders in agent.json are read-only on Antigravity."
                : "Reads and edits files inside this agent's workspace folder.",
            status: extraFolders > 0 ? "limited" : "enabled",
            statusLabel: extraFolders > 0 ? "Workspace only" : "On",
          },
        ],
        disabledNote: "Off in Staf: sandbox bypass and personal GEMINI.md, hooks, or skills.",
      };

    default:
      return {
        harness: agent.harness,
        harnessLabel: agent.harnessLabel,
        capabilities: [],
        disabledNote: `Built-in tools are controlled by the ${agent.harnessLabel} harness.`,
      };
  }
}
