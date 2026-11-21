import { execFile } from "node:child_process";
import { isNodeError } from "../fs/privateFiles";

/**
 * 프로세스가 살아 있는지 — 한 곳(잠금의 죽은 pid 판정 · PC 연결 종료 확인이 같이 쓴다).
 * EPERM = 살아 있지만 남의 것.
 */
export function processAlive(pid: number): boolean {
  return signalZero(pid);
}

/** 그 프로세스 그룹에 남은 프로세스가 하나라도 있는지 — `kill(-pgid, 0)` 이 ESRCH 면 0개. */
export function processGroupAlive(pgid: number): boolean {
  return signalZero(-pgid);
}

function signalZero(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

/**
 * pid 의 프로세스 그룹(pgid) — `ps -o pgid= -p <pid>`(macOS·Linux). 못 읽으면(ps 없음·이미 끝남·다른 플랫폼) undefined.
 * Node 는 getpgid 를 주지 않는다.
 */
export async function processGroupOf(pid: number): Promise<number | undefined> {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  return await new Promise((resolve) => {
    execFile("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      const pgid = Number.parseInt(String(stdout).trim(), 10);
      resolve(error || !Number.isSafeInteger(pgid) || pgid <= 0 ? undefined : pgid);
    });
  });
}
