import { randomUUID } from "node:crypto";
import type { TokenProvider } from "../auth/oauth";
import type { DaemonLog } from "../term/daemonLog";
import { AGENT_CALL_TIMEOUT_MS } from "./limits";
import type { AgentLogRecord } from "./log";

export type AgentOp = "open" | "poll" | "reply" | "close";

/** 서버 호출 실패 — {@code status} 가 있으면 서버가 답했다(4xx 는 다시 하지 않는다), 없으면 네트워크·기한. */
export class AgentCallError extends Error {
  constructor(
    message: string,
    readonly op: AgentOp,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "AgentCallError";
  }

  /** 다시 해 볼 만한가 — 네트워크·기한·5xx·429. */
  get retryable(): boolean {
    return this.status === undefined || this.status >= 500 || this.status === 429;
  }
}

export interface AgentCallOptions {
  /** 서버가 붙잡는 시간 — poll 은 이것 + B1 을 기다린다. */
  holdMs?: number;
  turnUuid?: string;
  signal?: AbortSignal;
}

export interface AgentHttp {
  call(op: AgentOp, body: Record<string, unknown>, options?: AgentCallOptions): Promise<Record<string, unknown>>;
  /** open 뒤 link 토큰을 싣는다. */
  useLinkToken(token: string | undefined): void;
}

/**
 * ★PC ↔ 서버 HTTP 의 한 입구({@code /mcp/agent/pc/<op>}). 로그·토큰·기한·오류 분류는 여기 책임이고, 부르는 곳은 «무엇을»만 안다.
 * 요청마다 {@code agent_call} 1줄 + {@code agent_call_response} 1줄(같은 callId) — 응답 줄은 finally 에서 반드시 쓴다.
 * 401 이면 로그인을 한 번 새로 받아 다시 보낸다.
 */
export function createAgentHttp(input: {
  endpoint: string;
  tokenProvider: TokenProvider;
  log: DaemonLog<AgentLogRecord>;
  fetchImpl?: typeof fetch;
}): AgentHttp {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = `${input.endpoint.replace(/\/+$/, "")}/agent/pc/`;
  let linkToken: string | undefined;

  async function send(op: AgentOp, payload: string, token: string | undefined, options: AgentCallOptions): Promise<Response> {
    // 기한(B1, poll 은 + 서버가 붙잡는 시간)과 멈춤 신호를 하나로 — Node 18 에는 AbortSignal.any 가 없다.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")),
      (options.holdMs ?? 0) + AGENT_CALL_TIMEOUT_MS);
    const onStop = () => controller.abort(new DOMException("stopped", "AbortError"));
    options.signal?.addEventListener("abort", onStop, { once: true });
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (linkToken && op !== "open") headers["X-Link-Token"] = linkToken;
    try {
      const response = await fetchImpl(base + op, { method: "POST", headers, body: payload, signal: controller.signal });
      await response.clone().arrayBuffer();   // 본문까지 기한 안에
      return response;
    } catch (error) {
      throw controller.signal.aborted && controller.signal.reason instanceof Error ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onStop);
    }
  }

  return {
    useLinkToken(token) {
      linkToken = token;
    },
    async call(op, body, options = {}) {
      const callId = randomUUID();
      const payload = JSON.stringify(body);
      const started = Date.now();
      input.log.write({ event: "agent_call", callId, op, turnUuid: options.turnUuid, bytes: Buffer.byteLength(payload, "utf8") });
      let outcome: Omit<Extract<AgentLogRecord, { event: "agent_call_response" }>, "event" | "callId" | "op" | "ms"> = {
        ok: false,
        error: "no response",
      };
      try {
        let response = await send(op, payload, await input.tokenProvider.getAccessToken(), options);
        if (response.status === 401) {
          response = await send(op, payload, await input.tokenProvider.refreshAfterUnauthorized(), options);
        }
        const text = await response.text();
        const parsed = parseJson(text);
        if (!response.ok) {
          const code = typeof parsed?.code === "string" ? parsed.code : undefined;
          outcome = { ok: false, status: response.status, code };
          throw new AgentCallError(
            typeof parsed?.detail === "string" ? parsed.detail : `HTTP ${response.status}`, op, response.status, code);
        }
        const offers = Array.isArray(parsed?.offers) ? parsed.offers.length : undefined;
        outcome = { ok: true, status: response.status, offers };
        return parsed ?? {};
      } catch (error) {
        if (error instanceof AgentCallError) throw error;
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        outcome = { ok: false, error: timedOut ? error.name : error instanceof Error ? error.message : String(error) };
        throw new AgentCallError(timedOut ? `${op} timed out` : `${op} failed: ${outcome.error}`, op);
      } finally {
        input.log.write({ event: "agent_call_response", callId, op, ...outcome, ms: Date.now() - started });
      }
    },
  };
}

function parseJson(text: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
