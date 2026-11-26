// Live events from the host, shared by every Staf tab in this browser.
//
// Browsers allow about six open connections to one site over HTTP/1.1, and each event
// stream holds one for as long as the tab is open. With one stream per tab, a few open
// tabs would leave no connections for anything else, and pages would stop loading. So one
// tab, the one that holds a Web Lock, opens the stream and passes every event to the other
// tabs over a BroadcastChannel. When that tab closes, the lock passes to another tab, which
// opens a new stream.

import type { StafClient, StreamEvent } from "@staf/protocol";

const LOCK = "staf-events";
const RETRY_MS = 1500;

type Relay = { kind: "event"; event: StreamEvent } | { kind: "offline" };

export interface EventHandlers {
  event: (event: StreamEvent) => void;
  /** The stream dropped. A "ready" event follows when it is back. */
  offline: () => void;
  /** This tab does not hold the stream, so it loads the current state itself. */
  joined: () => void;
}

export function listenShared(api: StafClient, on: EventHandlers): void {
  const shared = typeof BroadcastChannel !== "undefined" && "locks" in navigator;
  if (!shared) {
    // Without locks, for example on a plain-HTTP address that is not this computer, each
    // tab keeps its own stream.
    void stream(api, on, () => {});
    return;
  }
  const channel = new BroadcastChannel(LOCK);
  channel.onmessage = (message: MessageEvent<Relay>) => {
    if (message.data.kind === "event") on.event(message.data.event);
    else on.offline();
  };
  const relay = (data: Relay) => channel.postMessage(data);
  const lead = () => stream(api, on, relay);

  void navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) return lead();
    // Another tab holds the stream. Load the current state, and take over the stream
    // when that tab closes.
    on.joined();
    void navigator.locks.request(LOCK, lead);
  });
}

/** Keeps one event stream open, and reconnects after a short wait when it drops. Never returns. */
async function stream(api: StafClient, on: EventHandlers, relay: (data: Relay) => void): Promise<never> {
  for (;;) {
    try {
      for await (const event of api.events()) {
        on.event(event);
        relay({ kind: "event", event });
      }
    } catch {
      // Reconnect below.
    }
    on.offline();
    relay({ kind: "offline" });
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
}
