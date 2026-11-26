import { parseTimeOfDay, type TaskSchedule } from "@staf/protocol";
import { ChatError } from "./chat.ts";

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 10_080; // 7 days

/** Validates and normalizes a raw schedule object from an API request or database row. */
export function validateSchedule(raw: unknown): TaskSchedule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ChatError(400, "The schedule must be an object.");
  }
  const data = raw as Record<string, unknown>;
  switch (data.type) {
    case "daily": {
      if (typeof data.timeOfDay !== "string" || !parseTimeOfDay(data.timeOfDay)) {
        throw new ChatError(400, 'Choose a valid time of day in 24-hour HH:MM format, such as "05:30".');
      }
      let weekdays: number[] | undefined;
      if (data.weekdays !== undefined) {
        if (!Array.isArray(data.weekdays)) {
          throw new ChatError(400, "Weekdays must be a list of day numbers from 0 (Sunday) to 6 (Saturday).");
        }
        const cleaned = new Set<number>();
        for (const day of data.weekdays) {
          if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
            throw new ChatError(400, "Each weekday must be an integer from 0 (Sunday) to 6 (Saturday).");
          }
          cleaned.add(day);
        }
        if (cleaned.size > 0 && cleaned.size < 7) {
          weekdays = [...cleaned].sort((a, b) => a - b);
        }
      }
      return weekdays ? { type: "daily", timeOfDay: data.timeOfDay, weekdays } : { type: "daily", timeOfDay: data.timeOfDay };
    }
    case "interval": {
      if (
        typeof data.everyMinutes !== "number" ||
        !Number.isInteger(data.everyMinutes) ||
        data.everyMinutes < MIN_INTERVAL_MINUTES ||
        data.everyMinutes > MAX_INTERVAL_MINUTES
      ) {
        throw new ChatError(
          400,
          `Interval schedules must run every ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes.`,
        );
      }
      return { type: "interval", everyMinutes: data.everyMinutes };
    }
    case "once": {
      if (typeof data.runAt !== "number" || !Number.isFinite(data.runAt) || data.runAt <= 0) {
        throw new ChatError(400, "One-time schedules need a valid date and time.");
      }
      return { type: "once", runAt: Math.round(data.runAt) };
    }
    default:
      throw new ChatError(400, 'The schedule type must be "daily", "interval", or "once".');
  }
}

/**
 * Computes the next Unix timestamp (in milliseconds) after `now` when `schedule` should fire,
 * or `null` if a one-time schedule has already passed.
 */
export function computeNextRunAt(schedule: TaskSchedule, now = Date.now()): number | null {
  switch (schedule.type) {
    case "interval":
      return now + schedule.everyMinutes * 60_000;
    case "once":
      return schedule.runAt > now ? schedule.runAt : null;
    case "daily": {
      const parsed = parseTimeOfDay(schedule.timeOfDay);
      if (!parsed) return null;
      const base = new Date(now);
      const year = base.getFullYear();
      const month = base.getMonth();
      const day = base.getDate();
      const allowed = schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
      for (let offset = 0; offset <= 7; offset++) {
        const candidate = new Date(year, month, day + offset, parsed.hours, parsed.minutes, 0, 0);
        if (candidate.getTime() <= now) continue;
        if (allowed && !allowed.has(candidate.getDay())) continue;
        return candidate.getTime();
      }
      return null;
    }
  }
}

/** Builds a short, recognizable thread title for one scheduled task run, such as "Morning Paper · Nov 26". */
export function formatRunThreadTitle(taskName: string, now = Date.now()): string {
  const date = new Date(now).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const trimmed = taskName.trim() || "Scheduled task";
  return `${trimmed} · ${date}`;
}
