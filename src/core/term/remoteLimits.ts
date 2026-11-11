/**
 * `ainecto term remote` 의 CLI 값 — ★한 곳. 사용자 결재 2026-11-11 «추천대로»(원격 터미널 설계 v3 10-2).
 * poll 을 붙잡는 시간(C1)·본문 상한(C3·C4)은 서버가 open 응답 `limits` 로 준다 — 여기 같은 숫자를 두지 않는다.
 */

/** C8 — open·frame·close 한 호출의 기한(인증 갱신·본문 읽기 포함). poll 의 기한은 서버 C1 + 이 값(파생). */
export const CALL_TIMEOUT_MS = 10_000;

/** C9 — 화면을 올리는 가장 짧은 간격. */
export const FRAME_MIN_INTERVAL_MS = 150;

/** C10 — 화면 한 장에 싣는 지난 줄 수. */
export const FRAME_SCROLLBACK_LINES = 200;

/** C11 — 세션 크기(다른 곳에서 붙은 터미널이 바꿨을 수 있다)를 확인하는 간격. */
export const SIZE_CHECK_INTERVAL_MS = 2_000;

/** C12·C13 — 네트워크·5xx·기한 초과 뒤 다시 시도할 때 기다리는 시간(두 배씩, 흔들림 0~C12). */
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 10_000;
