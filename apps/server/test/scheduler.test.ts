import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatScheduleSummary, StafClient, type StreamEvent } from "@staf/protocol";
import { createApp, type App } from "../src/app.ts";
import { resolvePaths } from "../src/config.ts";
import { FakeHarness } from "../src/harness/fake.ts";
import { computeNextRunAt, validateSchedule } from "../src/schedule.ts";

const apps: App[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
});

function startSchedulerApp() {
  const codex = new FakeHarness({ id: "codex" });
  const claude = new FakeHarness({ id: "claude" });
  const antigravity = new FakeHarness({ id: "antigravity" });
  const home = mkdtempSync(join(tmpdir(), "staf-sched-"));
  const paths = resolvePaths({ STAF_HOME: home });
  const app = createApp({
    paths,
    hostname: "127.0.0.1",
    port: 0,
    harnesses: [codex, claude, antigravity],
  });
  apps.push(app);
  const url = app.url.href.replace(/\/$/, "");
  return { app, codex, claude, antigravity, client: new StafClient(url), url };
}

async function collect(client: StafClient, until: (event: StreamEvent) => boolean, action: () => Promise<unknown>) {
  const events: StreamEvent[] = [];
  const controller = new AbortController();
  const iterator = client.events(controller.signal)[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toEqual({ type: "ready" });
  await action();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    events.push(value);
    if (until(value)) break;
  }
  controller.abort();
  return events;
}

describe("schedule math and formatting", () => {
  test("computes next run times for daily, weekday, interval, and one-time schedules", () => {
    // Wed Nov 25, 2026 08:00 local time
    const wedMorning = new Date(2026, 10, 25, 8, 0, 0, 0).getTime();

    const laterToday = computeNextRunAt({ type: "daily", timeOfDay: "09:30" }, wedMorning);
    expect(laterToday).toBe(new Date(2026, 10, 25, 9, 30, 0, 0).getTime());

    const tomorrowEarly = computeNextRunAt({ type: "daily", timeOfDay: "05:30" }, wedMorning);
    expect(tomorrowEarly).toBe(new Date(2026, 10, 26, 5, 30, 0, 0).getTime());

    // Only Fridays (5) -> Nov 27, 2026
    const friday = computeNextRunAt({ type: "daily", timeOfDay: "07:00", weekdays: [5] }, wedMorning);
    expect(friday).toBe(new Date(2026, 10, 27, 7, 0, 0, 0).getTime());

    const interval = computeNextRunAt({ type: "interval", everyMinutes: 30 }, wedMorning);
    expect(interval).toBe(wedMorning + 30 * 60_000);

    expect(computeNextRunAt({ type: "once", runAt: wedMorning + 60_000 }, wedMorning)).toBe(wedMorning + 60_000);
    expect(computeNextRunAt({ type: "once", runAt: wedMorning - 1000 }, wedMorning)).toBeNull();
  });

  test("validates schedules and formats summaries in plain English", () => {
    expect(validateSchedule({ type: "daily", timeOfDay: "05:30", weekdays: [5, 1, 1] })).toEqual({
      type: "daily",
      timeOfDay: "05:30",
      weekdays: [1, 5],
    });
    expect(() => validateSchedule({ type: "daily", timeOfDay: "25:00" })).toThrow(/HH:MM/);
    expect(() => validateSchedule({ type: "interval", everyMinutes: 2 })).toThrow(/5 to 10080/);
    expect(() => validateSchedule({ type: "cron" })).toThrow(/daily/);

    expect(formatScheduleSummary({ type: "daily", timeOfDay: "05:30" })).toBe("Every day at 5:30 AM");
    expect(formatScheduleSummary({ type: "daily", timeOfDay: "08:00", weekdays: [1, 2, 3, 4, 5] })).toBe(
      "Weekdays at 8:00 AM",
    );
    expect(formatScheduleSummary({ type: "daily", timeOfDay: "09:00", weekdays: [0, 6] })).toBe("Weekends at 9:00 AM");
    expect(formatScheduleSummary({ type: "interval", everyMinutes: 60 })).toBe("Every hour");
    expect(formatScheduleSummary({ type: "interval", everyMinutes: 120 })).toBe("Every 2 hours");
    expect(formatScheduleSummary({ type: "interval", everyMinutes: 15 })).toBe("Every 15 minutes");
  });
});

