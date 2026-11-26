// Stdio MCP bridge (`staf mcp-bridge`) that forwards newline-delimited JSON-RPC
// messages from a harness over HTTP to the local Staf host with a scoped run token.

import { resolveServerUrl } from "../config.ts";
import { lines } from "../harness/rpc.ts";

export interface McpBridgeArgs {
  token: string;
  url: string;
}

export function parseBridgeArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): McpBridgeArgs {
  let token = env.STAF_RUN_TOKEN ?? "";
  let url = "";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--token" && i + 1 < args.length) {
      token = args[++i]!;
    } else if (flag === "--url" && i + 1 < args.length) {
      url = args[++i]!;
    }
  }
  const serverUrl = (url || resolveServerUrl(env)).replace(/\/$/, "");
  if (!token.trim()) {
    throw new Error("staf mcp-bridge requires a run token via --token or STAF_RUN_TOKEN.");
  }
  return { token: token.trim(), url: serverUrl };
}

/**
 * Runs the stdio JSON-RPC bridge until stdin closes.
 * Never writes anything other than JSON-RPC frames to stdout.
 */
export async function runMcpBridge(args: string[]): Promise<number> {
  const { token, url } = parseBridgeArgs(args);
  const endpoint = `${url}/api/mcp`;

  const writeLine = (message: unknown) => {
    process.stdout.write(JSON.stringify(message) + "\n");
  };

  for await (const line of lines(Bun.stdin.stream())) {
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        writeLine({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request." } });
        continue;
      }
      parsed = value as Record<string, unknown>;
    } catch {
      writeLine({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
      continue;
    }

    const hasId = parsed.id !== undefined;
    const id = hasId ? (parsed.id as string | number | null) : null;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-staf-client": "mcp-bridge",
        },
        body: line,
      });

      if (response.status === 202 || response.status === 204) {
        continue;
      }

      const bodyText = await response.text();
      if (!response.ok) {
        if (!hasId) continue;
        let message = `Staf MCP request failed (${response.status}).`;
        try {
          const err = JSON.parse(bodyText) as { error?: unknown };
          if (typeof err.error === "string" && err.error) message = err.error;
        } catch {
          if (bodyText.trim()) message = bodyText.trim();
        }
        writeLine({ jsonrpc: "2.0", id, error: { code: -32000, message } });
        continue;
      }

      if (bodyText.trim()) {
        process.stdout.write(bodyText.trim() + "\n");
      }
    } catch (error) {
      if (!hasId) continue;
      const reason = error instanceof Error ? error.message : String(error);
      writeLine({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `Could not reach Staf host at ${url}: ${reason}` },
      });
    }
  }

  return 0;
}
