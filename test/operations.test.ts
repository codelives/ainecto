import { describe, expect, it } from "vitest";
import { McpRpcClient, McpRpcError } from "../src/core/mcp/rpcClient";
import { listAllOperations, parseOperationDetail } from "../src/core/mcp/operations";
import { writeToolNames } from "../src/core/agent/documents";
import { codexAppServerArgs } from "../src/core/agent/codexArgs";

const ENDPOINT = "https://dev.ainecto.test/mcp";

interface WireCall { name: string; arguments: Record<string, unknown> }

const PUBLIC = ["search", "execute_read", "execute_edit", "execute_collaborate", "execute_replace_remove", "execute_access",
  "execute_publish", "open_ainecto_panel"];

/**
 * 공개면 8개 서버 — tools/list(공개 이름) · search 상세(executor) · 실행 응답을 테스트가 정한다.
 * 선 위 요청을 순서대로 남긴다(tools/list 는 {@code "tools/list"}, tools/call 은 도구 이름).
 */
function server(options: {
  executors: Record<string, string>;
  execute?: (call: WireCall) => { result?: unknown; error?: unknown };
  search?: (operation: string) => unknown;
  publicTools?: () => { result?: unknown; error?: unknown };
}) {
  const wire: WireCall[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: WireCall };
    const reply = (payload: { result?: unknown; error?: unknown }) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
    if (body.method === "tools/list") {
      wire.push({ name: "tools/list", arguments: {} });
      return reply(options.publicTools?.() ?? { result: { tools: PUBLIC.map((name) => ({ name })) } });
    }
    wire.push(body.params);
    if (body.params.name === "search") {
      const operation = String(body.params.arguments.operation);
      const detail = options.search?.(operation)
        ?? { operation, summary: "s", executor: options.executors[operation], annotations: { readOnlyHint: false }, inputSchema: { type: "object" } };
      return reply({ result: detail && typeof detail === "object" && "isError" in detail
        ? detail : { content: [{ type: "text", text: JSON.stringify(detail) }] } });
    }
    return reply(options.execute?.(body.params) ?? { result: { content: [{ type: "text", text: "{\"ok\":true}" }] } });
  }) as typeof fetch;
  return { wire, rpc: new McpRpcClient({ endpoint: ENDPOINT, fetchImpl, channel: "cli" }) };
}

describe("operation → 실행 도구 (MCP 공개면 8개)", () => {
  it("옛 이름은 search 상세의 executor 로 바꿔 부르고, 공개 이름·상세는 연결 하나에서 한 번만 묻는다", async () => {
    const { wire, rpc } = server({ executors: { identity_get_self: "execute_read" } });

    await rpc.toolsCall("identity_get_self", {});
    await rpc.toolsCall("mcp__ainecto__identity_get_self", { a: 1 });

    expect(wire).toEqual([
      { name: "tools/list", arguments: {} },
      { name: "search", arguments: { operation: "identity_get_self" } },
      { name: "execute_read", arguments: { operation: "identity_get_self", args: {} } },
      { name: "execute_read", arguments: { operation: "identity_get_self", args: { a: 1 } } },
    ]);
  });

  it("★공개 도구 8개는 각각 자기 이름으로 한 번만 간다 — open_ainecto_panel 도 search·execute_read 로 감싸지 않는다 (리뷰 r1 P1-3)", async () => {
    const { wire, rpc } = server({ executors: {} });

    for (const name of PUBLIC) await rpc.toolsCall(name, { x: name });

    expect(wire).toEqual([{ name: "tools/list", arguments: {} }, ...PUBLIC.map((name) => ({ name, arguments: { x: name } }))]);
  });

  it("공개 이름은 서버 목록이 진실원 — 목록에 없는 이름은 operation 으로 본다 · 이미 받은 tools/list 를 다시 묻지 않는다", async () => {
    const { wire, rpc } = server({ executors: { open_ainecto_panel: "execute_read" },
      publicTools: () => ({ result: { tools: [{ name: "search" }, { name: "execute_read" }] } }) });

    await rpc.toolsList();
    await rpc.toolsCall("open_ainecto_panel", {});

    expect(wire.map((call) => call.name)).toEqual(["tools/list", "search", "execute_read"]);
  });

  it("공개 이름을 못 받으면 실패하고, 다음 호출이 다시 묻는다", async () => {
    let fail = true;
    const { wire, rpc } = server({ executors: {},
      publicTools: () => fail ? { error: { code: -32603, message: "down" } } : { result: { tools: [{ name: "search" }] } } });

    await expect(rpc.toolsCall("search", {})).rejects.toBeInstanceOf(McpRpcError);
    fail = false;
    await rpc.toolsCall("search", {});

    expect(wire.map((call) => call.name)).toEqual(["tools/list", "tools/list", "search"]);
  });

  it("서버 거절(BUNDLE_MISMATCH 등)은 다시 부르지 않고 그대로 올린다", async () => {
    const { wire, rpc } = server({
      executors: { create_documents: "execute_edit" },
      execute: () => ({ error: { code: -32602, message: "x",
        data: { code: "BUNDLE_MISMATCH", operation: "create_documents", executor: "execute_publish" } } }),
    });

    const failure = await rpc.toolsCall("create_documents", {}).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpRpcError);
    expect((failure as McpRpcError).message).toContain("BUNDLE_MISMATCH");
    expect(wire.map((call) => call.name)).toEqual(["tools/list", "search", "execute_edit"]);
  });

  it("★상세가 isError 로 거절하면 서버 사유·코드를 그대로 올린다 — UNKNOWN_OPERATION 으로 덮지 않는다 (리뷰 r1 P1-6)", async () => {
    const refusal = { isError: true, content: [{ type: "text", text: JSON.stringify({ code: "RATE_LIMITED", message: "slow down" }) }] };
    const { wire, rpc } = server({ executors: {}, search: () => refusal });

    const failure = await rpc.toolsCall("list_projects", {}).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "RATE_LIMITED", details: refusal });
    expect((failure as Error).message).toContain("slow down");
    expect(wire.map((call) => call.name)).toEqual(["tools/list", "search"]);
  });

  it("상세 거절 글이 JSON 이 아니어도 글 그대로 싣는다", async () => {
    const { rpc } = server({ executors: {}, search: () => ({ isError: true, content: [{ type: "text", text: "no access to that" }] }) });

    await expect(rpc.toolsCall("list_projects", {})).rejects.toMatchObject({ code: "MCP_TOOL_ERROR", message: expect.stringContaining("no access to that") });
  });

  it("상세에 executor 가 없으면 실행하지 않는다 · 실패한 상세는 기억하지 않는다", async () => {
    let executor = "";
    const { wire, rpc } = server({ executors: {}, search: (operation) => ({ operation, executor }) });

    await expect(rpc.toolsCall("list_projects", {})).rejects.toMatchObject({ code: "MCP_PROTOCOL_ERROR" });
    executor = "execute_read";
    await rpc.toolsCall("list_projects", {});

    expect(wire.map((call) => call.name)).toEqual(["tools/list", "search", "search", "execute_read"]);
  });

  it("상세 모양: executor·annotations·inputSchema (chat-dev 확정 11-21 · api 1f2290f3)", () => {
    const detail = parseOperationDetail("create_documents", { content: [{ type: "text", text: JSON.stringify({
      operation: "create_documents", summary: "만든다", executor: "execute_edit",
      annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", required: ["items"] },
    }) }] });

    expect(detail).toEqual({ operation: "create_documents", summary: "만든다", executor: "execute_edit",
      annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", required: ["items"] } });
    expect(() => parseOperationDetail("x", { content: [{ type: "text", text: "{\"operation\":\"y\",\"executor\":\"execute_read\"}" }] }))
      .toThrow(/detail of x/);
  });
});

