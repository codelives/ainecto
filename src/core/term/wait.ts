import { openTermClient, type TermClient } from "./client";
import { noSession, TermError } from "./errors";
import { DAEMON_START_ATTEMPTS } from "./limits";
import type { TermPaths } from "./paths";
import { readLines, sessionInstance } from "./protocol";
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
 * instance(있으면) = 그 인스턴스의 화면만 본다 — watch·read 에 실어 holder 가 가린다(같은 이름으로 다시 만든 세션이면 SESSION_REPLACED).
 *   답에 인스턴스 칸이 없으면(옛 데몬) 이름만으로 본다.
 * 연결만 끊기면(바깥 넘기기 — 세션 유지 구조 G7) 같은 인스턴스로 다시 붙어 이어 기다린다. 세션이 끝났으면 끝을 알린다.
 */
export async function waitForMatch(
  paths: TermPaths,
  name: string,
  pattern: RegExp,
  range: ReadRange,
  timeoutMs: number | undefined,
  instance?: string,
): Promise<WaitResult> {
  let dirty = false;
  let ended: string | undefined;
  /** 연결이 끊김(세션 끝 아님) — 바깥 넘기기 등. 같은 인스턴스로 다시 붙는다. */
  let dropped = false;
  let wake: () => void = () => undefined;
  const signal = (): void => {
    dirty = true;
    wake();
  };
  let timedOut = false;
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
    timedOut = true;
    signal();
  }, timeoutMs);
  const target = { name, ...(instance !== undefined ? { instance } : {}) };
  /** 붙어서 «바뀜» 알림을 건다. 데몬이 없으면 undefined. */
  const watch = async (): Promise<TermClient | undefined> => {
    const client = await openTermClient(paths, { start: false });
    if (!client) return undefined;
    client.onEvent((event) => {
      if (event.event === "exit") {
        ended = `Session "${name}" ended (exit ${event.signal ? `signal ${event.signal}` : event.exitCode}) before the pattern appeared.`;
      }
      signal();
    });
    client.onClose(() => {
      dropped = true;
      signal();
    });
    try {
      await client.request({ op: "watch", ...target });
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  };
  let client = await watch();
  if (!client) {
    throw noSession(name);
  }
  /** 잇달아 다시 붙은 횟수 — 붙자마자 또 끊기기를 되풀이하면 그만둔다(띄우기 시도 수와 같은 상한). */
  let rejoins = 0;
  try {
    for (;;) {
      dirty = false;
      if (dropped && !ended) {
        // ★바깥 넘기기 등으로 연결만 끊겼다 — 처음 푼 인스턴스로 다시 붙는다(G7). 그 사이 같은 이름 새 세션이면 holder 가 SESSION_REPLACED.
        client.close();
        dropped = false;
        rejoins += 1;
        const again = rejoins > DAEMON_START_ATTEMPTS ? undefined : await watch().catch((error: unknown) => {
          if (error instanceof TermError && error.code === "TERM_NO_SESSION") return undefined;
          throw error;
        });
        if (!again) {
          throw new TermError("TERM_SESSION_ENDED", `The term daemon closed the connection and session "${name}" is no longer there.`);
        }
        client = again;
      }
      let data: unknown;
      try {
        data = await client.request({ op: "read", ...target, scrollback: range.scrollback, lines: range.lines });
      } catch (error) {
        // 세션이 끝나면 데몬 표에서 빠져 read 가 «없음»으로 답한다 — 끝났다는 사실로 바꿔 말한다.
        if (ended && error instanceof TermError && error.code === "TERM_NO_SESSION") {
          throw new TermError("TERM_SESSION_ENDED", ended);
        }
        // 읽는 중에 끊겼다(넘기기) — 다시 붙어 이어 읽는다.
        if (dropped && !ended && error instanceof TermError && error.code === "TERM_DAEMON_GONE") {
          continue;
        }
        throw error;
      }
      rejoins = 0;
      const seen = sessionInstance(data);
      if (instance !== undefined && seen !== undefined && seen !== instance) {
        throw new TermError("SESSION_REPLACED", `The session "${name}" was replaced by a new one with the same name.`);
      }
      const lines = readLines(data);
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
