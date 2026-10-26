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

  it.each([
    [400, "AGENT_NAME_INVALID", "Agent name must match [a-z0-9][a-z0-9._-]*"],
    [409, "AGENT_LIMIT", "This account already has 50 agents in use."],
  ])("answers a refused initialize (HTTP %i) with the request's own id and the server's error", async (status, code, description) => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: code, error_description: description }),
      { status, headers: { "content-type": "application/json" } }));
    const client = new McpRpcClient({ endpoint: "https://dev.ainecto.com/mcp", fetchImpl, channel: "mcp", agentName: "Bad Name" });
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "2.1.310" } } })}\n`);

    await runStdioBridge({ input, output, errorOutput: new PassThrough(), client });

    const lines = chunks.join("").trim().split("\n");
    expect(lines).toHaveLength(1);
    const reply = JSON.parse(lines[0] ?? "");
    expect(reply.id).toBe(0);
    expect(reply.error.code).toBe(-32603);
    expect(reply.error.message).toContain(`HTTP ${status}`);
    expect(reply.error.message).toContain(`${code}: ${description}`);
    expect(reply.error.data).toMatchObject({ code: "MCP_HTTP_ERROR", status, error: code });
  });

  it("does not answer a failed notification and answers an unreadable line with id null", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 }));
    const client = new McpRpcClient({ endpoint: "https://dev.ainecto.com/mcp", fetchImpl, channel: "mcp" });
    const input = new PassThrough();
    const output = new PassThrough();
    const errorOutput = new PassThrough();
    const chunks: string[] = [];
    const errors: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    errorOutput.on("data", (chunk) => errors.push(String(chunk)));
    input.end([
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      "{not json",
    ].join("\n") + "\n");

    await runStdioBridge({ input, output, errorOutput, client });

    const replies = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    expect(replies).toEqual([expect.objectContaining({ id: null, error: expect.objectContaining({ code: -32700 }) })]);
    expect(errors.join("")).toContain("HTTP 500");
  });
});
