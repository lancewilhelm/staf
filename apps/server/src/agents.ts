import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  DEFAULT_MEMORY_SETTINGS,
  isStafToolId,
  MAX_MEMORY_LIMIT,
  MAX_NUDGE_INTERVAL,
  MIN_MEMORY_LIMIT,
  resolveEnabledTools,
  STAF_TOOL_CATALOG,
  type AgentMemorySettings,
  type StafToolId,
} from "@staf/protocol";

export const DEFAULT_AGENT_ID = "default";

/** Settings stored in an agent's agent.json. See docs/agents.md. */
export interface AgentSettings {
  name: string;
  /** Harness that runs this agent, such as "codex". */
  harness: string;
  /** Model to request, or null to use the harness default. */
  model: string | null;
  /** Reasoning level to request, such as "high", or null for the model's default. */
  effort: string | null;
  /** Whether to use the harness's fast mode, which costs more. */
  fast: boolean;
  /** Whether commands that the agent runs may use the network. Web search works either way. */
  network: boolean;
  /**
   * Apps that come with the harness account, such as ChatGPT's Expedia connector, by name
   * or ID. Empty means none. Run `staf apps` to list them.
   */
  harnessApps: string[];
  /** Extra folders that the agent may write to, besides its workspace. */
  writableFolders: string[];
  /** Per-agent memory limits and reminder interval. */
  memory: AgentMemorySettings;
  /** Per-agent overrides for built-in Staf MCP tools (omitted entries use Staf's default). */
  tools: Partial<Record<StafToolId, boolean>>;
}

/** What an agent may reach while it runs. Adapters turn this into harness settings. */
export interface AgentAccess {
  network: boolean;
  harnessApps: string[];
  /** Absolute paths. */
  writableFolders: string[];
}

export interface Agent {
  id: string;
  name: string;
  harness: string;
  model: string | null;
  effort: string | null;
  fast: boolean;
  memory: AgentMemorySettings;
  /** Resolved map of which built-in Staf MCP tools are enabled for this agent. */
  tools: Record<StafToolId, boolean>;
  access: AgentAccess;
  /** The agent's folder, which holds its settings and instructions. The agent cannot write here. */
  dir: string;
  /** The agent's working folder. Harness runs start here and may write here. */
  workspace: string;
  /** The contents of AGENTS.md. */
  instructions: string;
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`There is no agent named "${agentId}".`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentConfigError extends Error {
  constructor(agentId: string, problem: string) {
    super(`The settings for agent "${agentId}" have a problem: ${problem}`);
    this.name = "AgentConfigError";
  }
}

export const DEFAULT_SETTINGS: AgentSettings = {
  name: "Staf",
  harness: "codex",
  model: null,
  effort: null,
  fast: false,
  network: true,
  harnessApps: [],
  writableFolders: [],
  memory: { ...DEFAULT_MEMORY_SETTINGS },
  tools: {},
};

const DEFAULT_INSTRUCTIONS = `# Staf

You are Staf, a personal assistant for a household.

- Answer the question first, in plain language. Add detail only when it helps.
- When you use the web, check that sources are current and link them inline.
- Your working folder is your workspace. You can keep notes, scripts, and files there.
`;

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAME_LENGTH = 60;
const INSTRUCTIONS_LENGTH = 50_000;

/** The fields that the web app and the API can change. Access settings stay in agent.json. */
export interface AgentEdit {
  name?: string;
  harness?: string;
  model?: string | null;
  effort?: string | null;
  fast?: boolean;
  instructions?: string;
  memory?: Partial<AgentMemorySettings>;
  tools?: Partial<Record<StafToolId, boolean>>;
}

export class Agents {
  /**
   * @param root The folder that holds one folder per agent.
   * @param stafHome Staf's data folder. Agents may not write to it or above it.
   */
  constructor(
    private readonly root: string,
    private readonly stafHome: string,
  ) {}

  /** Creates the default agent on first run, and the workspace of an older agent folder. */
  ensureDefault(): Agent {
    const dir = join(this.root, DEFAULT_AGENT_ID);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const settingsPath = join(dir, "agent.json");
    if (!existsSync(settingsPath)) {
      writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    }
    const instructionsPath = join(dir, "AGENTS.md");
    if (!existsSync(instructionsPath)) writeFileSync(instructionsPath, DEFAULT_INSTRUCTIONS);
    return this.get(DEFAULT_AGENT_ID)!;
  }

