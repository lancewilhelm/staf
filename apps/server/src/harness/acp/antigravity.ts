import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AcpAdapter, defaultPermission } from "./adapter.ts";

export interface AntigravityOptions {
  /**
   * Staf's own Antigravity data folder (`--gemini-dir`). It keeps a person's global
   * GEMINI.md, hooks, and skills out of Staf runs. The Google sign-in comes from the
   * system keychain, so this folder needs no separate login.
   */
  home: string;
  /** Command that starts the ACP server. Tests replace it with a fake. */
  command?: string[];
}

export const ANTIGRAVITY_NOTE =
  "Experimental. Commands can't reach the internet, and Google has suspended Antigravity access for accounts that use it for automation.";

/**
 * Antigravity through `agy acp`. Commands run in agy's sandbox, which allows writes only
 * in the workspace and blocks network access. The model can ask to run a command outside
 * the sandbox; Staf always refuses.
 */
export function antigravityAdapter(options: AntigravityOptions): AcpAdapter {
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  return new AcpAdapter({
    id: "antigravity",
    label: "Gemini",
    program: "Antigravity",
    note: ANTIGRAVITY_NOTE,
    experimental: true,
    command: options.command ?? [
      "agy",
      "acp",
      "--sandbox",
      "--gemini-dir",
      options.home,
      "--disable-telemetry",
    ],
    requires: options.command ? undefined : "agy",
    // Checked against agy 1.5.14: other `_meta` shapes are ignored.
    sessionMeta: (instructions) => ({ antigravity: { systemPrompt: { append: instructions } } }),
    permission: (context) => {
      if (context.toolCall.rawInput?.BypassSandbox === true) return false;
      // Commands cannot write outside the workspace in agy's sandbox, so file tools are
      // held to the same limit, which keeps the agent's access the same for both.
      return defaultPermission({ ...context, access: { ...context.access, writableFolders: [] } });
    },
    unsupported: (access) =>
      access.writableFolders.length > 0
        ? [
            "Antigravity can only write to the agent's workspace, so the folders in writableFolders are read-only for this agent.",
          ]
        : [],
    signInHint: "Sign in to Antigravity by running `agy` once in a terminal.",
    modelsCache: join(options.home, "staf-models.json"),
    deleteSessionFiles: (sessionId) => deleteAntigravitySession(join(options.home, "antigravity-cli"), sessionId),
  });
}

const SESSION_ID = /^[A-Za-z0-9-]{8,80}$/;

/**
 * Deletes what agy 1.5 keeps for one conversation: its database, annotations, the
 * per-conversation `brain/` folder, and its row in the conversation summaries.
 */
export function deleteAntigravitySession(dataDir: string, sessionId: string): void {
  if (!SESSION_ID.test(sessionId)) throw new Error(`"${sessionId}" is not an Antigravity session ID.`);
  const conversations = join(dataDir, "conversations");
  if (existsSync(conversations)) {
    for (const name of readdirSync(conversations)) {
      if (name === `${sessionId}.db` || name.startsWith(`${sessionId}.db-`)) {
        rmSync(join(conversations, name), { force: true });
      }
    }
  }
  rmSync(join(dataDir, "annotations", `${sessionId}.pbtxt`), { force: true });
  rmSync(join(dataDir, "brain", sessionId), { recursive: true, force: true });

  const summaries = join(dataDir, "conversation_summaries.db");
  if (existsSync(summaries)) {
    const db = new Database(summaries, { strict: true });
    try {
      db.run("PRAGMA busy_timeout = 2000");
      db.query("DELETE FROM conversation_summaries WHERE conversation_id = $id").run({ id: sessionId });
    } finally {
      db.close();
    }
  }
}
