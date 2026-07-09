import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { McpRpcClient, type JsonRpcRequest } from "./rpcClient";

export interface StdioBridgeOptions {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  client: McpRpcClient;
}

export async function runStdioBridge(options: StdioBridgeOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const request = parseJsonRpcRequest(line);
      const response = await options.client.sendRaw(request);
      if (response && request.id !== undefined) {
        options.output.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.output.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message },
      })}\n`);
    }
  }
}

function parseJsonRpcRequest(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw new Error("Invalid JSON-RPC request.");
  }
  return {
    jsonrpc: "2.0",
    id: typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null ? parsed.id : undefined,
    method: parsed.method,
    params: parsed.params,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