describe("scheduled tasks over HTTP", () => {
  test("creates, pauses, runs now, fires on tick, and cleans up on thread/agent deletion", async () => {
    const { app, client, claude } = startSchedulerApp();
    const agent = await client.createAgent({
      name: "Paper",
      harness: "claude",
      model: null,
      effort: null,
      fast: false,
      instructions: "Write the daily paper.",
    });

    const createEvents = await collect(
      client,
      (event) => event.type === "tasks.changed" && event.agentId === agent.id,
      () =>
        client.createScheduledTask(agent.id, {
          name: "Morning Paper",
          prompt: "Compile today's news for Lisbon.",
          schedule: { type: "daily", timeOfDay: "05:30" },
        }),
    );
    expect(createEvents).toContainEqual({ type: "tasks.changed", agentId: agent.id });

    const tasks = await client.listScheduledTasks(agent.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task).toMatchObject({
      agentId: agent.id,
      name: "Morning Paper",
      enabled: true,
      fast: false,
      lastRunStatus: null,
    });
    expect(task.nextRunAt).toBeNumber();

    // Pause and resume.
    const paused = await client.updateScheduledTask(task.id, { enabled: false });
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();

    // Run now works even while paused and creates a schedule-sourced thread with a clean title.
    const run = await client.runScheduledTask(task.id);
    expect(run.thread).toMatchObject({
      agentId: agent.id,
      harness: "claude",
      source: "schedule",
      taskId: task.id,
      settledAt: null,
    });
    expect(run.thread.title).toStartWith("Morning Paper · ");
    await app.scheduler.idle();

    const afterRun = (await client.listScheduledTasks(agent.id))[0]!;
    expect(afterRun.lastRunStatus).toBe("complete");
    expect(afterRun.lastRunThreadId).toBe(run.thread.id);
    expect(afterRun.enabled).toBe(false);
    expect(claude.requests[0]!.input).toBe("Compile today's news for Lisbon.");

    // Deleting the run thread clears lastRunThreadId.
    await client.deleteThread(run.thread.id);
    expect((await client.listScheduledTasks(agent.id))[0]!.lastRunThreadId).toBeNull();

    // Resume and fire a due tick.
    const resumed = await client.updateScheduledTask(task.id, { enabled: true });
    const dueTime = resumed.nextRunAt! + 1000;
    const started = app.scheduler.tick(dueTime);
    expect(started).toHaveLength(1);
    await app.scheduler.idle();

    const afterTick = (await client.listScheduledTasks(agent.id))[0]!;
    expect(afterTick.lastRunStatus).toBe("complete");
    expect(afterTick.nextRunAt!).toBeGreaterThan(dueTime);

    // One-time task disables itself after firing.
    const onceAt = Date.now() + 120_000;
    const once = await client.createScheduledTask(agent.id, {
      name: "One-off check",
      prompt: "Check ferry times",
      schedule: { type: "once", runAt: onceAt },
    });
    app.scheduler.tick(onceAt + 1000);
    await app.scheduler.idle();
    const afterOnce = (await client.listScheduledTasks(agent.id)).find((t) => t.id === once.id)!;
    expect(afterOnce.enabled).toBe(false);
    expect(afterOnce.nextRunAt).toBeNull();
    expect(afterOnce.lastRunStatus).toBe("complete");

    // Deleting the agent deletes its scheduled tasks.
    await client.deleteAgent(agent.id);
    expect(app.store.listScheduledTasks(agent.id)).toEqual([]);
  });

  test("refuses to schedule tasks on Antigravity unless overridden to Codex or Claude", async () => {
    const { client } = startSchedulerApp();
    const geminiAgent = await client.createAgent({
      name: "Gemini Helper",
      harness: "antigravity",
      model: null,
      effort: null,
      fast: false,
      instructions: "",
    });

    // Inheriting antigravity is refused.
    await expect(
      client.createScheduledTask(geminiAgent.id, {
        name: "Daily check",
        prompt: "Check news",
        schedule: { type: "daily", timeOfDay: "07:00" },
      }),
    ).rejects.toMatchObject({ status: 400 });

    // Explicitly picking antigravity on a Codex agent is also refused.
    await expect(
      client.createScheduledTask("default", {
        name: "Daily check",
        prompt: "Check news",
        schedule: { type: "daily", timeOfDay: "07:00" },
        harness: "antigravity",
      }),
    ).rejects.toMatchObject({ status: 400 });

    // Overriding the Gemini agent's task to Claude succeeds.
    const ok = await client.createScheduledTask(geminiAgent.id, {
      name: "Daily check",
      prompt: "Check news",
      schedule: { type: "daily", timeOfDay: "07:00" },
      harness: "claude",
    });
    expect(ok.harness).toBe("claude");
  });
});
