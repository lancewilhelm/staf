import {
  DEFAULT_MEMORY_SETTINGS,
  isMemoryBlock,
  memoryBlockLabel,
  type AgentMemorySettings,
  type AgentMemorySnapshot,
  type ApproveMemoryRequest,
  type CreateMemoryRequest,
  type MemoryBlock,
  type MemoryEntry,
  type MemoryProposalAction,
  type MemorySource,
  type UpdateMemoryRequest,
} from "@staf/protocol";
import { AgentConfigError, type Agents } from "./agents.ts";
import type { EventBus } from "./bus.ts";
import { ChatError } from "./chat.ts";
import type { RunContext } from "./mcp/tokens.ts";
import { publicThread, type Store } from "./store.ts";

/** Maximum length for one single memory entry. */
const MAX_SINGLE_ENTRY = 2000;

/**
 * Patterns that indicate a memory entry contains injected instructions rather than
 * a plain fact, preference, or operational note.
 */
const INJECTION_RULES: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\u{e0000}|\p{Cf}/u,
    reason: "Contains hidden or bidirectional Unicode control characters.",
  },
  {
    pattern: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|your\s+|the\s+)?(?:previous|prior|above|system|earlier)\s+(?:instructions?|prompts?|rules?|directions?|policy)\b/i,
    reason: "Looks like an attempt to override instructions.",
  },
  {
    pattern: /\b(?:new\s+system\s+prompt|system\s+override|you\s+are\s+now\s+(?:a|an|in)\s+(?:unrestricted|developer|admin|jailbroken))\b/i,
    reason: "Looks like a system prompt override.",
  },
  {
    pattern: /(?:<\/?system\b|<\|im_start\|>|<\|im_end\|>|\[SYSTEM\]|^###\s*SYSTEM\b)/im,
    reason: "Contains spoofed system prompt delimiters.",
  },
  {
    pattern: /\b(?:do\s+not\s+tell\s+the\s+user|hide\s+this\s+from\s+the\s+user|without\s+telling\s+the\s+user|secretly\s+(?:send|email|forward|exfiltrate|run|execute))\b/i,
    reason: "Asks the assistant to act secretly or hide actions from the person.",
  },
  {
    pattern: /\b(?:exfiltrate|forward\s+all\s+emails?|curl\s+[^|\n]+\|\s*(?:ba)?sh|cat\s+~\/\.ssh|read\s+~\/\.ssh|cat\s+\/etc\/passwd)\b/i,
    reason: "Contains suspicious data-exfiltration or shell execution instructions.",
  },
];

/**
 * Scans a memory entry for prompt-injection patterns or hidden control characters.
 * Returns a plain-English reason if flagged, or null if the text looks safe.
 */
export function scanMemoryText(text: string): string | null {
  for (const rule of INJECTION_RULES) {
    if (rule.pattern.test(text)) return rule.reason;
  }
  return null;
}

/** Computes the total character count of a block's active entries joined by newlines. */
export function blockCharCount(entries: Array<{ text: string }>): number {
  if (entries.length === 0) return 0;
  return entries.map((e) => e.text).join("\n").length;
}

export interface MemoryToolInput {
  action: "list" | "add" | "replace" | "remove";
  block?: MemoryBlock;
  text?: string;
  match?: string;
}

/**
 * Clean interface for Staf's memory backend so that a future memory engine can replace v1.
 */
export interface MemoryBackend {
  getSnapshot(agentId: string): AgentMemorySnapshot;
  listThreadProposals(threadId: string): MemoryEntry[];
  renderPromptBlock(agentId: string): string;
  createActive(agentId: string, input: CreateMemoryRequest, source?: MemorySource): MemoryEntry;
  updateEntry(id: string, input: UpdateMemoryRequest): MemoryEntry;
  deleteEntry(id: string): void;
  approveProposal(id: string, edit?: ApproveMemoryRequest): MemoryEntry | null;
  rejectProposal(id: string): void;
  applyToolCall(run: RunContext, input: MemoryToolInput): Record<string, unknown>;
  deleteForAgent(agentId: string): void;
}

export class MemoryService implements MemoryBackend {
  constructor(
    private readonly store: Store,
    private readonly agents: Agents,
    private readonly bus: EventBus,
  ) {}

