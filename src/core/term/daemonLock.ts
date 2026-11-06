import { constants, openSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import type { TermPaths } from "./paths";

/**
 * 데몬 하나를 지키는 잠금 — ★OS 가 프로세스 수명 동안 쥐고, 죽으면 OS 가 푸는 잠금(설계 2-1 v3, 리뷰 #67 P2-L1).
 * 쥔 프로세스만 소켓을 지우고 만든다. 시간 초과·PID·번호 파일로 판정하지 않는다.
 * 플랫폼마다 수단이 다른 것은 이 함수 하나 안에 가둔다(호출처는 데몬 시작 하나).
 *
 *   macOS : daemon.lock 을 O_EXLOCK|O_NONBLOCK 으로 연다 — 쥔 동안 다른 열기는 EAGAIN.
 *   Linux : 추상 이름공간 Unix 소켓에 bind — 쥔 동안 다른 bind 는 EADDRINUSE. 파일이 남지 않는다.
 *
 * ★잠금 fd·소켓은 Node(libuv)가 CLOEXEC 로 연다 — PTY 자식이 물려받아 데몬이 죽은 뒤에도 잠금을 쥐는 일이 없다
 *   (시험: 데몬을 SIGKILL 한 뒤 HUP 을 무시하는 자식이 살아 있어도 새 데몬이 뜬다).
 */
export type DaemonLockResult = { held: true } | { held: false };

/** macOS `sys/fcntl.h` `#define O_EXLOCK 0x00000020` — Node 가 상수를 주지 않는다. */
const DARWIN_O_EXLOCK = 0x20;

/** 잠금 핸들 — 프로세스가 끝날 때까지 닫지 않는다(닫으면 잠금이 풀린다). */
let heldFd: number | undefined;
let heldServer: Server | undefined;

export async function acquireDaemonLock(paths: TermPaths): Promise<DaemonLockResult> {
  if (process.platform === "darwin") {
    try {
      heldFd = openSync(
        paths.lockFile,
        constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | DARWIN_O_EXLOCK,
        PRIVATE_FILE_MODE,
      );
      return { held: true };
    } catch (error) {
      if (isNodeError(error, "EAGAIN") || isNodeError(error, "EWOULDBLOCK")) {
        return { held: false };
      }
      throw error;
    }
  }
  if (process.platform === "linux") {
    const server = createServer((socket) => socket.destroy());
    return await new Promise<DaemonLockResult>((resolve, reject) => {
      server.once("error", (error) => {
        if (isNodeError(error, "EADDRINUSE")) {
          resolve({ held: false });
          return;
        }
        reject(error);
      });
      server.listen(paths.abstractLockName, () => {
        heldServer = server;
        // 잠금 소켓이 이벤트 루프를 붙잡지 않게 — 데몬은 스스로 끝낸다.
        server.unref();
        resolve({ held: true });
      });
    });
  }
  throw new Error(`ainecto term is not supported on ${process.platform} yet (macOS and Linux only).`);
}
