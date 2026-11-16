import { randomUUID } from "node:crypto";
import type { TokenProvider } from "../auth/oauth";
import type { DaemonLog } from "../term/daemonLog";

/** 서버 호출 실패 — {@code status} 가 있으면 서버가 답했다(4xx 는 다시 하지 않는다), 없으면 네트워크·기한. */
export class PcCallError<Op extends string = string> extends Error {
  constructor(
    message: string,
    readonly op: Op,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PcCallError";
  }

  /** 다시 해 볼 만한가 — 네트워크·기한·5xx·429. */
  get retryable(): boolean {
    return this.status === undefined || this.status >= 500 || this.status === 429;
  }
}

export interface PcCallOptions {
  /** 서버가 붙잡는 시간 — 이 호출은 이것 + 기한({@code timeoutMs})을 기다린다. */
  holdMs?: number;
  signal?: AbortSignal;
}

/** 한 호출의 끝 — 응답 줄의 재료. 성공이면 서버 본문(줄에 셀 것만 골라 담는다 — 본문 자체는 남기지 않는다). */
export type PcCallOutcome =
  | { ok: true; status: number; body: Record<string, unknown> }
  | { ok: false; status?: number; code?: string; error?: string };

/** 로그 줄 모양은 기능마다 다르다(agent.log · remote.log) — 쓰는 때(요청 1줄 · finally 의 응답 1줄)는 이 레이어가 정한다. */
export interface PcCallLogging<R extends { event: string }, O extends PcCallOptions> {
  log: DaemonLog<R>;
  request(call: { callId: string; op: string; bytes: number }, options: O | undefined): R;
  response(call: { callId: string; op: string; ms: number }, outcome: PcCallOutcome): R;
}

export interface PcHttp<Op extends string, O extends PcCallOptions = PcCallOptions> {
  call(op: Op, body: Record<string, unknown>, options?: O): Promise<Record<string, unknown>>;
  /** open 이 준 연결 토큰 — open 밖 호출에 {@code sessionHeader} 로 싣는다. */
  useSessionToken(token: string | undefined): void;
}

/**
 * ★PC ↔ 서버 HTTP 의 한 입구({@code <endpoint>/<path>/<op>} — 내 PC Agent {@code agent/pc} · 원격 터미널 {@code term/pc}).
 * 로그·토큰·기한·오류 분류는 여기 책임이고, 부르는 곳은 «무엇을»만 안다.
 * 요청마다 요청 1줄 + 응답 1줄(같은 callId) — 응답 줄은 finally 에서 반드시 쓴다. 401 이면 로그인을 한 번 새로 받아 다시 보낸다.
 * open 은 연결 토큰을 싣지 않는다(연결을 만드는 호출이다).
 */
export function createPcHttp<Op extends string, R extends { event: string }, O extends PcCallOptions = PcCallOptions>(input: {
  endpoint: string;
  /** {@code /mcp} 아래 자리 — 앞뒤 빗금 없이. */
  path: string;
  tokenProvider: TokenProvider;
  /** 한 호출의 기한(인증 갱신·본문 읽기 포함) — 붙잡는 호출은 + {@code holdMs}. */
  timeoutMs: number;
  /** 연결 토큰 헤더 이름. */
  sessionHeader: string;
  logging: PcCallLogging<R, O>;
  /** 오류 종류 — 기능마다 이름을 달리 둘 때. */
  error?: (message: string, op: Op, status?: number, code?: string) => PcCallError<Op>;
  fetchImpl?: typeof fetch;
}): PcHttp<Op, O> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = `${input.endpoint.replace(/\/+$/, "")}/${input.path}/`;
  const fail = input.error ?? ((message, op, status, code) => new PcCallError(message, op, status, code));
  const { log } = input.logging;
  let sessionToken: string | undefined;

  async function send(op: Op, payload: string, token: string | undefined, options: PcCallOptions = {}): Promise<Response> {
    // 기한(붙잡는 호출은 + 서버가 붙잡는 시간)과 멈춤 신호를 하나로 — Node 18 에는 AbortSignal.any 가 없다.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")),
      (options.holdMs ?? 0) + input.timeoutMs);
    const onStop = () => controller.abort(new DOMException("stopped", "AbortError"));
    options.signal?.addEventListener("abort", onStop, { once: true });
    const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionToken && op !== "open") headers[input.sessionHeader] = sessionToken;
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
    useSessionToken(token) {
      sessionToken = token;
    },
    async call(op, body, options) {
      const callId = randomUUID();
      const payload = JSON.stringify(body);
      const started = Date.now();
      log.write(input.logging.request({ callId, op, bytes: Buffer.byteLength(payload, "utf8") }, options));
      let outcome: PcCallOutcome = { ok: false, error: "no response" };
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
          throw fail(typeof parsed?.detail === "string" ? parsed.detail : `HTTP ${response.status}`, op, response.status, code);
        }
        outcome = { ok: true, status: response.status, body: parsed ?? {} };
        return parsed ?? {};
      } catch (error) {
        if (error instanceof PcCallError) throw error;
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        const reason = timedOut ? error.name : error instanceof Error ? error.message : String(error);
        outcome = { ok: false, error: reason };
        throw fail(timedOut ? `${op} timed out` : `${op} failed: ${reason}`, op);
      } finally {
        log.write(input.logging.response({ callId, op, ms: Date.now() - started }, outcome));
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
