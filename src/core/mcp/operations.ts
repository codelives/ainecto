import type { JsonSchema } from "../catalog/types";
import { unwrapMcpToolPayload } from "./toolPayload";

/**
 * ★서버 MCP 공개면 = {@code search} + {@code execute_*} 6개(2026-11-21 rollout-today.md). 108개 operation 은 이름으로 직접 부르지 않는다 —
 * {@code execute_<묶음> {operation, args}} 로 부른다. 옛 이름으로 부르면 서버가 거절한다(별칭 없음).
 *
 * 이 파일이 CLI 에서 그 공개면을 아는 한 곳이다:
 * <ul>
 *   <li>공개 도구 이름 7개({@link PUBLIC_TOOLS}) — 서버 계약 그대로.</li>
 *   <li>{@code search} 목록·상세 응답 읽기({@link parseOperationPage} · {@link parseOperationDetail}) — 모양이 바뀌면 여기만 고친다.</li>
 *   <li>operation → 어느 {@code execute_*} 로 부르나({@link OperationCaller}) — ★묶음 표를 CLI 에 두지 않는다. 진실원은 서버의 상세 조회다.</li>
 * </ul>
 */

export const SEARCH_TOOL = "search";

export const EXECUTE_TOOLS = [
  "execute_read",
  "execute_edit",
  "execute_collaborate",
  "execute_replace_remove",
  "execute_access",
  "execute_publish",
] as const;

export type ExecuteTool = typeof EXECUTE_TOOLS[number];

export const PUBLIC_TOOLS: readonly string[] = [SEARCH_TOOL, ...EXECUTE_TOOLS];

export function isPublicTool(name: string): boolean {
  return PUBLIC_TOOLS.includes(name);
}

export function isExecuteTool(name: string): name is ExecuteTool {
  return (EXECUTE_TOOLS as readonly string[]).includes(name);
}

/** {@code search} 목록 한 줄 — operation 과 목록용 한 줄 설명(태그는 응답에 없다). */
export interface OperationLine {
  operation: string;
  summary: string;
}

export interface OperationPage {
  items: OperationLine[];
  nextCursor?: string;
}

/** {@code search {operation}} 상세 — 묶음 후보(1개 = 고정, 여럿 = 인자·대상 상태로 서버가 판정) · 힌트 · inputSchema. */
export interface OperationDetail {
  operation: string;
  summary: string;
  bundles: ExecuteTool[];
  /** 조건부만 — 어느 인자에서 어느 묶음이 필요한지 한 줄(Astra 표의 조건 글). */
  bundleRule?: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  inputSchema: JsonSchema;
}

export class OperationError extends Error {
  constructor(message: string, readonly code: string, readonly operation: string) {
    super(message);
    this.name = "OperationError";
  }
}

/** {@code search} 목록 결과(도구 결과 그대로) → 한 쪽. */
export function parseOperationPage(result: unknown): OperationPage {
  const payload = unwrapMcpToolPayload(result);
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new OperationError("search did not return an items array.", "MCP_PROTOCOL_ERROR", SEARCH_TOOL);
  }
  const items = payload.items.flatMap((item): OperationLine[] =>
    isRecord(item) && typeof item.operation === "string"
      ? [{ operation: item.operation, summary: typeof item.summary === "string" ? item.summary : "" }]
      : []);
  const nextCursor = typeof payload.nextCursor === "string" && payload.nextCursor ? payload.nextCursor : undefined;
  return { items, ...(nextCursor ? { nextCursor } : {}) };
}

/**
 * {@code search {operation}} 결과(도구 결과 그대로) → 상세. 모양(chat-dev 확정 11-21):
 * {@code {"operation","summary","bundles":[…],"bundleRule"?,"annotations":{…},"inputSchema":{…}}}.
 * 묶음이 공개 도구 이름이 아니면 실패 — 모르는 이름으로 부르지 않는다.
 */
