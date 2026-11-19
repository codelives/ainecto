import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, posix, win32 } from "node:path";
import { TermError } from "./errors";

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
  /** 크기를 넘겨 밀려난 직전 로그 — 하나만 남는다. */
  previousLog: string;
  /** 원격 터미널 다리 로그(PC 연결 안의 다리) — JSON 한 줄씩, 데몬 로그와 같은 쓰기·회전. */
  remoteLog: string;
  previousRemoteLog: string;
}

/**
 * 앱 홈 — ★OS 가 앱 자료를 두라고 정한 곳 아래 `ainecto`(경로 규칙은 여기 한 곳, 사용자 결재 «추천대로»).
 * macOS `~/Library/Application Support` · Windows `%LOCALAPPDATA%` · 그 밖 `${XDG_DATA_HOME:-~/.local/share}`(XDG: 절대 경로만).
 * 데몬 파일 자리({@link termPaths} — `~/.ainecto`)는 옮기지 않는다.
 */
export function appHome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "ainecto");
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "ainecto");
  const xdg = env.XDG_DATA_HOME;
  return posix.join(xdg && isAbsolute(xdg) ? xdg : posix.join(home, ".local", "share"), "ainecto");
}

/** 정확한 소문자 UUID(8-4-4-4-12) — 서버 {@code UUID_PATTERN} 과 같은 모양. 빈 값·구분자·`..` 는 모양에서 걸린다. 순수 함수. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

/**
 * 웹 «+ 새 세션»에서 폴더를 비웠을 때 세션마다 만드는 폴더 — ★경로 틀은 여기 한 곳(KAN-1238).
 * 프로젝트 꼬리표가 있으면 `<앱 홈>/projects/<projectUuid>/sessions/<requestId>`, 없으면 `<앱 홈>/sessions/<requestId>`.
 * 두 값 모두 {@link isUuid} 를 지나야 한다(경로 밖으로 못 나가게) — 아니면 TERM_BAD_REQUEST.
 */
export function webSessionFolder(app: string, projectUuid: string | undefined, requestId: string): string {
  if (!isUuid(requestId)) {
    throw new TermError("TERM_BAD_REQUEST", `The create request id "${requestId}" is not a UUID, so no session folder was made.`);
  }
  if (projectUuid === undefined) return join(app, "sessions", requestId);
  if (!isUuid(projectUuid)) {
    throw new TermError("TERM_BAD_REQUEST", `The project "${projectUuid}" is not a UUID, so no session folder was made.`);
  }
  return join(app, "projects", projectUuid, "sessions", requestId);
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
    previousLog: join(dir, "daemon.log.1"),
    remoteLog: join(dir, "remote.log"),
    previousRemoteLog: join(dir, "remote.log.1"),
  };
}