  getSnapshot(agentId: string): AgentMemorySnapshot {
    const settings = this.agentMemorySettings(agentId);
    const all = this.store.listMemories(agentId);
    const activeById = new Map<string, MemoryEntry>();
    const active: MemoryEntry[] = [];
    const rawProposed: MemoryEntry[] = [];

    for (const item of all) {
      const decorated = decorateMemory(item, activeById);
      if (item.status === "active") {
        activeById.set(item.id, decorated);
        active.push(decorated);
      } else {
        rawProposed.push(item);
      }
    }

    const proposed = rawProposed.map((item) => decorateMemory(item, activeById));
    const notesEntries = active.filter((e) => e.block === "notes");
    const profileEntries = active.filter((e) => e.block === "profile");

    return {
      agentId,
      settings,
      usage: {
        notes: {
          used: blockCharCount(notesEntries),
          limit: settings.notesLimit,
          count: notesEntries.length,
        },
        profile: {
          used: blockCharCount(profileEntries),
          limit: settings.profileLimit,
          count: profileEntries.length,
        },
      },
      active,
      proposed,
    };
  }

  listThreadProposals(threadId: string): MemoryEntry[] {
    const proposals = this.store.listThreadProposals(threadId);
    if (proposals.length === 0) return [];
    const agentId = proposals[0]!.agentId;
    const activeById = new Map(
      this.store.listMemories(agentId, "active").map((entry) => [entry.id, entry] as const),
    );
    return proposals.map((entry) => decorateMemory(entry, activeById));
  }

  /**
   * Builds the frozen memory snapshot placed in a thread's instructions when it starts.
   * Flagged entries are withheld and replaced with a safe warning line.
   */
  renderPromptBlock(agentId: string): string {
    const snapshot = this.getSnapshot(agentId);
    const notes = snapshot.active.filter((e) => e.block === "notes");
    const profile = snapshot.active.filter((e) => e.block === "profile");
    if (notes.length === 0 && profile.length === 0) return "";

    const renderSection = (title: string, entries: MemoryEntry[], used: number, limit: number): string => {
      const lines = entries.map((entry) =>
        entry.flaggedReason
          ? "- [Withheld by Staf: this memory entry was flagged for possible prompt injection.]"
          : `- ${entry.text}`,
      );
      return `### ${title} (${used}/${limit} chars)\n${lines.join("\n")}`;
    };

    const sections: string[] = [];
    if (profile.length > 0) {
      sections.push(renderSection("Profile (about the person)", profile, snapshot.usage.profile.used, snapshot.usage.profile.limit));
    }
    if (notes.length > 0) {
      sections.push(renderSection("Notes (agent notes)", notes, snapshot.usage.notes.used, snapshot.usage.notes.limit));
    }
    return [
      "Saved memory for this agent (captured when this conversation started; use the memory tool to update it for future conversations):",
      ...sections,
    ].join("\n\n");
  }

  createActive(
    agentId: string,
    input: CreateMemoryRequest,
    source: MemorySource = { kind: "person" },
  ): MemoryEntry {
    const settings = this.agentMemorySettings(agentId);
    const block = requireBlock(input.block);
    const text = normalizeMemoryText(input.text);
    this.ensureWithinLimit(agentId, block, settings, text);

    const created = this.store.createMemory({
      agentId,
      block,
      text,
      status: "active",
      source,
    });
    this.notifyChanged(agentId, null);
    return decorateMemory(created);
  }

  updateEntry(id: string, input: UpdateMemoryRequest): MemoryEntry {
    const current = this.store.getMemory(id);
    if (!current) throw new ChatError(404, "That memory entry does not exist.");
    const settings = this.agentMemorySettings(current.agentId);
    const block = input.block !== undefined ? requireBlock(input.block) : current.block;
    const text = input.text !== undefined ? normalizeMemoryText(input.text) : current.text;

    if (current.status === "active") {
      this.ensureWithinLimit(current.agentId, block, settings, text, current.id);
    }
    const updated = this.store.updateMemory(id, { block, text })!;
    this.notifyChanged(updated.agentId, threadIdFromSource(updated.source));
    return decorateMemory(updated);
  }

  deleteEntry(id: string): void {
    const current = this.store.getMemory(id);
    if (!current) throw new ChatError(404, "That memory entry does not exist.");
    this.store.deleteMemory(id);
    const threadId = current.status === "proposed" ? threadIdFromSource(current.source) : null;
    this.notifyChanged(current.agentId, threadId);
  }

