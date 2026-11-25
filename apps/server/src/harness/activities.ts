// Helpers that every harness adapter uses to describe steps and to shape the answer.

import type { Activity } from "@staf/protocol";
import type { HarnessEvent } from "./types.ts";

const MAX_DETAIL = 4000;

/** A step for text that the model wrote before it used a tool, such as "I'll check AP." */
export function noteActivity(id: string, text: string): Activity {
  const now = Date.now();
  const line = firstLine(text);
  const activity: Activity = {
    id,
    kind: "note",
    title: line,
    status: "done",
    startedAt: now,
    completedAt: now,
  };
  if (text.trim() !== line) activity.detail = text.trim();
  return activity;
}

/**
 * Tracks the visible answer for harnesses that stream plain text with no label for
 * commentary. Text streams into the answer at once. When a tool starts after some text,
 * that text was commentary: it moves into a note step, and the answer starts again empty.
 */
export class AnswerText {
  private visible = "";
  private notes = 0;

  constructor(private readonly emit: (event: HarnessEvent) => void) {}

  get text(): string {
    return this.visible;
  }

  append(text: string): void {
    if (!text) return;
    this.visible += text;
    this.emit({ type: "text", text });
  }

  /** Separates a new block of text from the previous one with a blank line. */
  separate(): void {
    if (this.visible.trim() && !this.visible.endsWith("\n\n")) {
      this.append(this.visible.endsWith("\n") ? "\n" : "\n\n");
    }
  }

  /** Call before reporting a tool step. */
  toolStarted(): void {
    const text = this.visible.trim();
    this.visible = "";
    if (!text) return;
    this.emit({ type: "text.set", text: "" });
    this.emit({ type: "activity", activity: noteActivity(`note-${++this.notes}`, text) });
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function truncate(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}\n…` : text;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
