import { existsSync } from "node:fs";
import type {
  Activity,
  Attachment,
  Message,
  SendMessageResponse,
  ThreadSource,
  ThreadSummary,
  UpdateThreadRequest,
} from "@staf/protocol";
import { type Agent, AgentConfigError, type AgentAccess, chatInstructions, DEFAULT_AGENT_ID, type Agents } from "./agents.ts";
import {
  copyAttachmentToWorkspace,
  deleteThreadAttachmentFiles,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  normalizeMimeType,
  resolveAttachmentPath,
  sanitizeFilename,
  writeAttachmentFile,
} from "./attachments.ts";
import type { EventBus } from "./bus.ts";
import type { HarnessAdapter, HarnessEvent, TurnOutcome } from "./harness/types.ts";
import { publicAttachment, publicThread, type Store } from "./store.ts";

export class ChatError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

const TITLE_LENGTH = 60;
/** How much of the earlier conversation a new harness session receives, in characters. */
const HANDOFF_LENGTH = 40_000;
/** How often streamed text is written to the database while an answer runs. */
const SAVE_INTERVAL_MS = 1000;

export class ChatService {
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** Text and steps of answers that are still streaming, which the store saves only now and then. */
  private readonly live = new Map<string, { text: string; activities: Activity[] }>();

  constructor(
    private readonly store: Store,
    private readonly agents: Agents,
    private readonly harnesses: Map<string, HarnessAdapter>,
    private readonly bus: EventBus,
    private readonly attachmentsDir: string,
    /** Overrides the harness that agents ask for, such as "fake" for offline work. */
    private readonly harnessOverride: string | null = null,
  ) {}

  listThreads(): ThreadSummary[] {
    return this.store.listThreads().map(publicThread);
  }

  createThread(
    agentId = DEFAULT_AGENT_ID,
    choice: { harness?: string; model?: string | null; effort?: string | null; fast?: boolean; source?: ThreadSource } = {},
  ): ThreadSummary {
    const agent = this.loadAgent(agentId);
    if (!agent) throw new ChatError(404, `There is no agent named "${agentId}".`);
    const harness = this.harnessOverride ?? choice.harness ?? agent.harness;
    this.checkHarness(harness, choice.harness ? null : agent.id);
    // A harness picked for this conversation starts on its own defaults.
    const other = choice.harness !== undefined && choice.harness !== agent.harness;
    const thread = this.store.createThread({
      title: "New chat",
      agentId: agent.id,
      harness,
      model: choice.model !== undefined ? choice.model : other ? null : agent.model,
      effort: choice.effort !== undefined ? choice.effort : other ? null : agent.effort,
      fast: choice.fast ?? (other ? false : agent.fast),
      source: choice.source ?? "chat",
    });
    const summary = publicThread(thread);
    this.bus.publish({ type: "thread.upserted", thread: summary });
    return summary;
  }

  getThread(id: string): { thread: ThreadSummary; messages: Message[] } {
    const thread = this.store.getThread(id);
    if (!thread) throw new ChatError(404, "That conversation does not exist.");
    const messages = this.store.listMessages(id).map((message) => {
      const live = this.live.get(message.id);
      return live ? { ...message, text: live.text, activities: [...live.activities] } : message;
    });
    return { thread: publicThread(thread), messages };
  }

  /**
   * Changes the harness, model, reasoning level, or fast mode of a thread from the next
   * message on, or updates its settled state. A new harness starts a new session, which
   * receives the earlier conversation with the next message.
   */
  updateThread(id: string, change: UpdateThreadRequest): ThreadSummary {
    const thread = this.store.getThread(id);
    if (!thread) throw new ChatError(404, "That conversation does not exist.");
    const changingModel =
      change.harness !== undefined ||
      change.model !== undefined ||
      change.effort !== undefined ||
      change.fast !== undefined;
    if (changingModel && this.running.has(id)) {
      throw new ChatError(409, "Wait for the current answer to finish, or stop it first.");
    }
    const harness = change.harness ?? thread.harness;
    if (change.harness !== undefined) this.checkHarness(harness, null);
    const switching = harness !== thread.harness;
    const settledAt =
      change.settled === undefined ? undefined : change.settled ? (thread.settledAt ?? Date.now()) : null;
    const updated = this.store.updateThread(id, {
      harness,
      model: change.model !== undefined ? change.model : switching ? null : thread.model,
      effort: change.effort !== undefined ? change.effort : switching ? null : thread.effort,
      fast: change.fast ?? (switching ? false : thread.fast),
      ...(settledAt !== undefined ? { settledAt } : {}),
      ...(switching ? { sessionId: null } : {}),
    })!;
    const summary = publicThread(updated);
    this.bus.publish({ type: "thread.upserted", thread: summary });
    return summary;
  }

