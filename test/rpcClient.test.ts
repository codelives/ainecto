import { describe, expect, it, vi } from "vitest";
import { McpRpcClient } from "../src/core/mcp/rpcClient";

describe("McpRpcClient", () => {
  it("sends JSON-RPC requests with bearer auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    })));
    const client = new McpRpcClient({
      endpoint: "https://dev.ainecto.com/mcp",
      fetchImpl,
      tokenProvider: {
        getAccessToken: async () => "redacted-token",
        refreshAfterUnauthorized: async () => undefined,
      },
    });

    await expect(client.toolsList()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("https://dev.ainecto.com/mcp", expect.objectContaining({
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
      endpoint: "https://dev.ainecto.com/mcp",
      fetchImpl,
      tokenProvider: {
        getAccessToken: async () => "old-token",
        refreshAfterUnauthorized,
      },
    });

    await expect(client.request("initialize", {})).resolves.toEqual({ ok: true });
    expect(refreshAfterUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenLastCalledWith("https://dev.ainecto.com/mcp", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer fresh-token" }),
    }));
  });
});
