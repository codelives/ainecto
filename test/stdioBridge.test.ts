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

/**
 * ★읽기만 브리지(리뷰 R2-b P0-2·P0-3 · 루트 판정 REQ 3644d7b6) — Room 차례의 쓰기 차단은 브리지 한 곳이 지킨다(세 엔진 공통).
 * 목록 노출과 호출 둘 다 ★지금 서버 목록의 readOnlyHint === true 로 거른다 — 표시 없음 = 쓰기 = 막음.
 */
describe("stdio bridge — read-only session (project room)", () => {
  /** 격리된 시험 서버 — 도구 목록은 바꿀 수 있고, tools/call 처리기 호출을 이름마다 센다. */
  const fakeServer = (tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>, listFails = false) => {
    const handled: string[] = [];
    let lists = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params?: { name?: string } };
      if (body.method === "tools/list") {
        lists += 1;
        if (listFails) return new Response("upstream down", { status: 503 });
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: tools.map((t) => ({ ...t })) } }));
      }
      if (body.method === "tools/call") handled.push(String(body.params?.name));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "ok" }] } }));
    });
    return { client: new McpRpcClient({ endpoint: "https://dev.ainecto.com/mcp", fetchImpl, channel: "mcp" }), handled, lists: () => lists };
  };
  const run = async (client: McpRpcClient, readOnly: boolean, lines: unknown[], between?: (index: number) => void) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answers: Array<{ id: number; result?: { tools?: Array<{ name: string }> }; error?: { code: number; message: string } }> = [];
    output.on("data", (chunk) => String(chunk).trim().split("\n").filter(Boolean).forEach((l) => answers.push(JSON.parse(l))));
    const done = runStdioBridge({ input, output, errorOutput: new PassThrough(), client, readOnly });
    for (const [index, line] of lines.entries()) {
      input.write(`${JSON.stringify(line)}\n`);
      await vi.waitFor(() => expect(answers.length).toBe(index + 1));
      between?.(index);
    }
    input.end();
    await done;
    return answers;
  };
  const call = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
  const SERVER_TOOLS = () => [
    { name: "search", annotations: { readOnlyHint: true } },
    { name: "execute_read", annotations: { readOnlyHint: true } },
    { name: "execute_edit", annotations: { readOnlyHint: false } },
    { name: "open_ainecto_panel" },   // 표시 없음 = 쓰기
  ];

  it("★Room: tools/list 는 읽기 도구만 · 읽기 호출은 서버에 닿고 쓰기·표시 없는 도구 처리기 호출은 0", async () => {
    const server = fakeServer(SERVER_TOOLS());
    const answers = await run(server.client, true, [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      call(2, "execute_read"),
      call(3, "execute_edit"),
      call(4, "open_ainecto_panel"),
      call(5, "search"),
    ]);
    expect(answers[0]!.result!.tools!.map((t) => t.name)).toEqual(["search", "execute_read"]);
    expect(server.handled).toEqual(["execute_read", "search"]);
    expect(answers.slice(2, 4).map((a) => [a.id, a.error?.code])).toEqual([[3, -32602], [4, -32602]]);
    expect(answers[2]!.error!.message).toContain("this session can only read AiNecto");
  });

  it("★Room: 실행 중 서버 목록이 바뀌면 그 다음 호출부터 지금 목록대로 — 읽기였다가 쓰기로 바뀐 이름도, 새로 생긴 쓰기 도구도 막는다", async () => {
    const tools = SERVER_TOOLS();
    const server = fakeServer(tools);
    const answers = await run(server.client, true, [
      call(1, "execute_read"),
      call(2, "execute_read"),
      call(3, "create_documents"),
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
    ], (index) => {
      if (index === 0) {
        tools[1] = { name: "execute_read", annotations: { readOnlyHint: false } };
        tools.push({ name: "create_documents", annotations: { readOnlyHint: false } });
      }
    });
    expect(server.handled).toEqual(["execute_read"]);
    expect(answers.map((a) => a.error?.code ?? "ok")).toEqual(["ok", -32602, -32602, "ok"]);
    expect(answers[3]!.result!.tools!.map((t) => t.name)).toEqual(["search"]);
  });

  it("Room: 지금 목록을 못 읽으면 보내지 않는다(그 요청 id 로 오류)", async () => {
    const server = fakeServer(SERVER_TOOLS(), true);
    const answers = await run(server.client, true, [call(7, "search")]);
    expect(server.handled).toEqual([]);
    expect(answers[0]!.id).toBe(7);
    expect(answers[0]!.error).toBeDefined();
  });

  it("Connect(읽기만 아님)는 예전 그대로 — 목록은 거르지 않고 쓰기 호출도 서버로, 호출 전 목록 조회도 없다", async () => {
    const server = fakeServer(SERVER_TOOLS());
    const answers = await run(server.client, false, [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      call(2, "execute_edit"),
      call(3, "open_ainecto_panel"),
    ]);
    expect(answers[0]!.result!.tools!.map((t) => t.name)).toEqual(["search", "execute_read", "execute_edit", "open_ainecto_panel"]);
    expect(server.handled).toEqual(["execute_edit", "open_ainecto_panel"]);
    expect(server.lists()).toBe(1);
  });
});