describe("operation 전체 목록(search)", () => {
  const search = { name: "search", inputSchema: { properties: {
    action: { items: { enum: ["read", "get"] } }, object: { items: { enum: ["card"] } } } } };
  const page = (items: string[], nextCursor?: string) =>
    ({ content: [{ type: "text", text: JSON.stringify({ items: items.map((operation) => ({ operation, summary: operation })), nextCursor }) }] });

  it("어휘 전부로 모든 쪽을 넘겨 이름순·중복 없이 모은다", async () => {
    const asked: unknown[] = [];
    const pages = [page(["b", "a"], "c1"), page(["a", "c"])];
    const lines = await listAllOperations({ toolsList: async () => [{ name: "execute_read" }, search],
      callPublic: async (_tool, args) => { asked.push(args); return pages.shift(); } });

    expect(lines.map((line) => line.operation)).toEqual(["a", "b", "c"]);
    expect(asked).toEqual([{ action: ["read", "get"], object: ["card"], limit: 50 }, { action: ["read", "get"], object: ["card"], limit: 50, cursor: "c1" }]);
  });

  it("search 가 없거나 cursor 가 끝나지 않으면 실패한다(스냅샷으로 대체할 수 있게)", async () => {
    await expect(listAllOperations({ toolsList: async () => [], callPublic: async () => page([]) }))
      .rejects.toMatchObject({ code: "MCP_PROTOCOL_ERROR" });
    await expect(listAllOperations({ toolsList: async () => [search], callPublic: async () => page(["a"], "again") }))
      .rejects.toThrow(/next page after 20 pages/);
  });
});

describe("PC Agent Codex 승인 — 공개면 7개", () => {
  it("readOnlyHint 가 아닌 execute_* 5개만 approve 된다(search·execute_read 는 빠진다)", () => {
    const seven = [
      { name: "search", annotations: { readOnlyHint: true } },
      { name: "execute_read", annotations: { readOnlyHint: true } },
      { name: "execute_edit", annotations: { readOnlyHint: false } },
      { name: "execute_collaborate", annotations: { readOnlyHint: false, openWorldHint: true } },
      { name: "execute_replace_remove", annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "execute_access", annotations: { readOnlyHint: false, destructiveHint: true } },
      { name: "execute_publish", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
    ];

    const args = codexAppServerArgs({ command: "ainecto-mcp", args: [] }, writeToolNames(seven));
    const approvals = args.filter((arg) => arg.endsWith('.approval_mode="approve"'));

    expect(approvals).toEqual([
      'mcp_servers.ainecto.tools.execute_access.approval_mode="approve"',
      'mcp_servers.ainecto.tools.execute_collaborate.approval_mode="approve"',
      'mcp_servers.ainecto.tools.execute_edit.approval_mode="approve"',
      'mcp_servers.ainecto.tools.execute_publish.approval_mode="approve"',
      'mcp_servers.ainecto.tools.execute_replace_remove.approval_mode="approve"',
    ]);
  });
});
