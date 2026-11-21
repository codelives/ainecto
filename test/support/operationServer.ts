import { vi } from "vitest";
import { EXECUTE_TOOLS, type ExecuteTool } from "../../src/core/mcp/operations";

type FetchHandler = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * 공개면 7개 서버의 가짜 앞단 — 옛 이름으로 짠 가짜 서버(handler)를 그대로 쓰게 한다.
 * <ul>
 *   <li>{@code search {operation}} → 상세(묶음은 {@code bundles} 에서, 없으면 execute_read) — handler 에는 가지 않는다.</li>
 *   <li>{@code execute_* {operation, args}} → {@code tools/call {name: operation, arguments: args}} 로 풀어 handler 에 넘긴다.</li>
 *   <li>그 밖(initialize·tools/list·HTTP PUT 등)은 그대로 넘긴다.</li>
 * </ul>
 * 실제 선 위 모양(search 를 먼저 묻고 execute_* 로 부르는지)은 test/operations.test.ts 가 본다.
 */
export function operationServer(handler: FetchHandler, bundles: Record<string, ExecuteTool[]> = {}): FetchHandler {
  return async (url, init) => {
    const body = parseBody(init?.body);
    if (body?.method !== "tools/call" || !isRecord(body.params)) return handler(url, init);
    const name = body.params.name;
    const args = isRecord(body.params.arguments) ? body.params.arguments : {};
    if (name === "search" && typeof args.operation === "string") {
      const detail = { operation: args.operation, summary: "", bundles: bundles[args.operation] ?? ["execute_read"],
        annotations: {}, inputSchema: { type: "object", properties: {} } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(detail) }] } }));
    }
    if (typeof name === "string" && (EXECUTE_TOOLS as readonly string[]).includes(name) && typeof args.operation === "string") {
      const inner = { ...body, params: { name: args.operation, arguments: isRecord(args.args) ? args.args : {} } };
      return handler(url, { ...init, body: JSON.stringify(inner) });
    }
    return handler(url, init);
  };
}

function parseBody(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** {@code vi.stubGlobal("fetch", fn)} 대신 — fn(옛 이름 가짜 서버) 앞에 {@link operationServer} 를 세운다. fn 의 호출 수는 operation 호출만 센다. */
export function stubOperationFetch(fn: FetchHandler, bundles: Record<string, ExecuteTool[]> = {}): void {
  vi.stubGlobal("fetch", operationServer(fn, bundles));
}
