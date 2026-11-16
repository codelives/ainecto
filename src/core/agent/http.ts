import type { TokenProvider } from "../auth/oauth";
import { createPcHttp, PcCallError, type PcCallOptions } from "../http/pcHttp";
import type { DaemonLog } from "../term/daemonLog";
import { AGENT_CALL_TIMEOUT_MS } from "./limits";
import type { AgentLogRecord } from "./log";

export type AgentOp = "open" | "poll" | "reply" | "close";

/** 내 PC Agent 의 서버 호출 실패 — 판정(retryable 등)은 공용 {@link PcCallError} 그대로. */
export class AgentCallError extends PcCallError<AgentOp> {
  constructor(message: string, op: AgentOp, status?: number, code?: string) {
    super(message, op, status, code);
    this.name = "AgentCallError";
  }
}

export interface AgentCallOptions extends PcCallOptions {
  turnUuid?: string;
}

export interface AgentHttp {
  call(op: AgentOp, body: Record<string, unknown>, options?: AgentCallOptions): Promise<Record<string, unknown>>;
  /** open 뒤 link 토큰을 싣는다. */
  useLinkToken(token: string | undefined): void;
}

/**
 * 내 PC Agent 의 서버 입구({@code /mcp/agent/pc/<op>}) — 공용 한 입구({@link createPcHttp}) 위에 이름만 얹는다.
 * 요청마다 {@code agent_call} 1줄 + {@code agent_call_response} 1줄(같은 callId). poll 기한 = 서버가 붙잡는 시간 + B1.
 */
export function createAgentHttp(input: {
  endpoint: string;
  tokenProvider: TokenProvider;
  log: DaemonLog<AgentLogRecord>;
  fetchImpl?: typeof fetch;
}): AgentHttp {
  const http = createPcHttp<AgentOp, AgentLogRecord, AgentCallOptions>({
    endpoint: input.endpoint,
    path: "agent/pc",
    tokenProvider: input.tokenProvider,
    timeoutMs: AGENT_CALL_TIMEOUT_MS,
    sessionHeader: "X-Link-Token",
    error: (message, op, status, code) => new AgentCallError(message, op, status, code),
    fetchImpl: input.fetchImpl,
    logging: {
      log: input.log,
      request: ({ callId, op, bytes }, options) => ({ event: "agent_call", callId, op, turnUuid: options?.turnUuid, bytes }),
      response: ({ callId, op, ms }, outcome) => ({
        event: "agent_call_response",
        callId,
        op,
        ...(outcome.ok
          ? { ok: true, status: outcome.status, offers: Array.isArray(outcome.body.offers) ? outcome.body.offers.length : undefined }
          : outcome),
        ms,
      }),
    },
  });
  return { call: http.call, useLinkToken: http.useSessionToken };
}
