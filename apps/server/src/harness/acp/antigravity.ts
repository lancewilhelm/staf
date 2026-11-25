import { mkdirSync } from "node:fs";
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

/**
 * Antigravity through `agy acp`. Commands run in agy's sandbox, which allows writes only
 * in the workspace and blocks network access. The model can ask to run a command outside
 * the sandbox; Staf always refuses.
 */
export function antigravityAdapter(options: AntigravityOptions): AcpAdapter {
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  return new AcpAdapter({
    id: "antigravity",
    label: "Gemini (Antigravity)",
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
  });
}
