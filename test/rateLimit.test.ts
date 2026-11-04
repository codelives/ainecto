import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseRetryAfter, rateLimitDetails } from "../src/core/http/rateLimit";
import { AttachmentUploadError, uploadAttachments } from "../src/core/upload/attachmentUpload";
import { McpRpcClient, McpRpcError, RateLimitedError } from "../src/core/mcp/rpcClient";
import { runStdioBridge } from "../src/core/mcp/stdioBridge";

const ENDPOINT = "https://ainecto.com/mcp";
const NOW = Date.parse("2026-11-03T00:00:00Z");

describe("Retry-After", () => {
  it("reads integer seconds and HTTP-date, and never turns a missing or broken value into «retry now»", () => {
    expect(parseRetryAfter("30", NOW)).toBe(30);
    expect(parseRetryAfter(" 0 ", NOW)).toBe(0);
    expect(parseRetryAfter("Tue, 03 Nov 2026 00:00:45 GMT", NOW)).toBe(45);
    expect(parseRetryAfter("Mon, 02 Nov 2026 23:00:00 GMT", NOW)).toBe(0);
    expect(parseRetryAfter(null, NOW)).toBeUndefined();
    expect(parseRetryAfter("-5", NOW)).toBeUndefined();
    expect(parseRetryAfter("soon", NOW)).toBeUndefined();
    expect(parseRetryAfter("1.5", NOW)).toBeUndefined();
  });

  it("prefers the typed body fields over the header and carries scope·policy", () => {
    expect(rateLimitDetails("99", { code: "RATE_LIMITED", retryAfterSeconds: 7, scope: "CLIENT", policyId: "mcp-client" }, NOW))
      .toEqual({ status: 429, retryAfterSeconds: 7, retryAt: "2026-11-03T00:00:07.000Z", scope: "CLIENT", policyId: "mcp-client" });
    expect(rateLimitDetails(null, "<html>", NOW)).toEqual({ status: 429 });
  });

  it("★a wait past what a Date can hold (huge header·Infinity·huge body) is «unknown» — never a throw", () => {
    const huge = "100000000000000000000";
    const infinite = "9".repeat(400);
    expect(Number(infinite)).toBe(Infinity);
    expect(parseRetryAfter(huge, NOW)).toBeUndefined();
    expect(parseRetryAfter(infinite, NOW)).toBeUndefined();
    expect(rateLimitDetails(huge, undefined, NOW)).toEqual({ status: 429 });
    expect(rateLimitDetails(infinite, undefined, NOW)).toEqual({ status: 429 });
    expect(rateLimitDetails(null, { retryAfterSeconds: 1e20, scope: "USER" }, NOW)).toEqual({ status: 429, scope: "USER" });
    // 본문이 범위 밖이면 본문은 없는 것 — 헤더의 정상 값은 그대로 쓴다.
    expect(rateLimitDetails("5", { retryAfterSeconds: 1e20 }, NOW))
      .toEqual({ status: 429, retryAfterSeconds: 5, retryAt: "2026-11-03T00:00:05.000Z" });
  });
});

describe("attachment PUT on 429", () => {
  it("★a 429 with a wait past the Date range is sent once and ends as RATE_LIMITED (never the network retry path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ainecto-rate-limit-test-"));
    const path = join(dir, "notes.txt");
    writeFileSync(path, "hello");
    let puts = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts += 1;
        return new Response(JSON.stringify({ code: "RATE_LIMITED", retryAfterSeconds: 1e20 }),
          { status: 429, headers: { "retry-after": "100000000000000000000" } });
      }
      const body = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
        token: "upload-token-redacted", uploadUrl: "https://uploads.example.test/put", storageKey: "k",
      } }));
    }) as unknown as typeof fetch;
    const rpc = new McpRpcClient({ endpoint: ENDPOINT, fetchImpl, channel: "cli" });

    const failure = await uploadAttachments(rpc, { documentUuid: "doc-1", files: [{ path }], fetchImpl })
      .catch((error: unknown) => error);

    expect(puts).toBe(1);
    expect(failure).toBeInstanceOf(AttachmentUploadError);
    expect(failure).toMatchObject({ code: "RATE_LIMITED", details: { status: 429 } });
    expect((failure as AttachmentUploadError).details).not.toHaveProperty("retryAfterSeconds");
  });
});

function client(answer: () => Response) {
  const fetchImpl = vi.fn(async () => answer()) as unknown as typeof fetch;
  return { fetchImpl, rpc: new McpRpcClient({ endpoint: ENDPOINT, fetchImpl, channel: "cli" }) };
}

