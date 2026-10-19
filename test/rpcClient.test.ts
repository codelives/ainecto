import { describe, expect, it, vi } from "vitest";
import { agentHeaderValue, MAX_AGENT_NAME_LENGTH, McpRpcClient } from "../src/core/mcp/rpcClient";

describe("McpRpcClient", () => {
  it("names its channel on every request and carries the agent only once the bridge learned it", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    }) as unknown as typeof fetch;

    // 직접 명령 — cli, 에이전트 헤더 없음(셸을 누가 돌렸는지 모른다).
    await new McpRpcClient({ endpoint: "https://ainecto.com/mcp", fetchImpl, channel: "cli" }).toolsList();
    expect(seen[0]).toMatchObject({ "x-ainecto-channel": "cli" });
    expect(Object.keys(seen[0]!)).not.toContain("x-ainecto-agent");

    const bridge = new McpRpcClient({ endpoint: "https://ainecto.com/mcp", fetchImpl, channel: "mcp" });
    bridge.useAgent("claude-code");
    await bridge.toolsList();
    expect(seen[1]).toMatchObject({ "x-ainecto-channel": "mcp", "x-ainecto-agent": "claude-code" });
  });

  it("keeps the agent header a printable ASCII name of at most 100 characters", () => {
    expect(agentHeaderValue(" codex-mcp-client ")).toBe("codex-mcp-client");
    expect(agentHeaderValue("cursor\u00e9\n-vscode")).toBe("cursor-vscode");
    expect(agentHeaderValue("x".repeat(150))).toHaveLength(MAX_AGENT_NAME_LENGTH);
    expect(agentHeaderValue("\u00e9\u00e9")).toBeUndefined();
    expect(agentHeaderValue(42)).toBeUndefined();
    expect(agentHeaderValue(undefined)).toBeUndefined();
  });

  it("carries an old --role value on every request as a record-only header, and omits it otherwise", async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
    }) as unknown as typeof fetch;

    await new McpRpcClient({ endpoint: "https://ainecto.com/mcp", fetchImpl, legacyRole: "foo", channel: "cli" }).toolsList();
    // ★값을 검사하지 않는다 — 모르는 값도 그대로 싣는다(서버는 판정에 안 쓰고 기록만 한다).
    expect(seen[0]).toMatchObject({ "x-ainecto-role": "foo" });

    // 옛 값이 없으면 헤더도 없다.
    await new McpRpcClient({ endpoint: "https://ainecto.com/mcp", fetchImpl, channel: "cli" }).toolsList();
    expect(Object.keys(seen[1]!)).not.toContain("x-ainecto-role");
  });

  it("sends JSON-RPC requests with bearer auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    })));
    const client = new McpRpcClient({
      channel: "cli",
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
      channel: "cli",
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

  it("omits HTTP error body previews unless debug is enabled", async () => {
    const fetchImpl = vi.fn(async () => new Response("access_token=leaked", { status: 500 }));
    const client = new McpRpcClient({
      channel: "cli",
      endpoint: "https://dev.ainecto.com/mcp",
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
      channel: "cli",
      endpoint: "https://dev.ainecto.com/mcp",
      fetchImpl,
      envVars: { AINECTO_CLI_DEBUG: "1" },
    });

    await expect(client.request("initialize", {}).catch((error) => error.details)).resolves.toMatchObject({
      status: 500,
      body: "access_token=leaked",
    });
  });
});
