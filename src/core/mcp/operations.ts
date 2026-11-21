import type { JsonSchema } from "../catalog/types";
import { toolErrorText, unwrapMcpToolPayload } from "./toolPayload";

/**
 * ★서버 MCP 공개면 = {@code search} + {@code execute_*} 6개 + {@code open_ainecto_panel}(2026-11-21 rollout-today.md · 루트 결재 c30114b9).
 * 108개 operation 은 이름으로 직접 부르지 않는다 — {@code <executor> {operation, args}} 로 부른다. 옛 이름으로 부르면 서버가 거절한다(별칭 없음).
 *
 * 이 파일이 CLI 에서 그 공개면을 아는 한 곳이다:
 * <ul>
 *   <li>★공개 도구 이름은 CLI 에 두지 않는다 — 서버 {@code tools/list} 가 진실원이다(RPC 클라이언트가 연결당 한 번 받는다).
 *       CLI 가 아는 이름은 목록·상세를 묻는 {@link SEARCH_TOOL} 하나뿐이다.</li>
 *   <li>{@code search} 목록·상세 응답 읽기({@link parseOperationPage} · {@link parseOperationDetail}) — 모양이 바뀌면 여기만 고친다.</li>
 *   <li>operation → 어느 실행 도구로 부르나({@link OperationCaller}) — ★작업마다 실행 도구는 하나다(Ryan 11-21 «ㅇㅇ 그렇게 가자»).
 *       그 표(api {@code mcp/operation-executors.json})를 CLI 에 두지 않는다 — search 상세의 {@code executor} 를 쓴다.</li>
 * </ul>
 */

export const SEARCH_TOOL = "search";

/** {@code search} 목록 한 줄 — operation 과 목록용 한 줄 설명(태그는 응답에 없다). */
export interface OperationLine {
  operation: string;
  summary: string;
}

export interface OperationPage {
  items: OperationLine[];
  nextCursor?: string;
}

/** {@code search {operation}} 상세 — 이 operation 을 부르는 실행 도구 하나 · 힌트 · inputSchema. */
export interface OperationDetail {
  operation: string;
  summary: string;
  /** 이 operation 을 부르는 공개 실행 도구 이름(서버가 정한 그대로). */
  executor: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  inputSchema: JsonSchema;
}

