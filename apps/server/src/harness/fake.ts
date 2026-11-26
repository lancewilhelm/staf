import type { HarnessInfo, ModelInfo } from "@staf/protocol";
import type { HarnessAdapter, TurnOutcome, TurnRequest } from "./types.ts";

/**
 * A harness that answers without a model. Tests use it, and `STAF_HARNESS=fake`
 * uses it for offline work on the web app.
 */
export class FakeHarness implements HarnessAdapter {
  readonly id: string;
  readonly label: string;
  readonly requests: TurnRequest[] = [];
  /** Sessions that Staf asked this harness to delete. */
  readonly deleted: string[] = [];

  constructor(
    private readonly options: { id?: string; delayMs?: number; fail?: string; commentary?: boolean } = {},
  ) {
    this.id = options.id ?? "fake";
    this.label = options.id ? `Fake ${options.id}` : "Fake harness";
  }

  async status(): Promise<HarnessInfo> {
    return { id: this.id, label: this.label, program: "Fake", signIn: "machine", ready: true };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: "fake-small", name: "Fake Small", isDefault: true },
      { id: "fake-large", name: "Fake Large", efforts: ["low", "high"], defaultEffort: "low", fast: true },
    ];
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleted.push(sessionId);
  }

  async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(request);
    const delay = this.options.delayMs ?? 0;
    const sessionId = request.sessionId ?? `fake-${crypto.randomUUID()}`;
    if (!request.sessionId) request.emit({ type: "session", sessionId });

    if (this.options.commentary) {
      // Like Claude and Antigravity: text that turns out to be commentary moves into a step.
      request.emit({ type: "text", text: "Let me look." });
      request.emit({ type: "text.set", text: "" });
      request.emit({
        type: "activity",
        activity: { id: "note-1", kind: "note", title: "Let me look.", status: "done", startedAt: Date.now() },
      });
    }
    const startedAt = Date.now();
    const activity = {
      id: "search-1",
      kind: "search" as const,
      title: `Searched: ${request.input.slice(0, 60)}`,
      status: "running" as const,
      startedAt,
    };
    request.emit({ type: "activity", activity });
    if (await this.wait(delay, request.signal)) return { status: "interrupted" };
    request.emit({
      type: "activity",
      activity: { ...activity, status: "done", completedAt: Date.now() },
    });

    if (this.options.fail) return { status: "failed", error: this.options.fail };

    const words = `You said: **${request.input}**`.split(/(?<= )/);
    for (const word of words) {
      if (await this.wait(delay, request.signal)) return { status: "interrupted" };
      request.emit({ type: "text", text: word });
    }
    return {
      status: "completed",
      report: {
        resolvedModel: request.model ?? "fake-small",
        stopReason: "end_turn",
        usage: { inputTokens: request.input.length, outputTokens: words.length, totalTokens: request.input.length + words.length },
        providerMeta: { fake: true },
      },
    };
  }

  async close(): Promise<void> {}

  /** Waits, and returns true if the signal aborted. */
  private async wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return true;
    if (ms <= 0) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(false);
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(true);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
