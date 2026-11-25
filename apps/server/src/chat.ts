import type { Activity, Message, SendMessageResponse, ThreadSummary } from "@staf/protocol";
import { chatInstructions, DEFAULT_AGENT_ID, type Agents } from "./agents.ts";
import type { EventBus } from "./bus.ts";
import type { HarnessAdapter, HarnessEvent, TurnOutcome } from "./harness/types.ts";
import { publicThread, type Store } from "./store.ts";

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
    /** Overrides the harness that agents ask for, such as "fake" for offline work. */
    private readonly harnessOverride: string | null = null,
  ) {}

  listThreads(): ThreadSummary[] {
    return this.store.listThreads().map(publicThread);
  }

  createThread(agentId = DEFAULT_AGENT_ID): ThreadSummary {
    const agent = this.agents.get(agentId);
    if (!agent) throw new ChatError(404, `There is no agent named "${agentId}".`);
    const thread = this.store.createThread({
      title: "New chat",
      agentId: agent.id,
      harness: this.harnessOverride ?? agent.harness,
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

  async deleteThread(id: string): Promise<void> {
    const run = this.running.get(id);
    if (run) {
      run.controller.abort();
      await run.done;
    }
    if (!this.store.deleteThread(id)) throw new ChatError(404, "That conversation does not exist.");
    this.bus.publish({ type: "thread.deleted", threadId: id });
  }

  interrupt(id: string): void {
    if (!this.store.getThread(id)) throw new ChatError(404, "That conversation does not exist.");
    this.running.get(id)?.controller.abort();
  }

  send(threadId: string, rawText: string): SendMessageResponse {
    const text = rawText.trim();
    if (!text) throw new ChatError(400, "The message is empty.");
    const thread = this.store.getThread(threadId);
    if (!thread) throw new ChatError(404, "That conversation does not exist.");
    if (this.running.has(threadId)) {
      throw new ChatError(409, "Wait for the current answer to finish, or stop it first.");
    }
    const agent = this.agents.get(thread.agentId);
    if (!agent) throw new ChatError(409, `The agent "${thread.agentId}" no longer exists.`);

    const isFirst = this.store.listMessages(threadId).length === 0;
    const userMessage = this.store.addMessage({ threadId, role: "user", text, status: "complete" });
    const assistantMessage = this.store.addMessage({
      threadId,
      role: "assistant",
      text: "",
      status: "streaming",
    });
    const updated = this.store.updateThread(threadId, {
      status: "running",
      touch: true,
      ...(isFirst ? { title: titleFrom(text) } : {}),
    })!;
    this.bus.publish({ type: "message.created", message: userMessage });
    this.bus.publish({ type: "message.created", message: assistantMessage });
    this.bus.publish({ type: "thread.upserted", thread: publicThread(updated) });

    const controller = new AbortController();
    const done = this.runTurn({
      threadId,
      sessionId: thread.sessionId,
      harnessId: thread.harness,
      cwd: agent.dir,
      model: agent.model,
      input: text,
      message: assistantMessage,
      signal: controller.signal,
    })
      .catch((error: unknown) => console.error(`The answer in thread ${threadId} failed:`, error))
      .finally(() => this.running.delete(threadId));
    this.running.set(threadId, { controller, done });
    return { userMessage, assistantMessage };
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
    model: string | null;
    input: string;
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
          return;
        case "text":
          text += event.text;
          live.text = text;
          this.bus.publish({ type: "message.delta", threadId, messageId: message.id, text: event.text });
          if (Date.now() - lastSave > SAVE_INTERVAL_MS) save();
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
            instructions: chatInstructions(),
            model: input.model,
            input: input.input,
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

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
}
