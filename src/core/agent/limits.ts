/**
 * `ainecto agent serve` 의 CLI 값 — ★한 곳(SSOT). KAN-1075 설계 v3 4절 결재(2026-11-11 «추천대로», 원격 터미널·`-p` 승인값과 같은 숫자).
 * 서버 값(poll 붙잡는 시간·글 상한·문서 상한)은 여기 두지 않는다 — open 응답 {@code limits} 로 받는다.
 */

/** B1 — 서버 호출 하나의 기한. poll 은 서버가 붙잡는 시간 + 이것. */
export const AGENT_CALL_TIMEOUT_MS = 10_000;

/** B2 — 다시 하기 간격: 처음 500ms, 두 배씩, 10초에서 멈춘다. */
export const AGENT_RETRY_MIN_MS = 500;
export const AGENT_RETRY_MAX_MS = 10_000;

/** B3 — 요청 하나(Claude 한 차례)의 기한. 넘으면 그 프로세스를 내리고 FAILED 로 답한다. */
export const AGENT_TURN_TIMEOUT_MS = 15 * 60_000;

/** B6 — Claude 프로세스를 멈출 때 한 단계마다 기다리는 시간(stdin 닫기 → SIGTERM → SIGKILL). */
export const AGENT_STOP_WAIT_MS = 5_000;

/** 다음 다시 하기 간격(B2). */
export function nextRetryDelay(previousMs: number | undefined): number {
  if (previousMs === undefined) return AGENT_RETRY_MIN_MS;
  return Math.min(previousMs * 2, AGENT_RETRY_MAX_MS);
}
