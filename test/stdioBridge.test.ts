import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { McpRpcClient } from "../src/core/mcp/rpcClient";
import { runStdioBridge } from "../src/core/mcp/stdioBridge";

describe("stdio bridge", () => {
  it("proxies tools/call payloads without interpreting local file references", async () => {
    const requests: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      }));
    });
    const client = new McpRpcClient({ endpoint: "https://dev.ainecto.com/mcp", fetchImpl, channel: "mcp" });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));

    input.end(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "mcp__ainecto__erd_apply_changes",
        arguments: { $file: "./changes.json" },
      },
    })}\n`);

    await runStdioBridge({ input, output, errorOutput: new PassThrough(), client });

    expect(requests).toEqual([{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "mcp__ainecto__erd_apply_changes",
        arguments: { $file: "./changes.json" },
      },
    }]);
    expect(chunks.join("").trim()).toBe(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    }));
  });

  it("reads the host agent's clientInfo.name from initialize and sends it on every request after it", async () => {
    const headers: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
    const client = new McpRpcClient({ endpoint: "https://dev.ainecto.com/mcp", fetchImpl, channel: "mcp" });
    const input = new PassThrough();
    input.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1.0" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "identity_get_self" } }),
    ].join("\n") + "\n");

    await runStdioBridge({ input, output: new PassThrough(), errorOutput: new PassThrough(), client });

    expect(headers).toHaveLength(2);
    for (const sent of headers) {
      expect(sent).toMatchObject({ "x-ainecto-channel": "mcp", "x-ainecto-agent": "claude-code" });
    }
  });
});
