import type { Activity, Message, StafClient, StreamEvent } from "@staf/protocol";

export interface AnswerOutput {
  text(chunk: string): void;
  activity(activity: Activity): void;
}

/**
 * Sends one message and streams the answer to `out`. Resolves with the finished
 * assistant message. Aborting `signal` asks the host to stop the answer.
 */
export async function streamAnswer(
  client: StafClient,
  threadId: string,
  text: string,
  out: AnswerOutput,
  signal?: AbortSignal,
): Promise<Message> {
  const connection = new AbortController();
  const events = client.events(connection.signal)[Symbol.asyncIterator]();
  const next = async (): Promise<StreamEvent> => {
    const result = await events.next();
    if (result.done) throw new Error("Lost the connection to Staf.");
    return result.value;
  };

  try {
    // Subscribe before sending, so that no event is missed.
    while ((await next()).type !== "ready") {}
    await client.sendMessage(threadId, text);
    const onAbort = () => void client.interrupt(threadId).catch(() => {});
    signal?.addEventListener("abort", onAbort, { once: true });

    let messageId: string | null = null;
    const printed = new Set<string>();
    try {
      for (;;) {
        const event = await next();
        if (event.type === "message.created") {
          if (event.message.threadId === threadId && event.message.role === "assistant") {
            messageId ??= event.message.id;
          }
          continue;
        }
        if (!messageId) continue;
        if (event.type === "message.delta" && event.messageId === messageId) {
          out.text(event.text);
        } else if (event.type === "message.activity" && event.messageId === messageId) {
          const { activity } = event;
          if (activity.status !== "running" && !printed.has(activity.id)) {
            printed.add(activity.id);
            out.activity(activity);
          }
        } else if (event.type === "message.completed" && event.message.id === messageId) {
          return event.message;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    connection.abort();
    await events.return?.(undefined).catch(() => {});
  }
}
