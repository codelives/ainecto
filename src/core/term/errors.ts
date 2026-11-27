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

/** 오류의 코드 — TermError·Node 오류(code) 그대로, 그 밖은 TERM_INTERNAL. 응답 줄·로그가 이것 하나로 코드를 낸다. */
export function errorCode(error: unknown): string {
  if (error instanceof TermError) {
    return error.code;
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "TERM_INTERNAL";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
