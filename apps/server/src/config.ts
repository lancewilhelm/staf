import { homedir } from "node:os";
import { join } from "node:path";

export const VERSION = "0.1.0";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4280;

export interface Paths {
  /** Root of all Staf data, usually ~/.staf. */
  home: string;
  db: string;
  agents: string;
  /** Stored message attachments, grouped by thread ID. */
  attachments: string;
  /** CODEX_HOME for Staf's own Codex sign-in and configuration. */
  codexHome: string;
  /** Staf's own Antigravity data folder (agy's --gemini-dir). */
  antigravityHome: string;
}

export function resolvePaths(env: Record<string, string | undefined> = process.env): Paths {
  const home = env.STAF_HOME ?? join(homedir(), ".staf");
  return {
    home,
    db: join(home, "staf.db"),
    agents: join(home, "agents"),
    attachments: join(home, "attachments"),
    codexHome: join(home, "harness", "codex"),
    antigravityHome: join(home, "harness", "antigravity"),
  };
}

export function resolvePort(env: Record<string, string | undefined> = process.env): number {
  const raw = env.STAF_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`STAF_PORT must be a port number, not "${raw}".`);
  }
  return port;
}

/** The address that CLI commands use to reach the running host. */
export function resolveServerUrl(env: Record<string, string | undefined> = process.env): string {
  return env.STAF_URL ?? `http://${DEFAULT_HOST}:${resolvePort(env)}`;
}
