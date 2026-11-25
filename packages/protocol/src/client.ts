// A small API client that works in browsers, Bun, and (later) React Native.

import type {
  AgentInput,
  AgentSummary,
  LoginStart,
  ModelInfo,
  UpdateThreadRequest,
  ApiErrorBody,
  CreateThreadRequest,
  HealthInfo,
  SendMessageResponse,
  StreamEvent,
  ThreadDetail,
  ThreadSummary,
} from "./types.ts";

export class StafApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StafApiError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class StafClient {
  private readonly fetchImpl: FetchLike;

  constructor(
    readonly baseUrl: string,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  health(): Promise<HealthInfo> {
    return this.request("GET", "/api/health");
  }

  listAgents(): Promise<AgentSummary[]> {
    return this.request("GET", "/api/agents");
  }

  createAgent(input: AgentInput): Promise<AgentSummary> {
    return this.request("POST", "/api/agents", input);
  }

  updateAgent(id: string, input: Partial<AgentInput>): Promise<AgentSummary> {
    return this.request("PATCH", `/api/agents/${encodeURIComponent(id)}`, input);
  }

  deleteAgent(id: string): Promise<void> {
    return this.request("DELETE", `/api/agents/${encodeURIComponent(id)}`);
  }

  listModels(harness: string): Promise<ModelInfo[]> {
    return this.request("GET", `/api/harnesses/${encodeURIComponent(harness)}/models`);
  }

  startLogin(harness: string): Promise<LoginStart> {
    return this.request("POST", `/api/harnesses/${encodeURIComponent(harness)}/login`);
  }

  listThreads(): Promise<ThreadSummary[]> {
    return this.request("GET", "/api/threads");
  }

  createThread(input: CreateThreadRequest = {}): Promise<ThreadSummary> {
    return this.request("POST", "/api/threads", input);
  }

  getThread(id: string): Promise<ThreadDetail> {
    return this.request("GET", `/api/threads/${encodeURIComponent(id)}`);
  }

  updateThread(id: string, input: UpdateThreadRequest): Promise<ThreadSummary> {
    return this.request("PATCH", `/api/threads/${encodeURIComponent(id)}`, input);
  }

  deleteThread(id: string): Promise<void> {
    return this.request("DELETE", `/api/threads/${encodeURIComponent(id)}`);
  }

  sendMessage(threadId: string, text: string): Promise<SendMessageResponse> {
    return this.request("POST", `/api/threads/${encodeURIComponent(threadId)}/messages`, { text });
  }

  interrupt(threadId: string): Promise<void> {
    return this.request("POST", `/api/threads/${encodeURIComponent(threadId)}/interrupt`);
  }

  /**
   * Streams host events until the connection closes or `signal` aborts.
   * The first event on every connection is `{ type: "ready" }`.
   */
  async *events(signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await this.fetchImpl(this.baseUrl + "/api/events", {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new StafApiError(res.status, `Could not open the event stream (${res.status}).`);
    }
    const reader = res.body.getReader();
    const parser = new SseParser();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        for (const data of parser.push(value)) {
          yield JSON.parse(data) as StreamEvent;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "x-staf-client": "1" };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as ApiErrorBody | null;
      throw new StafApiError(res.status, payload?.error ?? `Request failed (${res.status}).`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

/** Collects the `data:` payload of each server-sent event from raw byte chunks. */
export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    const out: string[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }
}
