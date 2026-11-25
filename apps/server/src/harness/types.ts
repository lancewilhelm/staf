import type { Activity, HarnessInfo, ModelInfo } from "@staf/protocol";
import type { AgentAccess } from "../agents.ts";

/** Normalized events that every harness adapter emits while a turn runs. */
export type HarnessEvent =
  /** The harness created or replaced the session. Store the ID to resume later. */
  | { type: "session"; sessionId: string }
  /** Append text to the answer. */
  | { type: "text"; text: string }
  /** Replace the whole answer text, for example after commentary moves into a step. */
  | { type: "text.set"; text: string }
  /** Add or update one step. Activities with the same ID replace each other. */
  | { type: "activity"; activity: Activity };

export type TurnOutcome =
  | { status: "completed" }
  | { status: "interrupted" }
  | { status: "failed"; error: string };

export interface TurnRequest {
  /** The harness session to continue, or null to start a new one. */
  sessionId: string | null;
  /** The agent's workspace, used as the working directory. */
  cwd: string;
  /** What the agent may reach: network, harness apps, and extra writable folders. */
  access: AgentAccess;
  /** Staf's instructions for this run, added to the harness's own. */
  instructions: string;
  /** Model to request, or null for the harness default. */
  model: string | null;
  input: string;
  /**
   * The input for a new session when the saved one is gone: the earlier conversation and
   * then the new message. Absent when the conversation has no earlier messages.
   */
  inputWithHistory?: string;
  /** Aborting the signal interrupts the turn. */
  signal: AbortSignal;
  emit: (event: HarnessEvent) => void;
}

export interface HarnessAdapter {
  readonly id: string;
  /** Short name, such as "ChatGPT". */
  readonly label: string;
  /** Reports whether the harness can run, without starting a turn. */
  status(): Promise<HarnessInfo>;
  /** Lists the models that a conversation can ask for. */
  listModels(): Promise<ModelInfo[]>;
  /** Runs one turn. The promise settles when the turn ends; it never rejects. */
  runTurn(request: TurnRequest): Promise<TurnOutcome>;
  /** Deletes the harness's own copy of a conversation. Throws if it exists and cannot be deleted. */
  deleteSession(sessionId: string): Promise<void>;
  /** Stops any process that the adapter started. */
  close(): Promise<void>;
}
