import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  access: AgentAccess;
  /** The agent's folder, which holds its settings and instructions. The agent cannot write here. */
  dir: string;
  /** The agent's working folder. Harness runs start here and may write here. */
  workspace: string;
  /** The contents of AGENTS.md. */
  instructions: string;
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