export function parseOperationDetail(operation: string, result: unknown): OperationDetail {
  const payload = unwrapMcpToolPayload(result);
  if (!isRecord(payload) || payload.operation !== operation) {
    throw new OperationError(`search did not return the detail of ${operation}.`, "MCP_PROTOCOL_ERROR", operation);
  }
  const bundles = Array.isArray(payload.bundles) ? [...new Set(payload.bundles)] : [];
  if (bundles.length === 0 || !bundles.every((bundle): bundle is ExecuteTool => typeof bundle === "string" && isExecuteTool(bundle))) {
    throw new OperationError(`search detail of ${operation} has no valid bundles (${JSON.stringify(payload.bundles)}).`,
      "MCP_PROTOCOL_ERROR", operation);
  }
  const hints = isRecord(payload.annotations) ? payload.annotations : {};
  return {
    operation,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    bundles,
    ...(typeof payload.bundleRule === "string" && payload.bundleRule ? { bundleRule: payload.bundleRule } : {}),
    annotations: {
      ...(typeof hints.readOnlyHint === "boolean" ? { readOnlyHint: hints.readOnlyHint } : {}),
      ...(typeof hints.destructiveHint === "boolean" ? { destructiveHint: hints.destructiveHint } : {}),
      ...(typeof hints.idempotentHint === "boolean" ? { idempotentHint: hints.idempotentHint } : {}),
      ...(typeof hints.openWorldHint === "boolean" ? { openWorldHint: hints.openWorldHint } : {}),
    },
    inputSchema: isRecord(payload.inputSchema) ? payload.inputSchema : { type: "object", properties: {} },
  };
}

/**
 * 서버가 «이 묶음으로는 안 된다, 이것으로 불러라»라고 거절했을 때 그 묶음 — 아니면 undefined.
 * 거절 모양(chat-dev 확정 11-21): JSON-RPC {@code -32602} + {@code data} = {@code {"code":"BUNDLE_MISMATCH","operation","required":["execute_…"]}}.
 * ★{@code MIXED_EFFECTS}(필요한 효과 2개 이상)는 여기서 다시 부르지 않는다 — 서버가 실행하지 않고 «나눠 부르라»고 알리는 거절이라 그대로 올린다.
 */
export function bundleMismatchRetry(error: unknown, tried: ExecuteTool): ExecuteTool | undefined {
  const data = rpcErrorData(error);
  if (data?.code !== "BUNDLE_MISMATCH" || !Array.isArray(data.required) || data.required.length !== 1) return undefined;
  const required = data.required[0];
  return typeof required === "string" && isExecuteTool(required) && required !== tried ? required : undefined;
}

/** McpRpcError.details(= JSON-RPC error) 의 {@code data}. */
function rpcErrorData(error: unknown): Record<string, unknown> | undefined {
  const details = isRecord(error) ? (error as { details?: unknown }).details : undefined;
  return isRecord(details) && isRecord(details.data) ? details.data : undefined;
}

/** 공개 도구 하나를 부르는 함수 — RPC 클라이언트가 준다(로그·오류 분류는 그쪽 책임). */
export type PublicToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * operation 이름 + 인자 → {@code execute_<묶음> {operation, args}}. 상세는 연결 하나에서 한 번만 묻는다(같은 연결의 다음 호출은 기억한 값).
 *
 * <p>묶음이 하나면 그것으로 부른다. 여럿(조건부 23개)이면 서버가 인자로 «필요한 효과 전부»를 판정한다 — 첫 후보로 부르고,
 * {@code BUNDLE_MISMATCH} 로 필요한 묶음 하나를 밝혀 거절하면 그 묶음으로 한 번만 다시 부른다(거절은 실행 전이라 두 번 실행되지 않는다).
 */
export class OperationCaller {
  private readonly details = new Map<string, Promise<OperationDetail>>();

  constructor(private readonly callPublic: PublicToolCall) {}

  detail(operation: string): Promise<OperationDetail> {
    let found = this.details.get(operation);
    if (!found) {
      found = this.callPublic(SEARCH_TOOL, { operation }).then((result) => {
        if (isRecord(result) && result.isError === true) {
          throw new OperationError(`search could not find operation ${operation}.`, "UNKNOWN_OPERATION", operation);
        }
        return parseOperationDetail(operation, result);
      });
      // 실패는 기억하지 않는다 — 다음 호출이 다시 묻는다.
      found.catch(() => this.details.delete(operation));
      this.details.set(operation, found);
    }
    return found;
  }

  async call(operation: string, args: Record<string, unknown>): Promise<unknown> {
    const detail = await this.detail(operation);
    const first = detail.bundles[0] as ExecuteTool;
    const payload = { operation, args };
    try {
      return await this.callPublic(first, payload);
    } catch (error) {
      const retry = detail.bundles.length > 1 ? bundleMismatchRetry(error, first) : undefined;
      if (!retry) throw error;
      return this.callPublic(retry, payload);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
