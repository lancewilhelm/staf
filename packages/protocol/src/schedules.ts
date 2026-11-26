import type { TaskSchedule } from "./types.ts";

/** Harnesses that Staf refuses to use for scheduled tasks. */
export const SCHEDULE_BLOCKED_HARNESSES = new Set(["antigravity"]);

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function parseTimeOfDay(value: string): { hours: number; minutes: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

function formatClockTime(timeOfDay: string): string {
  const parsed = parseTimeOfDay(timeOfDay);
  if (!parsed) return timeOfDay;
  const suffix = parsed.hours >= 12 ? "PM" : "AM";
  const hour12 = parsed.hours % 12 === 0 ? 12 : parsed.hours % 12;
  const mins = String(parsed.minutes).padStart(2, "0");
  return `${hour12}:${mins} ${suffix}`;
}

/** Formats a task schedule in plain English for display in the web app and CLI. */
export function formatScheduleSummary(schedule: TaskSchedule): string {
  switch (schedule.type) {
    case "daily": {
      const time = formatClockTime(schedule.timeOfDay);
      const days = schedule.weekdays ? [...new Set(schedule.weekdays)].sort((a, b) => a - b) : [];
      if (days.length === 0 || days.length === 7) return `Every day at ${time}`;
      if (days.length === 5 && days.join(",") === "1,2,3,4,5") return `Weekdays at ${time}`;
      if (days.length === 2 && days.join(",") === "0,6") return `Weekends at ${time}`;
      return `${days.map((d) => DAY_SHORT[d] ?? "").join(", ")} at ${time}`;
    }
    case "interval": {
      const mins = schedule.everyMinutes;
      if (mins === 60) return "Every hour";
      if (mins % 60 === 0) return `Every ${mins / 60} hours`;
      return `Every ${mins} minutes`;
    }
    case "once": {
      const date = new Date(schedule.runAt);
      const formatted = date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
      return `Once on ${formatted}`;
    }
  }
}
