import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { extname, isAbsolute, join, posix, win32 } from "node:path";
import { TermError } from "./errors";

/**
 * `ainecto term` 의 파일 자리 — ★한 곳(설계 2-1·2-4·2-6·2-7). 폴더는 {@code ~/.ainecto/term}, 0700.
 */
export interface TermPaths {
  /** 폴더(0700). */
  dir: string;
  /**
   * 데몬 주소 파일 — macOS·Linux 는 제어 소켓 자체(0600), Windows 는 named pipe 이름과 증명 비밀값을 적은 파일(0600, ipc.ts).
   * 잠금을 쥔 데몬만 지우고 만든다. 없으면(ENOENT) «데몬 없음»이다 — 두 OS 에서 같은 뜻.
   */
  socket: string;
  /** macOS·Windows 데몬 잠금 파일(독점 열기 — daemonLock.ts). */
  lockFile: string;
  /** Linux 데몬 잠금 — 추상 이름공간 소켓 이름(파일 없음). */
  abstractLockName: string;
  /** 데몬 pid — «응답 없음» 안내용, 판정에 쓰지 않는다. */
  daemonInfo: string;
  /** 복원 매니페스트. */
  manifest: string;
  /** 끝 기록 책 — 서버가 받았다고 확인하기 전까지의 세션 끝(endedBook.ts). */
  ended: string;
  /** 책을 못 읽는 동안 생긴 끝 기록 — 원본을 덮지 않고 여기 둔다 · 다음 데몬이 원본에 합친 뒤 지운다(리뷰 r2 P1-2). */
  endedPending: string;
  /** 데몬 로그 — JSON 한 줄씩. */
  log: string;
  /** 크기를 넘겨 밀려난 직전 로그 — 하나만 남는다. */
  previousLog: string;
  /** 원격 터미널 다리 로그(PC 연결 안의 다리) — JSON 한 줄씩, 데몬 로그와 같은 쓰기·회전. */
  remoteLog: string;
  previousRemoteLog: string;
  /**
   * holder 주소 파일(세션 유지 구조 설계 3-1) — 세션·PTY 를 쥔 holder 하나가 듣는다. 모양은 {@link socket} 과 같다(Unix 소켓 · Windows 주소 파일).
   * 바깥(`term daemon`)만 붙는다. holder 는 옛 데몬 잠금({@link lockFile})을 평생 쥔다.
   */
  holderSocket: string;
  /** holder 의 pid·판·uuid — 안내용(판정은 살아 있는 holder 에 묻는다 · caps). ★daemon.json 이 아니다 — 구판 CLI 가 이 파일을 판으로 읽지 않게. */
  holderInfo: string;
  holderLog: string;
  previousHolderLog: string;
  /** 바깥이 뜨는 동안 쥐는 잠금 — 바깥 시작·넘기기를 한 줄로 세운다(두 바깥이 동시에 포인터를 바꾸지 않게). */
  outerLockFile: string;
  outerAbstractLockName: string;
}

/**
 * 바깥 하나의 주소 파일(설계 3-4 «바깥마다 자기 주소, 공용 주소는 포인터»). 이름에는 uuid 앞 8글자만 쓴다 —
 * macOS Unix 소켓 경로 상한(104바이트) 안에 들게. 같은 앞글자의 파일이 이미 있으면 바깥이 uuid 를 다시 뽑는다(daemon.ts).
 */
export function outerSocketPath(paths: Pick<TermPaths, "dir" | "socket">, outer: string): string {
  return join(paths.dir, `outer-${outer.slice(0, 8)}${extname(paths.socket)}`);
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

export function termPaths(home: string = homedir(), platform: NodeJS.Platform = process.platform): TermPaths {
  const dir = join(home, ".ainecto", "term");
  return {
    dir,
    socket: join(dir, platform === "win32" ? "ctl.pipe" : "ctl.sock"),
    lockFile: join(dir, "daemon.lock"),
    // ★설계는 `\0ainecto-term-<uid>.lock` 이다. 추상 이름은 홈 폴더와 무관하게 기기 전체에 하나라서, 홈이 다른
    //   두 폴더(시험·다른 HOME)가 서로의 잠금을 막는다. 잠금이 지키는 것은 «이 폴더의 소켓»이므로 폴더 경로를 넣는다.
    abstractLockName: `\0ainecto-term-${process.getuid?.() ?? "na"}-${createHash("sha256").update(dir).digest("hex")}.lock`,
    daemonInfo: join(dir, "daemon.json"),
    manifest: join(dir, "sessions.json"),
    ended: join(dir, "ended.json"),
    endedPending: join(dir, "ended.pending.json"),
    log: join(dir, "daemon.log"),
    previousLog: join(dir, "daemon.log.1"),
    remoteLog: join(dir, "remote.log"),
    previousRemoteLog: join(dir, "remote.log.1"),
    holderSocket: join(dir, platform === "win32" ? "holder.pipe" : "holder.sock"),
    holderInfo: join(dir, "holder.json"),
    holderLog: join(dir, "holder.log"),
    previousHolderLog: join(dir, "holder.log.1"),
    outerLockFile: join(dir, "outer.lock"),
    outerAbstractLockName: `\0ainecto-term-${process.getuid?.() ?? "na"}-${createHash("sha256").update(dir).digest("hex")}-outer.lock`,
  };
}
