// JSON-RPC over the stdin and stdout of a child process, one JSON message per line.
// Codex app-server omits the "jsonrpc" field, so this client does too.

type Json = unknown;

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string };
}

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface RpcHandlers {
  onNotification(method: string, params: Json): void;
  /** Answers a request that the child sends. Throw an RpcError to reply with an error. */
  onRequest(method: string, params: Json): Promise<Json>;
  onExit(code: number | null, stderrTail: string): void;
}

export class RpcProcess {
  private readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >();
  private stderrTail = "";
  private exited = false;

  constructor(
    command: string[],
    env: Record<string, string | undefined>,
    private readonly handlers: RpcHandlers,
  ) {
    this.proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    void this.readStdout();
    void this.readStderr();
    void this.proc.exited.then((code) => {
      this.exited = true;
      const error = new Error(`The harness process exited (code ${code}).`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.handlers.onExit(code, this.stderrTail);
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  request<T>(method: string, params: Json): Promise<T> {
    if (this.exited) return Promise.reject(new Error("The harness process is not running."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: Json) => void, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: Json): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  kill(): void {
    if (!this.exited) this.proc.kill();
  }

  private write(message: RpcMessage): void {
    if (this.exited) return;
    this.proc.stdin.write(JSON.stringify(message) + "\n");
    void this.proc.stdin.flush();
  }

  private async readStdout(): Promise<void> {
    for await (const line of lines(this.proc.stdout)) {
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private async readStderr(): Promise<void> {
    for await (const line of lines(this.proc.stderr)) {
      this.stderrTail = (this.stderrTail + line + "\n").slice(-4000);
    }
  }

  private dispatch(message: RpcMessage): void {
    if (message.method !== undefined && message.id !== undefined) {
      const id = message.id;
      this.handlers
        .onRequest(message.method, message.params)
        .then((result) => this.write({ id, result }))
        .catch((error: unknown) => {
          const code = error instanceof RpcError ? error.code : -32603;
          const text = error instanceof Error ? error.message : String(error);
          this.write({ id, error: { code, message: text } });
        });
      return;
    }
    if (message.method !== undefined) {
      this.handlers.onNotification(message.method, message.params);
      return;
    }
    if (typeof message.id === "number") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new RpcError(message.error.code, message.error.message));
      else waiter.resolve(message.result);
    }
  }
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line) yield line;
    }
  }
  const rest = buffer.trim();
  if (rest) yield rest;
}
