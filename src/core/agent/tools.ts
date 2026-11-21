import { randomUUID } from "node:crypto";
import type { DaemonLog } from "../term/daemonLog";
import { isToolError, McpRpcError } from "../mcp/rpcClient";
import { toolErrorText, unwrapMcpToolPayload } from "../mcp/toolPayload";
import type { AgentId } from "./agents";
import type { AgentLogRecord } from "./log";

/** 도구 호출 실패 — {@code code} 는 서버의 도메인 오류 코드(JSON-RPC {@code data.code})가 있을 때. */
export class AgentToolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly code?: string,
    /** 다시 해 볼 만한가 — 네트워크·5xx. 서버가 거절했으면(4xx·도메인 오류) false. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AgentToolError";
  }
}

/** 서버가 link 를 열 때 그 종류에 이어 준 신원(user_agents) — 종류 + 신원 이름. */
export interface AgentIdentity {
  agent: AgentId;
  name: string;
}

export interface AgentToolCallOptions {
  /**
   * 이 호출을 그 신원으로 부른다 — {@code X-AiNecto-Agent-Name}(신원 이름) + {@code X-AiNecto-Agent}(그 종류의 clientInfo 이름).
   * 없으면 serve 자신(이름 없는 연결).
   */
  as?: AgentIdentity;
}

export interface AgentTools {
  /** 도구 하나를 부른다 — {@code tool} 은 operation 이름(list_agent_todos 등) — RPC 입구가 execute_* 로 바꿔 부른다. 결과는 도구가 돌려준 JSON 객체. */
  call(tool: string, args: Record<string, unknown>, options?: AgentToolCallOptions): Promise<Record<string, unknown>>;
  /** 서버 도구 목록(tools/list). */
  list(): Promise<unknown[]>;
}

/** MCP JSON-RPC 클라이언트에서 serve 가 쓰는 두 가지. */
export interface AgentToolClient {
  toolsCall(name: string, args: unknown): Promise<unknown>;
  toolsList(): Promise<unknown[]>;
}

/**
 * ★serve 가 서버 MCP 도구를 부르는 한 입구 — 로그·오류 분류는 여기 책임이고 부르는 곳은 «무엇을»만 안다(http.ts 와 같은 규칙).
 * 호출마다 {@code agent_call} 1줄 + {@code agent_call_response} 1줄(같은 callId, {@code op: "tool"}) — 응답 줄은 finally 에서 반드시.
 * 실패 줄에는 도메인 오류 코드·사유를 남긴다. 인자·결과 본문은 남기지 않는다(바이트 수만).
 */
export function createAgentTools(input: {
  client: AgentToolClient;
  /** {@link AgentToolCallOptions.as} 의 클라이언트 — 그 신원 이름·종류 헤더를 싣는다. */
  clientAs?: (identity: AgentIdentity) => AgentToolClient;
  log: DaemonLog<AgentLogRecord>;
}): AgentTools {
  const asClients = new Map<string, AgentToolClient>();
  const clientFor = (identity: AgentIdentity | undefined): AgentToolClient => {
    if (!identity || !input.clientAs) return input.client;
    const key = `${identity.agent}\u0000${identity.name}`;
    let found = asClients.get(key);
    if (!found) {
      found = input.clientAs(identity);
      asClients.set(key, found);
    }
    return found;
  };

  async function logged<T>(tool: string, bytes: number, run: () => Promise<T>, as?: AgentIdentity): Promise<T> {
    const callId = randomUUID();
    const started = Date.now();
    input.log.write({ event: "agent_call", callId, op: "tool", tool, ...(as ? { agent: as.agent, agentName: as.name } : {}), bytes });
    let outcome: { ok: boolean; code?: string; error?: string } = { ok: false, error: "no response" };
    try {
      const value = await run();
      outcome = { ok: true };
      return value;
    } catch (error) {
      const failure = toToolError(tool, error);
      outcome = { ok: false, ...(failure.code ? { code: failure.code } : {}), error: failure.message };
      throw failure;
    } finally {
      input.log.write({ event: "agent_call_response", callId, op: "tool", tool, ...outcome, ms: Date.now() - started });
    }
  }

  return {
    call(tool, args, options = {}) {
      return logged(tool, Buffer.byteLength(JSON.stringify(args), "utf8"), async () => {
        const raw = await clientFor(options.as).toolsCall(tool, args);
        if (isToolError(raw)) throw new AgentToolError(toolErrorText(raw), tool, codeInText(toolErrorText(raw)));
        const payload = unwrapMcpToolPayload(raw);
        if (!isRecord(payload)) throw new AgentToolError(`${tool} did not return an object.`, tool, "MCP_PROTOCOL_ERROR");
        return payload;
      }, options.as);
    },
    list() {
      return logged("tools/list", 0, () => input.client.toolsList());
    },
  };
}

/** 늘 그 신원으로 부르는 입구 — 할 일 한 건의 모든 호출(임대·카드 동작·글)이 같은 신원이게. */
export function toolsAs(tools: AgentTools, identity: AgentIdentity): AgentTools {
  return {
    call: (tool, args, options) => tools.call(tool, args, { as: identity, ...options }),
    list: () => tools.list(),
  };
}

/** 어떤 실패든 {@link AgentToolError} 로 — 서버가 밝힌 코드({@code data.code})를 살린다. */
function toToolError(tool: string, error: unknown): AgentToolError {
  if (error instanceof AgentToolError) return error;
  if (error instanceof McpRpcError) {
    const details = isRecord(error.details) ? error.details : {};
    const data = isRecord(details.data) ? details.data : {};
    const status = typeof details.status === "number" ? details.status : undefined;
    const code = typeof data.code === "string" ? data.code : typeof details.error === "string" ? details.error : error.code;
    const rpcCode = typeof details.code === "number" ? details.code : undefined;
    return new AgentToolError(error.message, tool, code,
      (status !== undefined && status >= 500) || (rpcCode !== undefined && (rpcCode >= 500 || rpcCode === -32603)));
  }
  // 네트워크·기한 — 서버가 답하지 않았다.
  return new AgentToolError(error instanceof Error ? error.message : String(error), tool, undefined, true);
}

/** isError 결과의 글이 JSON 이면 그 {@code code}. */
function codeInText(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) && typeof parsed.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
