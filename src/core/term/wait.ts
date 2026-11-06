import { openTermClient } from "./client";
import { TermError } from "./errors";
import type { TermPaths } from "./paths";
import type { ReadRange } from "./screen";

export interface WaitResult {
  name: string;
  /** 맞은 글자. */
  match: string;
  /** 맞은 글자가 있는 줄. */
  line: string;
}

/**
 * `ainecto term wait` — 화면 글자가 정규식에 맞을 때까지 기다린다(설계 1-1 `wait-for`).
 * ★정규식은 «클라이언트»에서 돈다. 데몬은 «바뀜» 알림만 보내고 화면 글자를 돌려줄 뿐이라, 오래 걸리는 정규식이
 *   데몬(모든 세션)을 막지 않는다 — 설계 7 ⑦ «실행 범위 제한»을 실행 상한 값 없이 지킨다.
 * 데몬은 다음 read 전까지 알림을 한 번만 보낸다(출력이 많아도 알림이 쌓이지 않는다).
 */
export async function waitForMatch(
  paths: TermPaths,
  name: string,
  pattern: RegExp,
  range: ReadRange,
  timeoutMs: number | undefined,
): Promise<WaitResult> {
  const client = await openTermClient(paths, { start: false });
  if (!client) {
    throw new TermError("TERM_NO_SESSION", `No session named "${name}" (no term sessions are running).`);
  }
  let dirty = false;
  let ended: string | undefined;
  let wake: () => void = () => undefined;
  const signal = (): void => {
    dirty = true;
    wake();
  };
  client.onEvent((event) => {
    if (event.event === "exit") {
      ended = `Session "${name}" ended (exit ${event.signal ? `signal ${event.signal}` : event.exitCode}) before the pattern appeared.`;
    }
    signal();
  });
  client.onClose(() => {
    ended ??= "The term daemon closed the connection.";
    signal();
  });
  let timedOut = false;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    signal();
  }, timeoutMs);
  try {
    await client.request({ op: "watch", name });
    for (;;) {
      dirty = false;
      let data: unknown;
      try {
        data = await client.request({ op: "read", name, scrollback: range.scrollback, lines: range.lines });
      } catch (error) {
        // 세션이 끝나면 데몬 표에서 빠져 read 가 «없음»으로 답한다 — 끝났다는 사실로 바꿔 말한다.
        if (ended && error instanceof TermError && error.code === "TERM_NO_SESSION") {
          throw new TermError("TERM_SESSION_ENDED", ended);
        }
        throw error;
      }
      const lines = linesOf(data);
      for (const line of lines) {
        const found = pattern.exec(line);
        if (found) {
          return { name, match: found[0], line };
        }
      }
      if (ended) {
        throw new TermError("TERM_SESSION_ENDED", ended);
      }
      if (timedOut) {
        throw new TermError("TERM_WAIT_TIMEOUT", `The pattern did not appear in session "${name}" within the timeout.`);
      }
      if (!dirty) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = () => undefined;
      }
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    client.close();
  }
}

function linesOf(data: unknown): string[] {
  if (data && typeof data === "object" && "lines" in data && Array.isArray(data.lines)) {
    return data.lines.filter((line): line is string => typeof line === "string");
  }
  throw new TermError("TERM_BAD_RESPONSE", "The term daemon answered read without lines.");
}