  /** Lists every agent folder, with the agents whose settings have a problem left out. */
  list(): Agent[] {
    if (!existsSync(this.root)) return [];
    const agents: Agent[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const agent = this.get(entry.name);
        if (agent) agents.push(agent);
      } catch (error) {
        if (!(error instanceof AgentConfigError)) throw error;
      }
    }
    return agents.sort((a, b) =>
      a.id === DEFAULT_AGENT_ID ? -1 : b.id === DEFAULT_AGENT_ID ? 1 : a.name.localeCompare(b.name),
    );
  }

  /**
   * Loads an agent. Returns null if it does not exist, and throws AgentConfigError if its
   * settings are not valid.
   */
  get(id: string): Agent | null {
    if (!AGENT_ID.test(id)) return null;
    const dir = join(this.root, id);
    const settingsPath = join(dir, "agent.json");
    if (!existsSync(settingsPath)) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      throw new AgentConfigError(id, "agent.json is not valid JSON.");
    }
    const settings = parseSettings(id, raw);
    const writableFolders = settings.writableFolders.map((folder) =>
      this.checkFolder(id, folder),
    );

    const workspace = join(dir, "workspace");
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const instructionsPath = join(dir, "AGENTS.md");
    const instructions = existsSync(instructionsPath) ? readFileSync(instructionsPath, "utf8") : "";

    return {
      id,
      name: settings.name,
      harness: settings.harness,
      model: settings.model,
      effort: settings.effort,
      fast: settings.fast,
      memory: settings.memory,
      tools: resolveEnabledTools(settings.tools),
      access: {
        network: settings.network,
        harnessApps: settings.harnessApps,
        writableFolders,
      },
      dir,
      workspace,
      instructions,
    };
  }

  /** Creates an agent folder with default access settings, and returns the new agent. */
  create(
    input: Omit<Required<AgentEdit>, "memory" | "tools"> & {
      memory?: Partial<AgentMemorySettings>;
      tools?: Partial<Record<StafToolId, boolean>>;
    },
  ): Agent {
    const name = checkName(input.name);
    checkInstructions(input.instructions);
    const base = slug(name);
    let id = base;
    for (let n = 2; existsSync(join(this.root, id)); n++) id = `${base}-${n}`.slice(0, 63);
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const memory = normalizeMemoryEdit(DEFAULT_MEMORY_SETTINGS, input.memory);
    const tools = normalizeToolsEdit({}, input.tools);
    const settings: AgentSettings = {
      ...DEFAULT_SETTINGS,
      name,
      harness: input.harness,
      model: input.model,
      effort: input.effort,
      fast: input.fast,
      memory,
      tools,
    };
    writeFileSync(join(dir, "agent.json"), JSON.stringify(settings, null, 2) + "\n");
    writeFileSync(join(dir, "AGENTS.md"), input.instructions);
    return this.get(id)!;
  }

  /**
   * Changes an agent's name, harness, model, reasoning level, fast mode, instructions, memory limits, or tool toggles.
   * Other fields in agent.json, including ones that Staf does not know, are kept as they are.
   */
  update(id: string, edit: AgentEdit): Agent {
    const current = this.get(id);
    if (!current) throw new AgentNotFoundError(id);
    const settingsPath = join(current.dir, "agent.json");
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (edit.name !== undefined) raw.name = checkName(edit.name);
    if (edit.harness !== undefined) raw.harness = edit.harness;
    if (edit.model !== undefined) raw.model = edit.model;
    if (edit.effort !== undefined) raw.effort = edit.effort;
    if (edit.fast !== undefined) raw.fast = edit.fast;
    if (edit.memory !== undefined) {
      raw.memory = normalizeMemoryEdit(current.memory, edit.memory);
    }
    if (edit.tools !== undefined) {
      const merged = normalizeToolsEdit(current.tools, edit.tools);
      if (Object.keys(merged).length > 0) raw.tools = merged;
      else delete raw.tools;
    }
    parseSettings(id, raw);
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2) + "\n");
    if (edit.instructions !== undefined) {
      checkInstructions(edit.instructions);
      writeFileSync(join(current.dir, "AGENTS.md"), edit.instructions);
    }
    return this.get(id)!;
  }

  /**
   * Moves an agent's folder, with its workspace, to Staf's trash folder. The default agent
   * cannot be removed.
   */
  remove(id: string): string {
    if (id === DEFAULT_AGENT_ID) throw new AgentConfigError(id, "the default agent cannot be deleted.");
    if (!AGENT_ID.test(id) || !existsSync(join(this.root, id, "agent.json"))) throw new AgentNotFoundError(id);
    const trash = join(this.stafHome, "trash", "agents");
    mkdirSync(trash, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(trash, `${id}-${stamp}`);
    renameSync(join(this.root, id), target);
    return target;
  }

  /** Expands `~`, and refuses folders that would let the agent change Staf's own data. */
  private checkFolder(id: string, folder: string): string {
    const expanded = folder === "~" ? homedir() : folder.replace(/^~(?=\/)/, homedir());
    if (!isAbsolute(expanded)) {
      throw new AgentConfigError(id, `writableFolders must be absolute paths, not "${folder}".`);
    }
    const path = resolve(expanded);
    const home = resolve(this.stafHome);
    if (path === home || home.startsWith(path + sep) || path.startsWith(home + sep)) {
      throw new AgentConfigError(id, `"${folder}" overlaps Staf's data folder, ${home}.`);
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new AgentConfigError(id, `"${folder}" is not an existing folder.`);
    }
    return path;
  }
}