  approveProposal(id: string, edit: ApproveMemoryRequest = {}): MemoryEntry | null {
    const proposal = this.store.getMemory(id);
    if (!proposal) throw new ChatError(404, "That memory proposal does not exist.");
    if (proposal.status !== "proposed") {
      throw new ChatError(409, "That memory entry is already active.");
    }
    const settings = this.agentMemorySettings(proposal.agentId);
    const action: MemoryProposalAction = proposal.proposedAction ?? "add";
    const block = edit.block !== undefined ? requireBlock(edit.block) : proposal.block;
    const threadId = threadIdFromSource(proposal.source);

    if (action === "remove") {
      if (proposal.targetId) this.store.deleteMemory(proposal.targetId);
      this.store.deleteMemory(proposal.id);
      this.notifyChanged(proposal.agentId, threadId);
      return null;
    }

    const text = edit.text !== undefined ? normalizeMemoryText(edit.text) : normalizeMemoryText(proposal.text);

    if (action === "replace" && proposal.targetId) {
      const target = this.store.getMemory(proposal.targetId);
      if (target && target.agentId === proposal.agentId && target.status === "active") {
        this.ensureWithinLimit(proposal.agentId, block, settings, text, target.id);
        const updated = this.store.updateMemory(target.id, { block, text })!;
        this.store.deleteMemory(proposal.id);
        this.notifyChanged(proposal.agentId, threadId);
        return decorateMemory(updated);
      }
    }

    // Standard "add" proposal (or fallback if a replace target was already removed).
    this.ensureWithinLimit(proposal.agentId, block, settings, text);
    const promoted = this.store.updateMemory(proposal.id, {
      block,
      text,
      status: "active",
      proposedAction: null,
      targetId: null,
    })!;
    this.notifyChanged(proposal.agentId, threadId);
    return decorateMemory(promoted);
  }

  rejectProposal(id: string): void {
    const proposal = this.store.getMemory(id);
    if (!proposal) throw new ChatError(404, "That memory proposal does not exist.");
    if (proposal.status !== "proposed") {
      throw new ChatError(409, "Only pending proposals can be rejected.");
    }
    this.store.deleteMemory(proposal.id);
    this.notifyChanged(proposal.agentId, threadIdFromSource(proposal.source));
  }

  deleteForAgent(agentId: string): void {
    if (this.store.deleteMemoriesForAgent(agentId) > 0) {
      this.bus.publish({ type: "memories.changed", agentId });
    }
  }

  /**
   * Executes one call to Staf's `memory` MCP tool.
   * Trust is enforced strictly from `run.trigger`: scheduled runs can only create proposals,
   * never modify active memory directly.
   */
  applyToolCall(run: RunContext, input: MemoryToolInput): Record<string, unknown> {
    const snapshot = this.getSnapshot(run.agentId);

    if (input.action === "list") {
      const filterBlock = input.block ? requireBlock(input.block) : null;
      const active = filterBlock ? snapshot.active.filter((e) => e.block === filterBlock) : snapshot.active;
      const proposed = filterBlock ? snapshot.proposed.filter((e) => e.block === filterBlock) : snapshot.proposed;
      return {
        usage: snapshot.usage,
        active: active.map((e) => ({ id: e.id, block: e.block, text: e.text })),
        proposed: proposed.map((e) => ({
          id: e.id,
          block: e.block,
          action: e.proposedAction ?? "add",
          text: e.text,
          ...(e.targetId ? { targetId: e.targetId } : {}),
        })),
      };
    }

    const block = requireBlock(input.block);
    const settings = snapshot.settings;

    let text = "";
    if (input.action === "add" || input.action === "replace") {
      text = normalizeMemoryText(input.text ?? "");
      const flagged = scanMemoryText(text);
      if (flagged) {
        throw new ChatError(400, `Staf refused to save this memory entry: ${flagged}`);
      }
    }

    let target: MemoryEntry | null = null;
    if (input.action === "replace" || input.action === "remove") {
      const match = typeof input.match === "string" ? input.match.trim() : "";
      if (!match) {
        throw new ChatError(400, `Provide "match" (an entry ID or unique text substring) to ${input.action} a memory.`);
      }
      target = findMatchingEntry(snapshot.active.filter((e) => e.block === block), match);
    }

    // Scheduled runs may read outside content, so they can only create proposals for review.
    if (run.trigger === "schedule") {
      const source: MemorySource = {
        kind: "schedule",
        threadId: run.threadId,
        messageId: run.messageId,
        taskId: run.taskId,
      };
      const proposal = this.store.createMemory({
        agentId: run.agentId,
        block,
        text: input.action === "remove" ? (target?.text ?? "") : text,
        status: "proposed",
        proposedAction: input.action,
        targetId: target?.id ?? null,
        source,
      });
      this.notifyChanged(run.agentId, run.threadId);
      return {
        status: "proposed",
        message: "Saved as a memory proposal for the person to review in this thread.",
        proposal: {
          id: proposal.id,
          block: proposal.block,
          action: proposal.proposedAction ?? input.action,
          text: proposal.text,
          ...(target ? { targetId: target.id, targetText: target.text } : {}),
        },
      };
    }

    const source: MemorySource = {
      kind: "thread",
      threadId: run.threadId,
      messageId: run.messageId,
    };

    if (input.action === "add") {
      this.ensureWithinLimit(run.agentId, block, settings, text);
      const entry = this.store.createMemory({
        agentId: run.agentId,
        block,
        text,
        status: "active",
        source,
      });
      this.notifyChanged(run.agentId, null);
      const nextSnapshot = this.getSnapshot(run.agentId);
      return {
        status: "saved",
        entry: { id: entry.id, block: entry.block, text: entry.text },
        usage: nextSnapshot.usage[block],
      };
    }

    if (input.action === "replace" && target) {
      this.ensureWithinLimit(run.agentId, block, settings, text, target.id);
      const updated = this.store.updateMemory(target.id, { text })!;
      this.notifyChanged(run.agentId, null);
      const nextSnapshot = this.getSnapshot(run.agentId);
      return {
        status: "updated",
        entry: { id: updated.id, block: updated.block, text: updated.text },
        usage: nextSnapshot.usage[block],
      };
    }

    if (input.action === "remove" && target) {
      this.store.deleteMemory(target.id);
      this.notifyChanged(run.agentId, null);
      const nextSnapshot = this.getSnapshot(run.agentId);
      return {
        status: "removed",
        removedId: target.id,
        usage: nextSnapshot.usage[block],
      };
    }

    throw new ChatError(400, "Unsupported memory action.");
  }

