import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

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
  create(input: Required<AgentEdit>): Agent {
    const name = checkName(input.name);
    checkInstructions(input.instructions);
    const base = slug(name);
    let id = base;
    for (let n = 2; existsSync(join(this.root, id)); n++) id = `${base}-${n}`.slice(0, 63);
    const dir = join(this.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const settings: AgentSettings = {
      ...DEFAULT_SETTINGS,
      name,
      harness: input.harness,
      model: input.model,
      effort: input.effort,
      fast: input.fast,
    };
    writeFileSync(join(dir, "agent.json"), JSON.stringify(settings, null, 2) + "\n");
    writeFileSync(join(dir, "AGENTS.md"), input.instructions);
    return this.get(id)!;
  }

  /**
   * Changes an agent's name, harness, model, reasoning level, fast mode, or instructions. Other fields in agent.json,
   * including ones that Staf does not know, are kept as they are.
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
  };
}

/**
 * Instructions for one chat run: Staf's own guidance, then the agent's AGENTS.md.
 * Staf passes AGENTS.md itself because it sits outside the workspace, where the agent
 * cannot change it.
 */
export function chatInstructions(agent: Pick<Agent, "instructions">, now = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: zone,
  });
  const parts = [
    "You are running inside Staf, a personal assistant for a household. You are not working on a software project unless the person asks for one.",
    "The person reads your answer in a chat app that renders Markdown. Lead with the answer. Keep it short unless they ask for depth. Use links for sources.",
    "Do not describe your tools or your working folder unless the person asks.",
    `The conversation started on ${date} (${zone}).`,
  ];
  const own = agent.instructions.trim();
  if (own) parts.push(`The agent's own instructions follow.\n\n${own}`);
  return parts.join("\n\n");
}
