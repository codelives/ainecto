import { closeSync, constants, openSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import { TermError } from "./errors";
import type { TermPaths } from "./paths";

/**
 * 데몬 하나를 지키는 잠금 — ★OS 가 프로세스 수명 동안 쥐고, 죽으면 OS 가 푸는 잠금(설계 2-1 v3, 리뷰 #67 P2-L1).
 * 쥔 프로세스만 소켓을 지우고 만든다. 시간 초과·PID·번호 파일로 판정하지 않는다.
 * 플랫폼마다 수단이 다른 것은 이 함수 하나 안에 가둔다(호출처는 데몬 시작 하나).
 *
 *   macOS   : daemon.lock 을 O_EXLOCK|O_NONBLOCK 으로 연다 — 쥔 동안 다른 열기는 EAGAIN.
 *   Windows : daemon.lock 을 libuv 독점 공유 모드(UV_FS_O_EXLOCK — 공유 0)로 연다 — 쥔 동안 다른 열기는 EBUSY
 *             (libuv src/win/fs.c·error.c ERROR_SHARING_VIOLATION). flock 이 아니라 공유 모드 독점이다.
 *   Linux   : 추상 이름공간 Unix 소켓에 bind — 쥔 동안 다른 bind 는 EADDRINUSE. 파일이 남지 않는다.
 *
 * ★잠금 fd·소켓은 Node(libuv)가 CLOEXEC 로 연다 — PTY 자식이 물려받아 데몬이 죽은 뒤에도 잠금을 쥐는 일이 없다
 *   (시험: 데몬을 SIGKILL 한 뒤 HUP 을 무시하는 자식이 살아 있어도 새 데몬이 뜬다).
 */
export type DaemonLockResult = { held: true } | { held: false };

/**
 * Linux 추상 이름공간 소켓에 «이름 있는» bind 를 Node 가 지원하는 첫 판 — Node net 문서 «IPC support» 변경 이력 20.8.0.
 * 그 아래는 첫 NUL 뒤 이름이 잘리거나(18 — uid·폴더 구분이 사라져 다른 HOME 의 데몬끼리 잠금이 부딪침) bind 가
 * EINVAL(20.7) 이다(리뷰 #81 T6). ★CLI 전체의 하한(engines >=18)이 아니라 term 만의 하한이다.
 */
const LINUX_ABSTRACT_SOCKET_NODE: readonly [number, number, number] = [20, 8, 0];

/** term 을 이 런타임에서 쓸 수 없으면 그 이유(사람 말). 쓸 수 있으면 undefined. */
export function termRuntimeProblem(platform: NodeJS.Platform = process.platform, nodeVersion: string = process.versions.node): string | undefined {
  if (platform === "darwin") {
    return undefined;
  }
  if (platform === "linux") {
    return versionAtLeast(nodeVersion, LINUX_ABSTRACT_SOCKET_NODE)
      ? undefined
      : `ainecto term on Linux needs Node.js ${LINUX_ABSTRACT_SOCKET_NODE.join(".")} or newer (this is ${nodeVersion}): its daemon lock is `
        + "an abstract Unix socket, which older Node cannot bind by name. Other ainecto commands work on this Node.";
  }
  if (platform === "win32") {
    return undefined;
  }
  return `ainecto term is not supported on ${platform} yet (macOS, Linux and Windows only).`;
}

/** 데몬을 띄우기 «전에»(클라이언트) 그리고 잠금을 잡기 전에(데몬) 부른다. */
export function assertTermRuntime(): void {
  const problem = termRuntimeProblem();
  if (problem) {
    throw new TermError("TERM_RUNTIME_UNSUPPORTED", problem);
  }
}

function versionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const have = parts[index] ?? 0;
    const need = minimum[index] ?? 0;
    if (have !== need) {
      return have > need;
    }
  }
  return true;
}

/** macOS `sys/fcntl.h` `#define O_EXLOCK 0x00000020` — Node 가 상수를 주지 않는다. */
const DARWIN_O_EXLOCK = 0x20;
/** libuv `include/uv/win.h` `#define UV_FS_O_EXLOCK 0x10000000`(공유 모드 0) — Node 가 Windows 에서 상수를 주지 않는다. 결재 2026-11-21. */
const WIN32_UV_FS_O_EXLOCK = 0x10000000;

