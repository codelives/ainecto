import { describe, expect, it } from "vitest";
import { McpRpcClient, McpRpcError } from "../src/core/mcp/rpcClient";
import { parseOperationDetail } from "../src/core/mcp/operations";
import { writeToolNames } from "../src/core/agent/documents";
import { codexAppServerArgs } from "../src/core/agent/codexArgs";

const ENDPOINT = "https://dev.ainecto.test/mcp";

interface WireCall { name: string; arguments: Record<string, unknown> }

/** 공개면 7개 서버 — search 상세(bundles)와 execute_* 응답을 테스트가 정한다. 선 위 tools/call 을 순서대로 남긴다. */
function server(options: {
  bundles: Record<string, string[]>;
  execute?: (call: WireCall) => { result?: unknown; error?: unknown };
  search?: (operation: string) => unknown;
}) {
  const wire: WireCall[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: WireCall };
    wire.push(body.params);
    const reply = (payload: { result?: unknown; error?: unknown }) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
    if (body.params.name === "search") {
      const operation = String(body.params.arguments.operation);
      const detail = options.search?.(operation)
        ?? { operation, summary: "s", bundles: options.bundles[operation], annotations: { readOnlyHint: false }, inputSchema: { type: "object" } };
      return reply({ result: { content: [{ type: "text", text: JSON.stringify(detail) }] } });
    }
    return reply(options.execute?.(body.params) ?? { result: { content: [{ type: "text", text: "{\"ok\":true}" }] } });
  }) as typeof fetch;
  return { wire, rpc: new McpRpcClient({ endpoint: ENDPOINT, fetchImpl, channel: "cli" }) };
}

describe("operation → execute_* (MCP 7개)", () => {
  it("옛 이름은 search 상세의 묶음으로 바꿔 부르고, 상세는 연결 하나에서 한 번만 묻는다", async () => {
    const { wire, rpc } = server({ bundles: { identity_get_self: ["execute_read"] } });

    await rpc.toolsCall("identity_get_self", {});
    await rpc.toolsCall("mcp__ainecto__identity_get_self", { a: 1 });

    expect(wire).toEqual([
      { name: "search", arguments: { operation: "identity_get_self" } },
      { name: "execute_read", arguments: { operation: "identity_get_self", args: {} } },
      { name: "execute_read", arguments: { operation: "identity_get_self", args: { a: 1 } } },
    ]);
  });

  it("공개 도구 이름은 그대로 간다", async () => {
    const { wire, rpc } = server({ bundles: {} });

    await rpc.toolsCall("execute_edit", { operation: "create_documents", args: {} });

    expect(wire).toEqual([{ name: "execute_edit", arguments: { operation: "create_documents", args: {} } }]);
  });

  it("조건부: 서버가 BUNDLE_MISMATCH 로 필요한 묶음 하나를 밝히면 그것으로 한 번만 다시 부른다", async () => {
    const { wire, rpc } = server({
      bundles: { list_notifications: ["execute_read", "execute_edit"] },
      execute: (call) => call.name === "execute_read"
        ? { error: { code: -32602, message: "needs edit", data: { code: "BUNDLE_MISMATCH", operation: "list_notifications", required: ["execute_edit"] } } }
        : { result: { content: [{ type: "text", text: "{\"items\":[]}" }] } },
    });

    await expect(rpc.toolsCall("list_notifications", { ack: "t" })).resolves.toMatchObject({ content: [{ text: "{\"items\":[]}" }] });
    expect(wire.map((call) => call.name)).toEqual(["search", "execute_read", "execute_edit"]);
  });

  it("★MIXED_EFFECTS(효과 2개 이상)는 다시 부르지 않고 서버 거절을 그대로 올린다", async () => {
    const { wire, rpc } = server({
      bundles: { create_documents: ["execute_edit", "execute_publish"] },
      execute: () => ({ error: { code: -32602, message: "split it",
        data: { code: "MIXED_EFFECTS", operation: "create_documents", required: ["execute_edit", "execute_publish"] } } }),
    });

    const failure = await rpc.toolsCall("create_documents", { items: [{ shareEnabled: true }] }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(McpRpcError);
    expect((failure as McpRpcError).message).toContain("MIXED_EFFECTS");
    expect(wire.map((call) => call.name)).toEqual(["search", "execute_edit"]);
  });

  it("단일 묶음이면 BUNDLE_MISMATCH 여도 다시 부르지 않는다", async () => {
    const { wire, rpc } = server({
      bundles: { get_document: ["execute_read"] },
      execute: () => ({ error: { code: -32602, message: "x", data: { code: "BUNDLE_MISMATCH", required: ["execute_edit"] } } }),
    });

    await expect(rpc.toolsCall("get_document", {})).rejects.toBeInstanceOf(McpRpcError);
    expect(wire.map((call) => call.name)).toEqual(["search", "execute_read"]);
  });

  it("상세가 모르는 묶음을 대면 실행하지 않는다 · 실패한 상세는 기억하지 않는다", async () => {
    let bundles = ["execute_everything"];
    const { wire, rpc } = server({ bundles: {}, search: (operation) => ({ operation, bundles }) });

    await expect(rpc.toolsCall("list_projects", {})).rejects.toMatchObject({ code: "MCP_PROTOCOL_ERROR" });
    bundles = ["execute_read"];
    await rpc.toolsCall("list_projects", {});

    expect(wire.map((call) => call.name)).toEqual(["search", "search", "execute_read"]);
  });

  it("상세 모양: bundles·bundleRule·annotations·inputSchema (chat-dev 확정 11-21)", () => {
    const detail = parseOperationDetail("create_documents", { content: [{ type: "text", text: JSON.stringify({
      operation: "create_documents", summary: "만든다", bundles: ["execute_edit", "execute_publish"], bundleRule: "shareEnabled=true 면 공개",
      annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", required: ["items"] },
    }) }] });

    expect(detail).toEqual({ operation: "create_documents", summary: "만든다", bundles: ["execute_edit", "execute_publish"],
      bundleRule: "shareEnabled=true 면 공개", annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: { type: "object", required: ["items"] } });
    expect(() => parseOperationDetail("x", { content: [{ type: "text", text: "{\"operation\":\"y\",\"bundles\":[\"execute_read\"]}" }] }))
      .toThrow(/detail of x/);
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
