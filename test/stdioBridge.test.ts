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
    const client = new McpRpcClient({ endpoint: "https://dev.ainecto.com/mcp", fetchImpl });
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
});