  private ensureWithinLimit(
    agentId: string,
    block: MemoryBlock,
    settings: AgentMemorySettings,
    nextText: string,
    replacingId?: string,
  ): void {
    const limit = block === "notes" ? settings.notesLimit : settings.profileLimit;
    const current = this.store
      .listMemories(agentId, "active")
      .filter((entry) => entry.block === block && entry.id !== replacingId);
    const projected = blockCharCount([...current, { text: nextText }]);
    if (projected > limit) {
      throw new ChatError(
        409,
        `The ${memoryBlockLabel(block)} block would be ${projected} characters, which exceeds its ${limit}-character limit. Remove or merge older entries first, or raise the limit in Memory settings.`,
      );
    }
  }

  private agentMemorySettings(agentId: string): AgentMemorySettings {
    try {
      const agent = this.agents.get(agentId);
      if (!agent) throw new ChatError(404, `There is no agent named "${agentId}".`);
      return agent.memory ?? DEFAULT_MEMORY_SETTINGS;
    } catch (error) {
      if (error instanceof AgentConfigError) throw new ChatError(409, error.message);
      throw error;
    }
  }

  private notifyChanged(agentId: string, threadId: string | null): void {
    this.bus.publish({ type: "memories.changed", agentId, ...(threadId ? { threadId } : {}) });
    if (threadId) {
      const thread = this.store.getThread(threadId);
      if (thread) this.bus.publish({ type: "thread.upserted", thread: publicThread(thread) });
    }
  }
}

function findMatchingEntry(entries: MemoryEntry[], match: string): MemoryEntry {
  const byId = entries.find((e) => e.id === match);
  if (byId) return byId;
  const needle = match.toLowerCase();
  const hits = entries.filter((e) => e.text.toLowerCase().includes(needle));
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    throw new ChatError(
      400,
      `Multiple entries match "${match}". Pass a more specific phrase or the exact entry ID.`,
    );
  }
  throw new ChatError(404, `No entry in that block matches "${match}".`);
}

function requireBlock(value: unknown): MemoryBlock {
  if (!isMemoryBlock(value)) {
    throw new ChatError(400, 'Choose either the "notes" or "profile" memory block.');
  }
  return value;
}

function normalizeMemoryText(raw: string): string {
  const cleaned = raw.replace(/\r\n/g, "\n").trim();
  if (!cleaned) throw new ChatError(400, "Memory text cannot be empty.");
  if (cleaned.length > MAX_SINGLE_ENTRY) {
    throw new ChatError(400, `Keep each memory entry under ${MAX_SINGLE_ENTRY} characters.`);
  }
  return cleaned;
}

function threadIdFromSource(source: MemorySource): string | null {
  return source.kind === "thread" || source.kind === "schedule" ? source.threadId : null;
}

function decorateMemory(
  entry: MemoryEntry,
  activeById?: Map<string, MemoryEntry>,
): MemoryEntry {
  const flaggedReason = scanMemoryText(entry.text);
  const targetText =
    entry.status === "proposed" && entry.targetId && activeById
      ? (activeById.get(entry.targetId)?.text ?? null)
      : entry.targetText;
  return {
    ...entry,
    ...(targetText !== undefined ? { targetText } : {}),
    flaggedReason,
  };
}
