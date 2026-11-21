import { vi } from "vitest";

type FetchHandler = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 시험용 서버 공개면 — 이름은 서버 계약(rollout-today.md + 결재 c30114b9). CLI 소스에는 이 사본이 없다(진실원 = 서버 tools/list). */
export const TEST_PUBLIC_TOOLS = [
  "search", "execute_read", "execute_edit", "execute_collaborate", "execute_replace_remove", "execute_access", "execute_publish",
  "open_ainecto_panel",
];

/**
 * 공개면 8개 서버의 가짜 앞단 — 옛 이름으로 짠 가짜 서버(handler)를 그대로 쓰게 한다.
 * <ul>
 *   <li>{@code tools/list} → 공개 도구 8개(search 는 action/object 어휘 한 개씩) — handler 에는 가지 않는다.</li>
 *   <li>{@code search {operation}} → 상세(실행 도구는 {@code executors} 에서, 없으면 execute_read) · 목록 질의 → 빈 목록.</li>
 *   <li>{@code execute_* {operation, args}} → {@code tools/call {name: operation, arguments: args}} 로 풀어 handler 에 넘긴다.</li>
 *   <li>그 밖(initialize·HTTP PUT 등)은 그대로 넘긴다.</li>
 * </ul>
 * 실제 선 위 모양(tools/list → search 상세 → 실행 도구)은 test/operations.test.ts 가 본다.
 */
export function operationServer(handler: FetchHandler, executors: Record<string, string> = {}): FetchHandler {
  return async (url, init) => {
    const body = parseBody(init?.body);
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: body?.id, result }));
    const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
    if (body?.method === "tools/list") {
      return reply({ tools: TEST_PUBLIC_TOOLS.map((name) => name === "search"
        ? { name, inputSchema: { type: "object", properties: {
          action: { type: "array", items: { type: "string", enum: ["read"] } },
          object: { type: "array", items: { type: "string", enum: ["document"] } } } } }
        : { name }) });
    }
    if (body?.method !== "tools/call" || !isRecord(body.params)) return handler(url, init);
    const name = body.params.name;
    const args = isRecord(body.params.arguments) ? body.params.arguments : {};
    if (name === "search") {
      return reply(typeof args.operation === "string"
        ? text({ operation: args.operation, summary: "", executor: executors[args.operation] ?? "execute_read",
          annotations: {}, inputSchema: { type: "object", properties: {} } })
        : text({ items: [], nextCursor: null }));
    }
    if (typeof name === "string" && name.startsWith("execute_") && typeof args.operation === "string") {
      const inner = { ...body, params: { name: args.operation, arguments: isRecord(args.args) ? args.args : {} } };
      return handler(url, { ...init, body: JSON.stringify(inner) });
    }
    return handler(url, init);
  };
}

/** {@code vi.stubGlobal("fetch", fn)} 대신 — fn(옛 이름 가짜 서버) 앞에 {@link operationServer} 를 세운다. fn 의 호출 수는 operation 호출만 센다. */
export function stubOperationFetch(fn: FetchHandler, executors: Record<string, string> = {}): void {
  vi.stubGlobal("fetch", operationServer(fn, executors));
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