  /** Deletes a thread, its attachment files, and the copies that its harnesses keep. */
  async deleteThread(id: string): Promise<void> {
    const run = this.running.get(id);
    if (run) {
      run.controller.abort();
      await run.done;
    }
    if (!this.store.getThread(id)) throw new ChatError(404, "That conversation does not exist.");
    for (const session of this.store.listSessions(id)) {
      const harness = this.harnesses.get(session.harness);
      // A harness that Staf no longer has cannot be asked; its copy stays where it is.
      if (!harness) continue;
      try {
        await harness.deleteSession(session.sessionId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ChatError(
          502,
          `Staf could not delete ${harness.label}'s copy of this conversation, so it kept the conversation. ${reason}`,
        );
      }
    }
    this.store.deleteThread(id);
    deleteThreadAttachmentFiles(this.attachmentsDir, id);
    this.bus.publish({ type: "thread.deleted", threadId: id });
  }

  /** Uploads a pending file to a thread before the next message sends. */
  uploadAttachment(
    threadId: string,
    input: { name: string; mimeType?: string | null; bytes: Uint8Array },
  ): Attachment {
    if (!this.store.getThread(threadId)) throw new ChatError(404, "That conversation does not exist.");
    return this.saveAttachment(threadId, null, input);
  }

  /** Attaches a file directly to an existing message (such as a run's generated PDF) and notifies clients. */
  attachToMessage(
    threadId: string,
    messageId: string,
    input: { name: string; mimeType?: string | null; bytes: Uint8Array },
  ): Attachment {
    const message = this.store.getMessage(messageId);
    if (!message || message.threadId !== threadId) {
      throw new ChatError(404, "That message does not exist in this thread.");
    }
    const attachment = this.saveAttachment(threadId, messageId, input);
    this.bus.publish({ type: "message.attachment", threadId, messageId, attachment });
    return attachment;
  }

  /** Looks up an attachment's metadata and path on disk for serving. */
  getAttachmentFile(id: string): { attachment: Attachment; fullPath: string } {
    const stored = this.store.getAttachment(id);
    if (!stored) throw new ChatError(404, "That attachment does not exist.");
    const fullPath = resolveAttachmentPath(this.attachmentsDir, stored.storagePath);
    if (!existsSync(fullPath)) throw new ChatError(404, "That attachment file is missing from disk.");
    return { attachment: publicAttachment(stored), fullPath };
  }

  private saveAttachment(
    threadId: string,
    messageId: string | null,
    input: { name: string; mimeType?: string | null; bytes: Uint8Array },
  ): Attachment {
    if (input.bytes.byteLength === 0) throw new ChatError(400, "The file is empty.");
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ChatError(413, "Attachments must be 25 MB or smaller.");
    }
    const id = crypto.randomUUID();
    const name = sanitizeFilename(input.name);
    const mimeType = normalizeMimeType(input.mimeType, name);
    const storagePath = writeAttachmentFile(this.attachmentsDir, threadId, id, name, input.bytes);
    const stored = this.store.createAttachment({
      id,
      threadId,
      messageId,
      name,
      mimeType,
      sizeBytes: input.bytes.byteLength,
      storagePath,
    });
    return publicAttachment(stored);
  }

  /** Deletes every conversation of an agent, as `deleteThread` does. */
  async deleteThreadsOf(agentId: string): Promise<void> {
    for (const thread of this.store.listThreadsForAgent(agentId)) await this.deleteThread(thread.id);
  }

  /** Throws unless Staf has the harness. `agentId` names the agent whose setting chose it. */
  checkHarness(harness: string, agentId: string | null): void {
    if (this.harnesses.has(harness)) return;
    const known = [...this.harnesses.keys()].join(", ");
    const subject = agentId ? `The agent "${agentId}" uses the harness "${harness}"` : `The harness "${harness}"`;
    throw new ChatError(409, `${subject}, which Staf does not have. Use one of: ${known}.`);
  }

