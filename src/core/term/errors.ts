/**
 * term 의 오류 — 코드가 붙는다. CLI 는 이 코드를 그대로 `renderError` 한 곳으로 내보낸다(--json 의 error.code).
 * 데몬이 돌려준 오류도 같은 코드로 다시 던진다.
 */
export class TermError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 데몬이 없을 때(또는 그 세션이 목록에 없을 때)의 «그런 세션 없음». */
export function noSession(name: string): TermError {
  return new TermError("TERM_NO_SESSION", `No session named "${name}" (no term sessions are running).`);
}
