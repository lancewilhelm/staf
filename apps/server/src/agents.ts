import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_AGENT_ID = "default";

/** Settings stored in an agent's agent.json. */
export interface AgentSettings {
  name: string;
  /** Harness that runs this agent, such as "codex". */
  harness: string;
  /** Model to request, or null to use the harness default. */
  model: string | null;
}

export interface Agent extends AgentSettings {
  id: string;
  /** The agent's folder. Harness runs use it as their working directory. */
  dir: string;
}

const DEFAULT_SETTINGS: AgentSettings = { name: "Staf", harness: "codex", model: null };

const DEFAULT_INSTRUCTIONS = `# Staf

You are Staf, a personal assistant for a household.

- Answer the question first, in plain language. Add detail only when it helps.
- When you use the web, check that sources are current and link them inline.
- This folder is your workspace. You can keep notes and files here.
`;

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class Agents {
  constructor(private readonly root: string) {}

  /** Creates the default agent folder on first run. */
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

  get(id: string): Agent | null {
    if (!AGENT_ID.test(id)) return null;
    const dir = join(this.root, id);
    const settingsPath = join(dir, "agent.json");
    if (!existsSync(settingsPath)) return null;
    const raw = JSON.parse(readFileSync(settingsPath, "utf8")) as Partial<AgentSettings>;
    return {
      id,
      dir,
      name: typeof raw.name === "string" ? raw.name : id,
      harness: typeof raw.harness === "string" ? raw.harness : DEFAULT_SETTINGS.harness,
      model: typeof raw.model === "string" ? raw.model : null,
    };
  }
}

/**
 * Instructions that Staf adds to every chat run, on top of the agent's own AGENTS.md.
 * The harness reads AGENTS.md from the working directory itself.
 */
export function chatInstructions(now = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = now.toLocaleString("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: zone,
  });
  return [
    "You are running inside Staf, a personal assistant for a household. You are not working on a software project unless the person asks for one.",
    "The person reads your answer in a chat app that renders Markdown. Lead with the answer. Keep it short unless they ask for depth. Use links for sources.",
    "Do not describe your tools or your working folder unless the person asks.",
    `The conversation started on ${date} (${zone}).`,
  ].join("\n\n");
}
