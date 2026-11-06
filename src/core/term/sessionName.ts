import { TermError } from "./errors";

/**
 * 세션 이름 — ★세션 수명 동안 바뀌지 않는 식별자다(이름 바꾸기 없음, 설계 v2 F4). 명령줄 인자로 쓰이므로
 * 공백·제어 문자를 막고 `-` 로 시작하지 못하게 한다(플래그와 헷갈림). 2단계에서 에이전트 이름과 잇는 규칙은
 * 서버가 진실원이라 여기서 다시 정하지 않는다.
 */
export function assertSessionName(name: string): void {
  if (name.length === 0 || name.startsWith("-") || /[\s\p{Cc}]/u.test(name)) {
    throw new TermError(
      "TERM_BAD_NAME",
      `"${name}" cannot be a session name — use a non-empty name without spaces that does not start with "-".`,
    );
  }
}
