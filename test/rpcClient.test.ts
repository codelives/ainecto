import { describe, expect, it, vi } from "vitest";
import { McpRpcClient } from "../src/core/mcp/rpcClient";

describe("McpRpcClient", () => {
  it("carries the session role on every request, and omits it when unscoped", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    }) as unknown as typeof fetch;

    await new McpRpcClient({ endpoint: "https://ai-erd.com/mcp", fetchImpl, role: "development" }).toolsList();
    expect(seen[0]).toMatchObject({ "x-ai-erd-role": "development" });

    // 역할이 없으면 헤더도 없다 — 하네스를 안 쓰는 연결은 종전 그대로다.
    await new McpRpcClient({ endpoint: "https://ai-erd.com/mcp", fetchImpl, role: null }).toolsList();
    expect(Object.keys(seen[1]!)).not.toContain("x-ai-erd-role");
  });

  it("sends JSON-RPC requests with bearer auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    })));
    const client = new McpRpcClient({
      role: null,
      endpoint: "https://dev.ai-erd.com/mcp",
      fetchImpl,
      tokenProvider: {
        getAccessToken: async () => "redacted-token",
        refreshAfterUnauthorized: async () => undefined,
      },
    });

    await expect(client.toolsList()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("https://dev.ai-erd.com/mcp", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer redacted-token" }),
    }));
  });

  it("refreshes once after 401", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { ok: true },
      })));
    const refreshAfterUnauthorized = vi.fn(async () => "fresh-token");
    const client = new McpRpcClient({
      role: null,
      endpoint: "https://dev.ai-erd.com/mcp",
      fetchImpl,
      tokenProvider: {
        getAccessToken: async () => "old-token",
        refreshAfterUnauthorized,
      },
    });

    await expect(client.request("initialize", {})).resolves.toEqual({ ok: true });
    expect(refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenLastCalledWith("https://dev.ai-erd.com/mcp", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer fresh-token" }),
    }));
  });

  it("omits HTTP error body previews unless debug is enabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("access_token=leaked", { status: 500 }));
    const client = new McpRpcClient({
      role: null,
      endpoint: "https://dev.ai-erd.com/mcp",
      fetchImpl,
      envVars: {},
    });

    await expect(client.request("initialize", {})).rejects.toMatchObject({
      code: "MCP_HTTP_ERROR",
      details: { status: 500 },
    });
    await expect(client.request("initialize", {}).catch((error) => error.details)).resolves.not.toHaveProperty("body");
  });

  it("keeps debug HTTP body previews for explicit diagnostics", async () => {
    const fetchImpl = vi.fn(async () => new Response("access_token=leaked", { status: 500 }));
    const client = new McpRpcClient({
      role: null,
      endpoint: "https://dev.ai-erd.com/mcp",
      fetchImpl,
      envVars: { AINECTO_CLI_DEBUG: "1" },
    });

    await expect(client.request("initialize", {}).catch((error) => error.details)).resolves.toMatchObject({
      status: 500,
      body: "access_token=leaked",
    });
  });
});