function checkName(name: string): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  if (!trimmed) throw new AgentInputError("Give the agent a name.");
  if (trimmed.length > NAME_LENGTH) throw new AgentInputError(`Keep the name under ${NAME_LENGTH} characters.`);
  return trimmed;
}

function checkInstructions(text: string): void {
  if (text.length > INSTRUCTIONS_LENGTH) {
    throw new AgentInputError(`Keep the instructions under ${INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`);
  }
}

/** A problem with values that a person entered for an agent. */
export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentInputError";
  }
}

/** Turns a name into a folder name such as "morning-paper". */
export function slug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return base || "agent";
}

function parseSettings(id: string, raw: unknown): AgentSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentConfigError(id, "agent.json must contain a JSON object.");
  }
  const value = raw as Record<string, unknown>;
  const field = <T>(key: keyof AgentSettings, check: (v: unknown) => v is T, expected: string): T => {
    const v = value[key];
    if (v === undefined) return DEFAULT_SETTINGS[key] as T;
    if (!check(v)) throw new AgentConfigError(id, `"${key}" must be ${expected}.`);
    return v;
  };
  const isString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  const isNullableString = (v: unknown): v is string | null => v === null || isString(v);
  const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
  const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

  return {
    name: field("name", isString, "a non-empty string"),
    harness: field("harness", isString, "a harness name such as \"codex\""),
    model: field("model", isNullableString, "a model name or null"),
    effort: field("effort", isNullableString, "a reasoning level such as \"high\", or null"),
    fast: field("fast", isBoolean, "true or false"),
    network: field("network", isBoolean, "true or false"),
    harnessApps: field("harnessApps", isStringList, "a list of app names or IDs"),
    writableFolders: field("writableFolders", isStringList, "a list of folder paths"),
    memory: parseMemorySettings(id, value.memory),
    tools: parseToolsSettings(id, value.tools),
  };
}

function parseToolsSettings(id: string, raw: unknown): Partial<Record<StafToolId, boolean>> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentConfigError(id, '"tools" must be a JSON object mapping tool IDs to true or false.');
  }
  const overrides: Partial<Record<StafToolId, boolean>> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!isStafToolId(key)) {
      throw new AgentConfigError(id, `unknown tool "${key}" in "tools".`);
    }
    if (typeof val !== "boolean") {
      throw new AgentConfigError(id, `"tools.${key}" must be true or false.`);
    }
    overrides[key] = val;
  }
  return overrides;
}

function normalizeToolsEdit(
  base: Partial<Record<StafToolId, boolean>>,
  patch?: Partial<Record<StafToolId, boolean>>,
): Partial<Record<StafToolId, boolean>> {
  const resolved = resolveEnabledTools({ ...base, ...(patch ?? {}) });
  // Store only non-default overrides in agent.json so default agents stay clean.
  const overrides: Partial<Record<StafToolId, boolean>> = {};
  for (const tool of STAF_TOOL_CATALOG) {
    if (resolved[tool.id] !== tool.defaultEnabled) {
      overrides[tool.id] = resolved[tool.id];
    }
  }
  return overrides;
}