const envelope = (data: Record<string, unknown>) => JSON.stringify({
  jsonrpc: "2.0", id: 1, error: { code: 429, message: "Too many requests. Retry after 20 seconds.", data },
});

describe("McpRpcClient on 429", () => {
  it("★HTTP 429 from an edge (no JSON-RPC body) is a structured RateLimitedError, sent once", async () => {
    const { fetchImpl, rpc } = client(() => new Response("<html>slow down</html>", { status: 429, headers: { "retry-after": "20" } }));
    const failure = await rpc.toolsCall("list_projects", {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RateLimitedError);
    expect(failure).toBeInstanceOf(McpRpcError);
    expect((failure as RateLimitedError).code).toBe("RATE_LIMITED");
    expect((failure as RateLimitedError).rateLimit).toMatchObject({ status: 429, retryAfterSeconds: 20 });
    expect((failure as Error).message).toContain("Retry after 20 seconds");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("★HTTP 429 with the server's JSON-RPC envelope: sendRaw hands the envelope through (header wait filled in), request() throws RateLimitedError", async () => {
    const { rpc } = client(() => new Response(envelope({ code: "RATE_LIMITED", scope: "OPERATION", policyId: "mcp-client-tool" }),
      { status: 429, headers: { "retry-after": "20" } }));
    const raw = await rpc.sendRaw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    expect(raw).toMatchObject({ error: { code: 429, data: { code: "RATE_LIMITED", retryAfterSeconds: 20 } } });

    const failure = await rpc.toolsCall("list_projects", {}).catch((error: unknown) => error);
    expect((failure as RateLimitedError).rateLimit).toMatchObject({ retryAfterSeconds: 20, scope: "OPERATION", policyId: "mcp-client-tool" });
  });

  it("★the in-tool JSON-RPC 429 inside HTTP 200 is the same RateLimitedError; other tool errors stay MCP_ERROR", async () => {
    const limited = client(() => new Response(envelope({ code: "RATE_LIMITED", retryAfterSeconds: 9, scope: "OPERATION", policyId: "search" })));
    await expect(limited.rpc.toolsCall("search_documents", {})).rejects.toMatchObject({ code: "RATE_LIMITED", rateLimit: { retryAfterSeconds: 9 } });
    expect(limited.fetchImpl).toHaveBeenCalledTimes(1);

    const forbidden = client(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 403, message: "no", data: { code: "X" } } })));
    await expect(forbidden.rpc.toolsCall("x", {})).rejects.toMatchObject({ code: "MCP_ERROR" });
  });

  it("★HTTP 403 with the server's JSON-RPC envelope is handed through like HTTP 200 — the bridge passes the server's words on", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 403, message: "no", data: { code: "X" } } });
    const { rpc } = client(() => new Response(body, { status: 403 }));
    await expect(rpc.sendRaw({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }))
      .resolves.toMatchObject({ error: { code: 403, message: "no", data: { code: "X" } } });
    await expect(rpc.toolsCall("x", {})).rejects.toMatchObject({ code: "MCP_ERROR", message: "X: no" });
  });

  it("★a 429 is not a sign-in failure — no token refresh is attempted", async () => {
    const refreshAfterUnauthorized = vi.fn(async () => "new");
    const fetchImpl = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "5" } })) as unknown as typeof fetch;
    const rpc = new McpRpcClient({
      endpoint: ENDPOINT, fetchImpl, channel: "cli",
      tokenProvider: { getAccessToken: async () => "t", refreshAfterUnauthorized },
    });
    await expect(rpc.toolsList()).rejects.toBeInstanceOf(RateLimitedError);
    expect(refreshAfterUnauthorized).not.toHaveBeenCalled();
  });
});

describe("stdio bridge on 429", () => {
  async function bridge(answer: () => Response): Promise<Record<string, unknown>> {
    const { rpc } = client(answer);
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const done = runStdioBridge({ input, output, errorOutput: new PassThrough(), client: rpc });
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_projects" } })}\n`);
    await done;
    return JSON.parse(chunks.join("").trim()) as Record<string, unknown>;
  }

  it("passes the server's envelope through to the host with the wait", async () => {
    const line = await bridge(() => new Response(envelope({ code: "RATE_LIMITED" }), { status: 429, headers: { "retry-after": "20" } }));
    expect(line).toMatchObject({ id: 1, error: { code: 429, data: { code: "RATE_LIMITED", retryAfterSeconds: 20 } } });
  });

  it("answers an edge 429 with the same JSON-RPC code 429 (not «internal error») and the original id", async () => {
    const line = await bridge(() => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }));
    expect(line).toMatchObject({ id: 7, error: { code: 429, data: { code: "RATE_LIMITED", status: 429, retryAfterSeconds: 3 } } });
  });
});
