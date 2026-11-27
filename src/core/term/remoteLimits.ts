/**
 * 원격 터미널 다리(PC 연결 안)의 CLI 값 — ★한 곳. 사용자 결재 2026-11-11 «추천대로»(원격 터미널 설계 v3 10-2).
 * poll 을 붙잡는 시간(C1)·본문 상한(C3·C4)은 서버가 open 응답 `limits` 로 준다 — 여기 같은 숫자를 두지 않는다.
 */

/** C8 — open·frame·close 한 호출의 기한(인증 갱신·본문 읽기 포함). poll 의 기한은 서버 C1 + 이 값(파생). */
export const CALL_TIMEOUT_MS = 10_000;

/** C9 — 화면을 올리는 가장 짧은 간격. */
export const FRAME_MIN_INTERVAL_MS = 150;

/** C10 — 화면 한 장에 싣는 지난 줄 수. */
export const FRAME_SCROLLBACK_LINES = 200;

/** C12·C13 — 네트워크·5xx·기한 초과 뒤 다시 시도할 때 기다리는 시간(두 배씩, 흔들림 0~C12). */
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 10_000;

/** 다시 하기 대기 — {@code attempt} 번째(0부터) 실패 뒤. C12 에서 두 배씩 C13 까지 + 흔들림 0~C12({@code random} ∈ [0,1)). 순수 함수. */
export function retryWait(attempt: number, random: number): number {
  return Math.min(RETRY_MIN_MS * 2 ** attempt, RETRY_MAX_MS) + Math.floor(random * RETRY_MIN_MS);
}

/**
 * 웹 터미널 이미지 붙여넣기 — 원본 이미지 한 장의 상한. 사용자 결재 2026-11-27 «8MB + nginx 한 경로»(web-cmux 와 같은 8 MiB).
 * 웹도 같은 값으로 먼저 검사한다(계약 §3) — 여기는 PC 의 다시 검사.
 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 붙여넣은 이미지를 PC 에 두는 시간 — 지나면 저장할 때·원격 다리가 켜질 때 지운다(계약 §3 · web-cmux 와 같은 24시간). */
export const IMAGE_KEEP_MS = 24 * 60 * 60 * 1000;
