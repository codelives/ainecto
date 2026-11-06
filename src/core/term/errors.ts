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