  interrupt(id: string): void {
    if (!this.store.getThread(id)) throw new ChatError(404, "That conversation does not exist.");
    this.running.get(id)?.controller.abort();
  }

  send(threadId: string, rawText: string, rawAttachmentIds: string[] = []): SendMessageResponse {
    const text = rawText.trim();
    const attachmentIds = [...new Set(rawAttachmentIds)];
    if (!text && attachmentIds.length === 0) throw new ChatError(400, "The message is empty.");
    const thread = this.store.getThread(threadId);
    if (!thread) throw new ChatError(404, "That conversation does not exist.");
    if (this.running.has(threadId)) {
      throw new ChatError(409, "Wait for the current answer to finish, or stop it first.");
    }
    const agent = this.loadAgent(thread.agentId);
    if (!agent) throw new ChatError(409, `The agent "${thread.agentId}" no longer exists.`);

    const pendingAttachments = attachmentIds.map((id) => {
      const item = this.store.getAttachment(id);
      if (!item || item.threadId !== threadId) {
        throw new ChatError(404, `Attachment "${id}" was not found in this thread.`);
      }
      if (item.messageId !== null) {
        throw new ChatError(409, `Attachment "${item.name}" is already attached to a message.`);
      }
      return item;
    });

    const earlier = this.store.listMessages(threadId);
    const isFirst = earlier.length === 0;
    const userMessage = this.store.addMessage({ threadId, role: "user", text, status: "complete" });
    const bound = this.store.bindAttachments(attachmentIds, userMessage.id);
    if (bound.length > 0) userMessage.attachments = bound.map(publicAttachment);

    let promptText = text;
    if (bound.length > 0) {
      const workspacePaths = bound.map((item) => {
        const rel = copyAttachmentToWorkspace(
          this.attachmentsDir,
          item.storagePath,
          item.id,
          item.name,
          agent.workspace,
        );
        return `${rel} (${item.mimeType}, ${formatBytes(item.sizeBytes)})`;
      });
      const note = `[Staf: the person attached ${bound.length === 1 ? "this file" : "these files"}, saved in your workspace: ${workspacePaths.join(", ")}]`;
      promptText = promptText ? `${note}\n\n${promptText}` : note;
    }

    // A thread without a session but with earlier messages has moved to another harness.
    const withHistory = isFirst ? undefined : handoffInput(earlier, promptText);
    const input = !thread.sessionId && withHistory ? withHistory : promptText;
    const assistantMessage = this.store.addMessage({
      threadId,
      role: "assistant",
      text: "",
      status: "streaming",
      harness: thread.harness,
      model: thread.model,
    });
    const updated = this.store.updateThread(threadId, {
      status: "running",
      settledAt: null,
      touch: true,
      ...(isFirst ? { title: titleFrom(text || pendingAttachments[0]!.name) } : {}),
    })!;
    this.bus.publish({ type: "message.created", message: userMessage });
    this.bus.publish({ type: "message.created", message: assistantMessage });
    this.bus.publish({ type: "thread.upserted", thread: publicThread(updated) });

    const controller = new AbortController();
    const done = this.runTurn({
      threadId,
      sessionId: thread.sessionId,
      harnessId: thread.harness,
      cwd: agent.workspace,
      access: agent.access,
      instructions: chatInstructions(agent),
      model: thread.model,
      effort: thread.effort,
      fast: thread.fast,
      input,
      ...(withHistory ? { inputWithHistory: withHistory } : {}),
      message: assistantMessage,
      signal: controller.signal,
    })
      .catch((error: unknown) => console.error(`The answer in thread ${threadId} failed:`, error))
      .finally(() => this.running.delete(threadId));
    this.running.set(threadId, { controller, done });
    return { userMessage, assistantMessage };
  }

  /** Loads an agent, and turns a settings problem into an error that the person can read. */
  private loadAgent(id: string): Agent | null {
    try {
      return this.agents.get(id);
    } catch (error) {
      if (error instanceof AgentConfigError) throw new ChatError(409, error.message);
      throw error;
    }
  }

  /** Waits for every running answer to end. Used by tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()].map((run) => run.done));
  }

  /** Stops every running answer and waits for them to end. */
  async stopAll(): Promise<void> {
    for (const run of this.running.values()) run.controller.abort();
    await this.idle();
  }

