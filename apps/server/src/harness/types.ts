import type { Activity, HarnessInfo } from "@staf/protocol";

/** Normalized events that every harness adapter emits while a turn runs. */
export type HarnessEvent =
  /** The harness created or replaced the session. Store the ID to resume later. */
  | { type: "session"; sessionId: string }
  /** Append text to the answer. */
  | { type: "text"; text: string }
  /** Add or update one step. Activities with the same ID replace each other. */
  | { type: "activity"; activity: Activity };

export type TurnOutcome =
  | { status: "completed" }
  | { status: "interrupted" }
  | { status: "failed"; error: string };

export interface TurnRequest {
  /** The harness session to continue, or null to start a new one. */
  sessionId: string | null;
  /** The agent folder, used as the working directory. */
  cwd: string;
  /** Staf's instructions for this run, added to the harness's own. */
  instructions: string;
  /** Model to request, or null for the harness default. */
  model: string | null;
  input: string;
  /** Aborting the signal interrupts the turn. */
  signal: AbortSignal;
  emit: (event: HarnessEvent) => void;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly label: string;
  /** Reports whether the harness can run, without starting it. */
  status(): Promise<HarnessInfo>;
  /** Runs one turn. The promise settles when the turn ends; it never rejects. */
  runTurn(request: TurnRequest): Promise<TurnOutcome>;
  /** Stops any process that the adapter started. */
  close(): Promise<void>;
}