/** 파일 잠금 플랫폼 — 여는 플래그와 «다른 쪽이 쥐고 있음»의 오류 코드. */
const FILE_LOCK: Partial<Record<NodeJS.Platform, { flags: number; busy: readonly string[] }>> = {
  darwin: { flags: constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | DARWIN_O_EXLOCK, busy: ["EAGAIN", "EWOULDBLOCK"] },
  win32: { flags: constants.O_RDWR | constants.O_CREAT | WIN32_UV_FS_O_EXLOCK, busy: ["EBUSY"] },
};

/** 잠금 핸들 — 데몬 잠금은 프로세스가 끝날 때까지 닫지 않는다(닫으면 잠금이 풀린다). */
const held: Array<{ release(): void }> = [];

export async function acquireDaemonLock(paths: TermPaths): Promise<DaemonLockResult> {
  const lock = await acquireProcessLock(paths);
  if (!lock) return { held: false };
  held.push(lock);
  return { held: true };
}

/**
 * PC 다리 하나를 지키는 잠금(approve-new-device §3-6) — 데몬 잠금과 같은 수단 · 다른 이름. 기기 지우기가 이 키 파일의 마지막 말이 되게
 * 한 사용자·한 앱 폴더에 다리는 하나만 돈다.
 */
export async function acquirePcBridgeLock(paths: TermPaths): Promise<{ release(): void } | undefined> {
  return await acquireProcessLock({
    lockFile: paths.lockFile.replace(/daemon\.lock$/, "pc-bridge.lock"),
    abstractLockName: paths.abstractLockName.replace(/\.lock$/, "-pc-bridge.lock"),
  });
}

/**
 * 데몬 잠금이 풀릴 때까지 기다린다(최대 ms) — 풀렸으면 true. 잡아 보고 바로 놓는다(데몬 자리를 차지하지 않는다).
 * ★옛 데몬이 «끝났나»는 이 잠금으로만 본다 — daemon.json 의 pid 는 데몬이 끝나도 남고, Windows 는 pid 를 금방 다른 프로세스에
 *   다시 준다(KAN-1375 · 그 pid 가 살아 있다고 보고 매번 «did not stop» 으로 멈췄다).
 */
export async function waitForDaemonLockFree(paths: TermPaths, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  for (;;) {
    const lock = await acquireProcessLock(paths);
    if (lock) {
      lock.release();
      return true;
    }
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 잠금 하나 — 쥐었으면 푸는 손잡이, 남이 쥐고 있으면 undefined. 프로세스가 죽으면 OS 가 푼다. */
async function acquireProcessLock(paths: Pick<TermPaths, "lockFile" | "abstractLockName">): Promise<{ release(): void } | undefined> {
  assertTermRuntime();
  const fileLock = FILE_LOCK[process.platform];
  if (fileLock) {
    try {
      const fd = openSync(paths.lockFile, fileLock.flags, PRIVATE_FILE_MODE);
      return { release: () => closeSync(fd) };
    } catch (error) {
      if (fileLock.busy.some((code) => isNodeError(error, code))) {
        return undefined;
      }
      throw error;
    }
  }
  if (process.platform === "linux") {
    const server = createServer((socket) => socket.destroy());
    return await new Promise<{ release(): void } | undefined>((resolve, reject) => {
      server.once("error", (error) => {
        if (isNodeError(error, "EADDRINUSE")) {
          resolve(undefined);
          return;
        }
        reject(error);
      });
      server.listen(paths.abstractLockName, () => {
        // 잠금 소켓이 이벤트 루프를 붙잡지 않게 — 데몬은 스스로 끝낸다.
        server.unref();
        resolve({ release: () => server.close() });
      });
    });
  }
  // assertTermRuntime 이 이미 막았다 — 여기 오면 위 플랫폼 분기와 그 함수가 어긋난 것이다.
  throw new TermError("TERM_RUNTIME_UNSUPPORTED", `No daemon lock for ${process.platform}.`);
}
