import type { StreamEvent } from "@staf/protocol";

type Listener = (event: StreamEvent) => void;

/** Delivers host events to every connected client. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: StreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A failing client must not stop delivery to the others.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
