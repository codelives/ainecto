import { appendFileSync } from "node:fs";
import { PRIVATE_FILE_MODE } from "../fs/privateFiles";

/**
 * 데몬 로그 `daemon.log` — JSON 한 줄씩(설계 2-7). 판정 기준 «로그만 보고 5분 안에 원인».
 *   · 제어 요청은 요청 1줄 + 응답 1줄(같은 id). 실패해도 응답 줄은 반드시 — 이유(code) 포함.
 *   · 세션 시작·종료(종료 코드·신호), 데몬 시작·끝, 못 읽은 줄.
 * ★남기지 않는 것: 보낸 글·키·화면 글자·환경변수 값(비밀이 지나갈 수 있다). 글은 길이만.
 * 동기 쓰기 — 데몬이 갑자기 죽어도 그 직전 줄까지 남는다.
 */
export type DaemonLogRecord =
  | { event: "daemon_start"; pid: number; version: string; socket: string }
  | { event: "daemon_locked"; pid: number }
  | { event: "daemon_stop"; pid: number; reason: string }
  | { event: "daemon_crash"; pid: number; error: string }
  | { event: "request"; id: string; conn: number; op: string; name?: string; textLength?: number; key?: string }
  | { event: "response"; id: string; conn: number; op: string; ok: boolean; code?: string; message?: string; ms: number }
  | { event: "bad_message"; conn: number; code: string; message: string }
  | { event: "session_start"; name: string; pid: number; cwd: string; shell: boolean }
  | { event: "session_exit"; name: string; pid: number; exitCode: number; signal: number; kept: boolean }
  | { event: "attach"; conn: number; name: string }
  | { event: "detach"; conn: number; name: string; reason: string };

export class DaemonLog {
  constructor(private readonly path: string) {}

  write(record: DaemonLogRecord): void {
    try {
      appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: PRIVATE_FILE_MODE });
    } catch (error) {
      // 로그 파일을 못 쓰는 상황(디스크 가득 등)이 세션을 멈추게 하지 않는다 — 남길 수 있는 마지막 자리(stderr)에 남긴다.
      process.stderr.write(`ainecto term: could not write ${this.path}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}
