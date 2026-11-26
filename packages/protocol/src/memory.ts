import type { AgentMemorySettings, MemoryBlock } from "./types.ts";

/** Default per-agent memory limits matching Hermes's defaults. */
export const DEFAULT_MEMORY_SETTINGS: AgentMemorySettings = {
  notesLimit: 2200,
  profileLimit: 1375,
  nudgeInterval: 10,
};

export const MIN_MEMORY_LIMIT = 200;
export const MAX_MEMORY_LIMIT = 20_000;
export const MAX_NUDGE_INTERVAL = 100;

export function isMemoryBlock(value: unknown): value is MemoryBlock {
  return value === "notes" || value === "profile";
}

export function memoryBlockLabel(block: MemoryBlock): string {
  return block === "notes" ? "Notes" : "Profile";
}
