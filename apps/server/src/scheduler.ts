import {
  SCHEDULE_BLOCKED_HARNESSES,
  type CreateScheduledTaskRequest,
  type RunScheduledTaskResponse,
  type ScheduledTask,
  type ScheduledTaskRunStatus,
  type UpdateScheduledTaskRequest,
} from "@staf/protocol";
import { AgentConfigError, type Agents } from "./agents.ts";
import type { EventBus } from "./bus.ts";
import { ChatError, type ChatService } from "./chat.ts";
import { computeNextRunAt, formatRunThreadTitle, validateSchedule } from "./schedule.ts";
import type { Store } from "./store.ts";

const TICK_MS = 15_000;
/** Missed recurring runs older than this grace window advance to the next future slot on startup. */
const MISSED_GRACE_MS = 5 * 60_000;
const MAX_TASK_NAME = 80;
const ANTIGRAVITY_ERROR =
  "Scheduled tasks cannot run on Gemini (Antigravity) for now. Choose ChatGPT or Claude for this task or its agent.";

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly activeRuns = new Set<string>();
  private readonly watchers = new Set<Promise<void>>();

  constructor(
    private readonly store: Store,
    private readonly agents: Agents,
    private readonly chat: ChatService,
    private readonly bus: EventBus,
    private readonly harnessOverride: string | null = null,
  ) {}

  start(pollMs = TICK_MS): void {
    this.reconcileOnStart();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await Promise.allSettled([...this.watchers]);
  }

  /** Advances stale recurring schedules after downtime so waking a computer does not flood runs. */
  reconcileOnStart(now = Date.now()): void {
    for (const task of this.store.listScheduledTasks()) {
      if (!task.enabled) continue;
      if (task.schedule.type === "once") {
        if (task.nextRunAt !== null && task.nextRunAt < now - MISSED_GRACE_MS) {
          this.store.updateScheduledTask(task.id, { enabled: false, nextRunAt: null });
        }
        continue;
      }
      if (task.nextRunAt === null || task.nextRunAt < now - MISSED_GRACE_MS) {
        this.store.updateScheduledTask(task.id, {
          nextRunAt: computeNextRunAt(task.schedule, now),
        });
      }
    }
  }

  listTasks(agentId: string): ScheduledTask[] {
    this.requireAgent(agentId);
    return this.store.listScheduledTasks(agentId);
  }

  createTask(agentId: string, input: CreateScheduledTaskRequest, now = Date.now()): ScheduledTask {
    const agent = this.requireAgent(agentId);
    const name = readTaskName(input.name);
    const prompt = readTaskPrompt(input.prompt);
    const schedule = validateSchedule(input.schedule);
    const enabled = input.enabled ?? true;
    const harness = input.harness ?? null;
    const model = input.model ?? null;
    const effort = input.effort ?? null;
    const fast = input.fast ?? false;

    if (harness !== null) this.chat.checkHarness(harness, null);
    this.checkScheduleHarness(harness ?? agent.harness);

    const nextRunAt = enabled ? computeNextRunAt(schedule, now) : null;
    if (enabled && schedule.type === "once" && nextRunAt === null) {
      throw new ChatError(400, "Choose a date and time in the future for a one-time task.");
    }

    const task = this.store.createScheduledTask({
      agentId: agent.id,
      name,
      prompt,
      schedule,
      enabled,
      harness,
      model,
      effort,
      fast,
      nextRunAt,
    });
    this.bus.publish({ type: "tasks.changed", agentId: agent.id });
    return task;
  }

  updateTask(id: string, input: UpdateScheduledTaskRequest, now = Date.now()): ScheduledTask {
    const current = this.store.getScheduledTask(id);
    if (!current) throw new ChatError(404, "That scheduled task does not exist.");
    const agent = this.requireAgent(current.agentId);

    const name = input.name !== undefined ? readTaskName(input.name) : current.name;
    const prompt = input.prompt !== undefined ? readTaskPrompt(input.prompt) : current.prompt;
    const schedule = input.schedule !== undefined ? validateSchedule(input.schedule) : current.schedule;
    const enabled = input.enabled ?? current.enabled;
    const harness = input.harness === undefined ? current.harness : input.harness;
    const switchingHarness = harness !== current.harness;
    const model = input.model !== undefined ? input.model : switchingHarness ? null : current.model;
    const effort = input.effort !== undefined ? input.effort : switchingHarness ? null : current.effort;
    const fast = input.fast ?? (switchingHarness ? false : current.fast);

    if (harness !== null) this.chat.checkHarness(harness, null);
    if (enabled || input.harness !== undefined) {
      this.checkScheduleHarness(harness ?? agent.harness);
    }

    let nextRunAt = current.nextRunAt;
    if (!enabled) {
      nextRunAt = null;
    } else if (!current.enabled || input.schedule !== undefined || current.nextRunAt === null) {
      nextRunAt = computeNextRunAt(schedule, now);
      if (schedule.type === "once" && nextRunAt === null) {
        throw new ChatError(400, "Choose a date and time in the future before enabling this one-time task.");
      }
    }

    const updated = this.store.updateScheduledTask(id, {
      name,
      prompt,
      schedule,
      enabled,
      harness,
      model,
      effort,
      fast,
      nextRunAt,
    })!;
    this.bus.publish({ type: "tasks.changed", agentId: updated.agentId });
    return updated;
  }

  deleteTask(id: string): void {
    const current = this.store.getScheduledTask(id);
    if (!current) throw new ChatError(404, "That scheduled task does not exist.");
    this.store.deleteScheduledTask(id);
    this.bus.publish({ type: "tasks.changed", agentId: current.agentId });
  }

  deleteTasksForAgent(agentId: string): void {
    if (this.store.deleteScheduledTasksForAgent(agentId) > 0) {
      this.bus.publish({ type: "tasks.changed", agentId });
    }
  }

  /** Runs a task immediately, even if paused, without disturbing its recurring schedule. */
  runNow(id: string, now = Date.now()): RunScheduledTaskResponse {
    const task = this.store.getScheduledTask(id);
    if (!task) throw new ChatError(404, "That scheduled task does not exist.");
    return this.executeTask(task, "manual", now);
  }

  /** Checks for due scheduled tasks and starts each one. Exposed for tests. */
  tick(now = Date.now()): ScheduledTask[] {
    const due = this.store.listDueScheduledTasks(now);
    const started: ScheduledTask[] = [];
    for (const task of due) {
      if (this.activeRuns.has(task.id)) continue;
      try {
        const result = this.executeTask(task, "schedule", now);
        started.push(result.task);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const nextRunAt =
          task.schedule.type === "once" ? null : computeNextRunAt(task.schedule, now);
        this.store.updateScheduledTask(task.id, {
          enabled: task.schedule.type === "once" ? false : task.enabled,
          nextRunAt,
          lastRunAt: now,
          lastRunStatus: "failed",
          lastRunError: message,
        });
        this.bus.publish({ type: "tasks.changed", agentId: task.agentId });
      }
    }
    return started;
  }

  /** Waits for all in-flight task completion watchers to record their final status. */
  async idle(): Promise<void> {
    await this.chat.idle();
    await Promise.allSettled([...this.watchers]);
  }

  private executeTask(
    task: ScheduledTask,
    trigger: "schedule" | "manual",
    now: number,
  ): RunScheduledTaskResponse {
    if (this.activeRuns.has(task.id)) {
      throw new ChatError(409, "This scheduled task is already running.");
    }
    const agent = this.requireAgent(task.agentId);
    const effectiveHarness = this.harnessOverride ?? task.harness ?? agent.harness;
    this.checkScheduleHarness(effectiveHarness);

    const sameHarness = task.harness === null || task.harness === agent.harness;
    const model = task.model !== null ? task.model : sameHarness ? agent.model : null;
    const effort = task.effort !== null ? task.effort : sameHarness ? agent.effort : null;

    const thread = this.chat.createThread(agent.id, {
      title: formatRunThreadTitle(task.name, now),
      harness: effectiveHarness,
      model,
      effort,
      fast: task.fast,
      source: "schedule",
      taskId: task.id,
    });

    const schedulePatch =
      trigger === "schedule"
        ? task.schedule.type === "once"
          ? { enabled: false, nextRunAt: null }
          : { nextRunAt: computeNextRunAt(task.schedule, now) }
        : {};

    const runningTask = this.store.updateScheduledTask(task.id, {
      ...schedulePatch,
      lastRunAt: now,
      lastRunThreadId: thread.id,
      lastRunStatus: "running",
      lastRunError: null,
    })!;
    this.bus.publish({ type: "tasks.changed", agentId: task.agentId });

    this.activeRuns.add(task.id);
    let assistantMessageId: string;
    try {
      const sent = this.chat.send(thread.id, task.prompt);
      assistantMessageId = sent.assistantMessage.id;
    } catch (error) {
      this.activeRuns.delete(task.id);
      const reason = error instanceof Error ? error.message : String(error);
      this.store.updateScheduledTask(task.id, {
        lastRunStatus: "failed",
        lastRunError: reason,
      });
      this.bus.publish({ type: "tasks.changed", agentId: task.agentId });
      throw error;
    }

    const watch = this.chat
      .waitForThread(thread.id)
      .then(() => {
        const finalMessage = this.store.getMessage(assistantMessageId);
        const status: ScheduledTaskRunStatus =
          finalMessage?.status === "complete"
            ? "complete"
            : finalMessage?.status === "interrupted"
              ? "interrupted"
              : "failed";
        const error = status === "complete" ? null : (finalMessage?.error ?? null);
        // Only update if the task still exists.
        if (this.store.getScheduledTask(task.id)) {
          this.store.updateScheduledTask(task.id, {
            lastRunStatus: status,
            lastRunError: error,
          });
          this.bus.publish({ type: "tasks.changed", agentId: task.agentId });
        }
      })
      .finally(() => {
        this.activeRuns.delete(task.id);
        this.watchers.delete(watch);
      });
    this.watchers.add(watch);

    return { task: runningTask, thread };
  }

  private checkScheduleHarness(harness: string): void {
    if (this.harnessOverride) return;
    if (SCHEDULE_BLOCKED_HARNESSES.has(harness)) {
      throw new ChatError(400, ANTIGRAVITY_ERROR);
    }
  }

  private requireAgent(agentId: string) {
    try {
      const agent = this.agents.get(agentId);
      if (!agent) throw new ChatError(404, `There is no agent named "${agentId}".`);
      return agent;
    } catch (error) {
      if (error instanceof AgentConfigError) throw new ChatError(409, error.message);
      throw error;
    }
  }
}

function readTaskName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ChatError(400, "Give the scheduled task a name.");
  if (trimmed.length > MAX_TASK_NAME) {
    throw new ChatError(400, `Keep the task name under ${MAX_TASK_NAME} characters.`);
  }
  return trimmed;
}

function readTaskPrompt(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ChatError(400, "Write a prompt for the scheduled task.");
  return trimmed;
}
