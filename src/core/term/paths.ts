import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * `ainecto term` 의 파일 자리 — ★한 곳(설계 2-1·2-4·2-6·2-7). 폴더는 {@code ~/.ainecto/term}, 0700.
 */
export interface TermPaths {
  /** 폴더(0700). */
  dir: string;
  /** 제어 소켓(0600). 잠금을 쥔 데몬만 지우고 만든다. */
  socket: string;
  /** macOS 데몬 잠금 파일(O_EXLOCK). */
  lockFile: string;
  /** Linux 데몬 잠금 — 추상 이름공간 소켓 이름(파일 없음). */
  abstractLockName: string;
  /** 데몬 pid — «응답 없음» 안내용, 판정에 쓰지 않는다. */
  daemonInfo: string;
  /** 복원 매니페스트. */
  manifest: string;
  /** 데몬 로그 — JSON 한 줄씩. */
  log: string;
}

export function termPaths(home: string = homedir()): TermPaths {
  const dir = join(home, ".ainecto", "term");
  return {
    dir,
    socket: join(dir, "ctl.sock"),
    lockFile: join(dir, "daemon.lock"),
    // ★설계는 `\0ainecto-term-<uid>.lock` 이다. 추상 이름은 홈 폴더와 무관하게 기기 전체에 하나라서, 홈이 다른
    //   두 폴더(시험·다른 HOME)가 서로의 잠금을 막는다. 잠금이 지키는 것은 «이 폴더의 소켓»이므로 폴더 경로를 넣는다.
    abstractLockName: `\0ainecto-term-${process.getuid?.() ?? "na"}-${createHash("sha256").update(dir).digest("hex")}.lock`,
    daemonInfo: join(dir, "daemon.json"),
    manifest: join(dir, "sessions.json"),
    log: join(dir, "daemon.log"),
  };
}