function parseMemorySettings(id: string, raw: unknown): AgentMemorySettings {
  if (raw === undefined) return { ...DEFAULT_MEMORY_SETTINGS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AgentConfigError(id, '"memory" must be a JSON object.');
  }
  const value = raw as Record<string, unknown>;
  const checkLimit = (key: "notesLimit" | "profileLimit", fallback: number): number => {
    const v = value[key];
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_MEMORY_LIMIT || v > MAX_MEMORY_LIMIT) {
      throw new AgentConfigError(
        id,
        `"memory.${key}" must be an integer between ${MIN_MEMORY_LIMIT} and ${MAX_MEMORY_LIMIT}.`,
      );
    }
    return v;
  };
  const nudge = value.nudgeInterval;
  if (
    nudge !== undefined &&
    (typeof nudge !== "number" || !Number.isInteger(nudge) || nudge < 0 || nudge > MAX_NUDGE_INTERVAL)
  ) {
    throw new AgentConfigError(
      id,
      `"memory.nudgeInterval" must be an integer between 0 and ${MAX_NUDGE_INTERVAL}.`,
    );
  }
  return {
    notesLimit: checkLimit("notesLimit", DEFAULT_MEMORY_SETTINGS.notesLimit),
    profileLimit: checkLimit("profileLimit", DEFAULT_MEMORY_SETTINGS.profileLimit),
    nudgeInterval: nudge === undefined ? DEFAULT_MEMORY_SETTINGS.nudgeInterval : nudge,
  };
}

function normalizeMemoryEdit(
  base: AgentMemorySettings,
  patch?: Partial<AgentMemorySettings>,
): AgentMemorySettings {
  if (!patch) return { ...base };
  const next: AgentMemorySettings = {
    notesLimit: patch.notesLimit ?? base.notesLimit,
    profileLimit: patch.profileLimit ?? base.profileLimit,
    nudgeInterval: patch.nudgeInterval ?? base.nudgeInterval,
  };
  if (
    !Number.isInteger(next.notesLimit) ||
    next.notesLimit < MIN_MEMORY_LIMIT ||
    next.notesLimit > MAX_MEMORY_LIMIT
  ) {
    throw new AgentInputError(`Notes limit must be between ${MIN_MEMORY_LIMIT} and ${MAX_MEMORY_LIMIT} characters.`);
  }
  if (
    !Number.isInteger(next.profileLimit) ||
    next.profileLimit < MIN_MEMORY_LIMIT ||
    next.profileLimit > MAX_MEMORY_LIMIT
  ) {
    throw new AgentInputError(`Profile limit must be between ${MIN_MEMORY_LIMIT} and ${MAX_MEMORY_LIMIT} characters.`);
  }
  if (!Number.isInteger(next.nudgeInterval) || next.nudgeInterval < 0 || next.nudgeInterval > MAX_NUDGE_INTERVAL) {
    throw new AgentInputError(`Reminder interval must be between 0 and ${MAX_NUDGE_INTERVAL} messages.`);
  }
  return next;
}

/**
 * Instructions for one chat run: Staf's own guidance, the agent's AGENTS.md, and
 * the conversation's frozen memory snapshot (when present).
 */
export function chatInstructions(
  agent: Pick<Agent, "instructions"> & { tools?: Partial<Record<StafToolId, boolean>> },
  now = new Date(),
  memoryBlock = "",
): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: zone,
  });
  const enabledTools = resolveEnabledTools(agent.tools);
  const parts = [
    "You are running inside Staf, a personal assistant for a household. You are not working on a software project unless the person asks for one.",
    "The person reads your answer in a chat app that renders Markdown. Lead with the answer. Keep it short unless they ask for depth. Use links for sources.",
  ];
  if (enabledTools.attach_file) {
    parts.push(
      "When you create a file that the person should view or download (such as a PDF, chart, or report), use Staf's attach_file tool to attach it directly to your reply.",
    );
  }
  if (enabledTools.memory && enabledTools.conversation_search) {
    parts.push(
      "Use Staf's memory tool to remember durable preferences, routines, people, places (profile) or operational notes (notes) across conversations, and conversation_search to look up earlier chats.",
    );
  } else if (enabledTools.memory) {
    parts.push(
      "Use Staf's memory tool to remember durable preferences, routines, people, places (profile) or operational notes (notes) across conversations.",
    );
  } else if (enabledTools.conversation_search) {
    parts.push("Use Staf's conversation_search tool to look up earlier chats when needed.");
  }
  parts.push(
    "Do not describe your tools or your working folder unless the person asks.",
    `The conversation started on ${date} (${zone}).`,
  );
  const own = agent.instructions.trim();
  if (own) parts.push(`The agent's own instructions follow.\n\n${own}`);
  const mem = memoryBlock.trim();
  if (mem) parts.push(mem);
  return parts.join("\n\n");
}