export class OperationError extends Error {
  constructor(message: string, readonly code: string, readonly operation: string, readonly details?: unknown) {
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
 * {@code search {operation}} 결과(도구 결과 그대로) → 상세. 모양(chat-dev 확정 11-21 · api 1f2290f3):
 * {@code {"operation","summary","executor":"execute_…","annotations":{…},"inputSchema":{…}}}.
 * 실행 도구 이름이 없으면 실패 — 이름은 서버가 정한 그대로 쓴다.
 */
export function parseOperationDetail(operation: string, result: unknown): OperationDetail {
  const payload = unwrapMcpToolPayload(result);
  if (!isRecord(payload) || payload.operation !== operation) {
    throw new OperationError(`search did not return the detail of ${operation}.`, "MCP_PROTOCOL_ERROR", operation);
  }
  const executor = payload.executor;
  if (typeof executor !== "string" || executor.trim() === "") {
    throw new OperationError(`search detail of ${operation} has no valid executor (${JSON.stringify(executor)}).`,
      "MCP_PROTOCOL_ERROR", operation);
  }
  const hints = isRecord(payload.annotations) ? payload.annotations : {};
  return {
    operation,
    summary: typeof payload.summary === "string" ? payload.summary : "",
    executor,
    annotations: {
      ...(typeof hints.readOnlyHint === "boolean" ? { readOnlyHint: hints.readOnlyHint } : {}),
      ...(typeof hints.destructiveHint === "boolean" ? { destructiveHint: hints.destructiveHint } : {}),
      ...(typeof hints.idempotentHint === "boolean" ? { idempotentHint: hints.idempotentHint } : {}),
      ...(typeof hints.openWorldHint === "boolean" ? { openWorldHint: hints.openWorldHint } : {}),
    },
    inputSchema: isRecord(payload.inputSchema) ? payload.inputSchema : { type: "object", properties: {} },
  };
}

/** search 한 쪽 최대(서버 계약 — 기본 20 · 최대 50). */
export const SEARCH_PAGE_MAX = 50;
/** 전체 목록을 넘길 때 쪽 수 상한 — 서버가 cursor 를 끝없이 주어도 멈춘다(108개 ÷ 50 = 3쪽). */
const MAX_PAGES = 20;

/**
 * search 도구 정의(tools/list 의 한 항목)에서 두 필수 축({@code action}·{@code object})의 어휘 전부 — 정규값 + 별칭.
 * 서버는 축 안을 OR 로 묶으므로 어휘 전부를 주면 모든 operation 이 나온다(별칭과 정규값을 같이 줘도 중복으로 거절하지 않는다).
 */
export function searchVocabulary(searchTool: unknown): { action: string[]; object: string[] } {
  const props = isRecord(searchTool) && isRecord(searchTool.inputSchema) && isRecord(searchTool.inputSchema.properties)
    ? searchTool.inputSchema.properties : {};
  const values = (facet: string): string[] => {
    const prop = props[facet];
    const items = isRecord(prop) && isRecord(prop.items) ? prop.items : {};
    return Array.isArray(items.enum) ? items.enum.filter((value): value is string => typeof value === "string") : [];
  };
  const vocabulary = { action: values("action"), object: values("object") };
  if (vocabulary.action.length === 0 || vocabulary.object.length === 0) {
    throw new OperationError("tools/list has no search tool with action/object vocabularies.", "MCP_PROTOCOL_ERROR", SEARCH_TOOL);
  }
  return vocabulary;
}

/** 서버의 지금 operation 전부 — tools/list 의 search 어휘로 search 를 불러 모든 쪽을 넘긴다(이름순 · 중복 없이). */
export async function listAllOperations(input: {
  toolsList: () => Promise<unknown[]>;
  callPublic: PublicToolCall;
}): Promise<OperationLine[]> {
  const vocabulary = searchVocabulary((await input.toolsList()).find((tool) => isRecord(tool) && tool.name === SEARCH_TOOL));
  const byName = new Map<string, OperationLine>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = parseOperationPage(await input.callPublic(SEARCH_TOOL, { ...vocabulary, limit: SEARCH_PAGE_MAX, ...(cursor ? { cursor } : {}) }));
    for (const line of result.items) if (!byName.has(line.operation)) byName.set(line.operation, line);
    cursor = result.nextCursor;
    if (!cursor) return [...byName.values()].sort((a, b) => a.operation.localeCompare(b.operation));
  }
  throw new OperationError(`search kept returning a next page after ${MAX_PAGES} pages.`, "MCP_PROTOCOL_ERROR", SEARCH_TOOL);
}

/** 공개 도구 하나를 부르는 함수 — RPC 클라이언트가 준다(로그·오류 분류는 그쪽 책임). */
export type PublicToolCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * operation 이름 + 인자 → {@code <executor> {operation, args}}. 상세는 연결 하나에서 한 번만 묻는다(같은 연결의 다음 호출은 기억한 값).
 * 서버 거절(UNKNOWN_OPERATION·BUNDLE_MISMATCH 등)은 다시 부르지 않고 그대로 올린다.
 */
export class OperationCaller {
  private readonly details = new Map<string, Promise<OperationDetail>>();

  constructor(private readonly callPublic: PublicToolCall) {}

  detail(operation: string): Promise<OperationDetail> {
    let found = this.details.get(operation);
    if (!found) {
      found = this.callPublic(SEARCH_TOOL, { operation }).then((result) => {
        // ★서버가 도구 결과로 거절했으면 그 사유·코드를 그대로 올린다 — «모르는 작업»으로 덮지 않는다(리뷰 r1 P1-6).
        if (isRecord(result) && result.isError === true) throw toolRefusal(operation, result);
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
    return this.callPublic(detail.executor, { operation, args });
  }
}

/** isError 결과 → 서버 글 그대로의 오류. 글이 JSON 이고 {@code code} 가 있으면 그 코드, 없으면 MCP_TOOL_ERROR. 원본 결과는 details 에. */
function toolRefusal(operation: string, result: Record<string, unknown>): OperationError {
  const text = toolErrorText(result);
  let code = "MCP_TOOL_ERROR";
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.code === "string" && parsed.code) code = parsed.code;
  } catch {
    // 글이 JSON 이 아니다 — 글 그대로 싣는다.
  }
  return new OperationError(`search refused the detail of ${operation}: ${text}`, code, operation, result);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
