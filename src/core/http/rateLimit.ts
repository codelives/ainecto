/**
 * 서버 호출 상한(429) 읽기 — ★한 곳(설계 D-1 «호출 상한» §6). CLI 는 ★자동으로 다시 부르지 않는다: 대화형 0회, CLI 안에는 배경 스케줄러가 없다
 * (cron 으로 도는 poll 은 실패 종료 → 다음 회차가 소유자). 대기 정보를 구조화해 사람·에이전트에게 넘길 뿐이다.
 *
 * <pre>
 * HTTP 429            {@code Retry-After} 헤더(정수 초 또는 HTTP-date) — 서버는 정수 초를 보낸다
 * JSON-RPC 429        HTTP 200 안의 {@code error.code 429} + {@code data.retryAfterSeconds}(도구 안 거절)
 * 본문 칸              code RATE_LIMITED · retryAfterSeconds · scope · policyId — 문장은 파싱하지 않는다
 * </pre>
 * 헤더가 없거나 깨졌으면 대기를 모른다(undefined) — 그것을 «바로 다시»로 읽지 않는다.
 */

export const RATE_LIMITED = "RATE_LIMITED";

export interface RateLimitDetails {
  status: 429;
  /** 다시 해도 되는 가장 이른 초. 모르면 없음. */
  retryAfterSeconds?: number;
  /** 같은 순간의 ISO 시각 — 사람이 읽는 재개 시각. */
  retryAt?: string;
  scope?: string;
  policyId?: string;
}

/** {@code Retry-After} 값 → 초(0 이상 정수). 정수 초와 HTTP-date 를 읽는다. 없거나 깨졌으면 undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (!/[a-z]/i.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** 응답 헤더·본문 칸에서 대기 정보. 본문의 {@code retryAfterSeconds} 가 헤더보다 앞선다(서버는 같은 값을 싣는다). */
export function rateLimitDetails(
  headerValue: string | null | undefined,
  body: unknown,
  now: number = Date.now(),
): RateLimitDetails {
  const fields = isRecord(body) ? body : {};
  const fromBody = typeof fields.retryAfterSeconds === "number" && Number.isFinite(fields.retryAfterSeconds) && fields.retryAfterSeconds >= 0
    ? Math.ceil(fields.retryAfterSeconds)
    : undefined;
  const retryAfterSeconds = fromBody ?? parseRetryAfter(headerValue, now);
  return {
    status: 429,
    ...(retryAfterSeconds !== undefined
      ? { retryAfterSeconds, retryAt: new Date(now + retryAfterSeconds * 1000).toISOString() }
      : {}),
    ...(typeof fields.scope === "string" ? { scope: fields.scope } : {}),
    ...(typeof fields.policyId === "string" ? { policyId: fields.policyId } : {}),
  };
}

/** JSON-RPC 오류가 서버 호출 상한인가 — {@code code 429} + {@code data.code RATE_LIMITED}. */
export function isRateLimitedRpcError(error: unknown): error is { code: 429; message: string; data: Record<string, unknown> } {
  return isRecord(error) && error.code === 429 && isRecord(error.data) && error.data.code === RATE_LIMITED;
}

/** 사람이 읽을 한 줄 — 무엇이(where) 언제 다시 되는지. */
export function rateLimitMessage(where: string, details: RateLimitDetails): string {
  return details.retryAfterSeconds === undefined
    ? `${where} was rate limited (HTTP 429). Wait before trying again.`
    : `${where} was rate limited (HTTP 429). Retry after ${details.retryAfterSeconds} seconds (${details.retryAt}).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
