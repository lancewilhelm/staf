import type { HarnessInfo } from "@staf/protocol";
import type { HarnessAdapter, TurnOutcome, TurnRequest } from "./types.ts";

/**
 * A harness that answers without a model. Tests use it, and `STAF_HARNESS=fake`
 * uses it for offline work on the web app.
 */
export class FakeHarness implements HarnessAdapter {
  readonly id = "fake";
  readonly label = "Fake harness";
  readonly requests: TurnRequest[] = [];

  constructor(private readonly options: { delayMs?: number; fail?: string } = {}) {}

  async status(): Promise<HarnessInfo> {
    return { id: this.id, label: this.label, ready: true };
  }

  async runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.requests.push(request);
    const delay = this.options.delayMs ?? 0;
    const sessionId = request.sessionId ?? `fake-${crypto.randomUUID()}`;
    if (!request.sessionId) request.emit({ type: "session", sessionId });

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
    return { status: "completed" };
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