  private async runTurn(input: {
    threadId: string;
    sessionId: string | null;
    harnessId: string;
    cwd: string;
    access: AgentAccess;
    instructions: string;
    model: string | null;
    effort: string | null;
    fast: boolean;
    input: string;
    inputWithHistory?: string;
    message: Message;
    signal: AbortSignal;
  }): Promise<void> {
    const { threadId, message } = input;
    let text = "";
    const activities: Activity[] = [];
    let lastSave = Date.now();
    const live = { text, activities };
    this.live.set(message.id, live);

    const save = () => {
      this.store.updateMessage(message.id, { text, activities });
      lastSave = Date.now();
    };

    const emit = (event: HarnessEvent) => {
      switch (event.type) {
        case "session":
          this.store.updateThread(threadId, { sessionId: event.sessionId });
          this.store.addSession({ harness: input.harnessId, sessionId: event.sessionId, threadId });
          return;
        case "text":
          text += event.text;
          live.text = text;
          this.bus.publish({ type: "message.delta", threadId, messageId: message.id, text: event.text });
          if (Date.now() - lastSave > SAVE_INTERVAL_MS) save();
          return;
        case "text.set":
          text = event.text;
          live.text = text;
          this.bus.publish({ type: "message.text", threadId, messageId: message.id, text });
          return;
        case "activity": {
          const activity = mergeActivity(activities, event.activity);
          this.bus.publish({ type: "message.activity", threadId, messageId: message.id, activity });
          save();
          return;
        }
      }
    };

    const harness = this.harnesses.get(input.harnessId);
    let outcome: TurnOutcome;
    try {
      outcome = harness
        ? await harness.runTurn({
            sessionId: input.sessionId,
            cwd: input.cwd,
            access: input.access,
            instructions: input.instructions,
            model: input.model,
            effort: input.effort,
            fast: input.fast,
            input: input.input,
            ...(input.inputWithHistory ? { inputWithHistory: input.inputWithHistory } : {}),
            signal: input.signal,
            emit,
          })
        : { status: "failed", error: `Staf has no harness named "${input.harnessId}".` };
    } catch (error) {
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    }

    this.live.delete(message.id);
    const now = Date.now();
    // Steps that never reported an end are closed with the turn.
    for (const [index, activity] of activities.entries()) {
      if (activity.status === "running") {
        activities[index] = {
          ...activity,
          status: outcome.status === "completed" ? "done" : "failed",
          completedAt: now,
        };
      }
    }
    const finished = this.store.updateMessage(message.id, {
      text,
      activities,
      status: outcome.status === "completed" ? "complete" : outcome.status,
      error: outcome.status === "failed" ? outcome.error : null,
      completedAt: now,
    });
    const thread = this.store.updateThread(threadId, { status: "idle", touch: true });
    if (finished) this.bus.publish({ type: "message.completed", message: finished });
    if (thread) this.bus.publish({ type: "thread.upserted", thread: publicThread(thread) });
  }
}

/** Adds an activity or replaces the one with the same ID, keeping its start time. */
function mergeActivity(activities: Activity[], next: Activity): Activity {
  const index = activities.findIndex((activity) => activity.id === next.id);
  if (index < 0) {
    activities.push(next);
    return next;
  }
  const merged = { ...next, startedAt: activities[index]!.startedAt };
  activities[index] = merged;
  return merged;
}

/**
 * The first message to a new harness session in a conversation that started elsewhere:
 * the earlier conversation as text, newest kept when it is long, then the new message.
 */
export function handoffInput(earlier: Message[], text: string): string {
  const turns: string[] = [];
  let length = 0;
  for (const message of [...earlier].reverse()) {
    const body = message.text.trim();
    if (!body) continue;
    const tag = message.role === "user" ? "person" : "assistant";
    const turn = `<${tag}>\n${body}\n</${tag}>`;
    if (length + turn.length > HANDOFF_LENGTH) break;
    turns.unshift(turn);
    length += turn.length;
  }
  if (turns.length === 0) return text;
  return [
    "[Staf: this conversation started with another assistant. Here is what was said so far, oldest first. Continue it naturally. You do not need to mention the switch.]",
    `<conversation>\n${turns.join("\n")}\n</conversation>`,
    "[The person's new message follows.]",
    text,
  ].join("\n\n");
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}
