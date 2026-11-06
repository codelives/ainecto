import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { Readable } from "node:stream";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import type { DaemonReadiness } from "./daemon";
import { assertTermRuntime } from "./daemonLock";
import { TermError } from "./errors";
import { DAEMON_RESPONSE_TIMEOUT_MS, DAEMON_START_ATTEMPTS } from "./limits";
import type { TermPaths } from "./paths";
import {
  encodeLine,
  LineDecoder,
  parseDaemonMessage,
  RETRY_CODE,
  type TermEvent,
  type TermRequest,
  type TermRequestBody,
  type TermStreamInput,
} from "./protocol";

/**
 * 제어 소켓 연결 하나. 요청마다 id 를 붙이고 같은 id 의 응답으로 푼다. 응답이 아닌 줄은 이벤트(attach·watch).
 * ★요청 하나의 응답은 {@link DAEMON_RESPONSE_TIMEOUT_MS} 까지 기다리고, 넘으면 «데몬 응답 없음»으로 끝난다.
 *   아무것도 정리하지 않는다(소켓을 지우거나 새 데몬을 띄우지 않는다 — 설계 2-1). 이벤트 흐름에는 상한이 없다.
 */
export class TermClient {
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private eventHandler: (event: TermEvent) => void = () => undefined;
  private closeHandler: () => void = () => undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly paths: TermPaths,
  ) {
    socket.on("data", (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) {
        this.receive(line);
      }
    });
    socket.on("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new TermError("TERM_DAEMON_GONE", `The term daemon closed the connection before answering — see ${paths.log}.`));
      }
      this.pending.clear();
      this.closeHandler();
    });
    // 오류 뒤에는 close 가 온다 — 거기서 정리한다.
    socket.on("error", () => undefined);
  }

  static connect(paths: TermPaths): Promise<TermClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(paths.socket);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new TermClient(socket, paths));
      });
      socket.once("error", reject);
    });
  }

  request(body: TermRequestBody): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const pid = daemonPid(this.paths);
        reject(new TermError(
          "TERM_DAEMON_NO_RESPONSE",
          `The term daemon${pid ? ` (pid ${pid})` : ""} did not answer "${body.op}" within ${DAEMON_RESPONSE_TIMEOUT_MS / 1000} s. `
            + "It may be stopped or busy; nothing was cleaned up. "
            + `${pid ? `If it is stopped: kill -CONT ${pid}. If it hangs: kill ${pid}. ` : ""}See ${this.paths.log}.`,
        ));
        // ★우리 연결만 끊는다 — end() 는 멈춘 데몬이 끝을 받아 줄 때까지 연결을 붙잡아 명령이 끝나지 않는다.
        this.socket.destroy();
      }, DAEMON_RESPONSE_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      const request: TermRequest = { ...body, id };
      this.socket.write(encodeLine(request));
    });
  }

  stream(message: TermStreamInput): void {
    this.socket.write(encodeLine(message));
  }

  onEvent(handler: (event: TermEvent) => void): void {
    this.eventHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  close(): void {
    this.socket.end();
  }

  private receive(line: string): void {
    const message = parseDaemonMessage(line);
    if ("event" in message) {
      this.eventHandler(message);
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) {
      return;
    }
    this.pending.delete(message.id);
    if (message.ok) {
      waiter.resolve(message.data);
    } else {
      waiter.reject(new TermError(message.error.code, message.error.message));
    }
  }
}

/**
 * 데몬에 붙는다. 없으면(`start`) 띄우고 다시 붙는다(설계 2-1 «뜨는 때»).
 * ★클라이언트는 소켓 파일을 «절대» 지우지 않는다. `ENOENT`·`ECONNREFUSED` 면 데몬을 띄울 뿐이고, 그 데몬이
 *   잠금을 못 잡으면(다른 데몬이 살아 있거나 뜨는 중) 다시 붙어 본다. 하나만 뜨는 것은 잠금이 보장한다.
 *   띄우기는 {@link DAEMON_START_ATTEMPTS} 번까지 — 잠금을 쥔 데몬이 bind 전에 멈춰 있으면 그 pid 를 알려 주고 끝난다.
 * `start` 가 false 면(ls·read 등) 데몬이 없을 때 undefined — 세션이 없다는 뜻이다.
 */
export async function openTermClient(paths: TermPaths, options: { start: boolean }): Promise<TermClient | undefined> {
  for (let started = 0; ; started += 1) {
    try {
      return await TermClient.connect(paths);
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ECONNREFUSED") && !isNodeError(error, "ECONNRESET")) {
        throw error;
      }
      if (!options.start) {
        return undefined;
      }
    }
    if (started === DAEMON_START_ATTEMPTS) {
      throw new TermError("TERM_DAEMON_START", notListening(paths));
    }
    // 띄우기 «전에» 런타임을 본다 — 못 쓰는 런타임에서 데몬을 띄워 알 수 없는 오류를 받지 않게(리뷰 #81 T6).
    assertTermRuntime();
    await ensurePrivateDir(paths.dir);
    const readiness = await spawnDaemon(paths);
    if (readiness.status === "error") {
      throw new TermError("TERM_DAEMON_START", `The term daemon did not start: ${readiness.message}`);
    }
  }
}

/** 요청 하나를 보내고 답을 받는다. 데몬이 끝나는 중이라 RETRY 를 답하면 다음 데몬에 다시 보낸다. */
export async function termRequest(
  paths: TermPaths,
  body: TermRequestBody,
  options: { start: boolean },
): Promise<{ daemon: true; data: unknown } | { daemon: false }> {
  for (;;) {
    const client = await openTermClient(paths, options);
    if (!client) {
      return { daemon: false };
    }
    try {
      return { daemon: true, data: await client.request(body) };
    } catch (error) {
      if (error instanceof TermError && error.code === RETRY_CODE) {
        continue;
      }
      throw error;
    } finally {
      client.close();
    }
  }
}

/**
 * 자기 자신을 `term daemon --ready-fd 3` 으로 detached 로 띄우고 준비 한 줄을 기다린다.
 * ★지금 실행 중인 같은 CLI(같은 node·같은 실행 인자)로 띄운다 — 판이 다른 데몬이 섞이지 않게.
 */
/**
 * 띄운 데몬의 결과 — 준비 한 줄, 또는 {@link DAEMON_RESPONSE_TIMEOUT_MS} 안에 아무 말이 없음(silent).
 * ★silent 여도 그 자식을 죽이지 않는다 — 시간 초과는 잠금 탈취·소켓 삭제의 근거가 아니다(설계 2-1, 리뷰 #81 T4).
 *   기다림을 멈추고 한 번의 시도로 센다. 그 자식이 잠금을 쥐고 멈췄다면 다음 시도들이 «locked» 를 받고,
 *   마지막 오류가 daemon.json 의 pid 를 알려 준다.
 */
type SpawnOutcome = DaemonReadiness | { status: "silent" };

async function spawnDaemon(paths: TermPaths): Promise<SpawnOutcome> {
  const entry = process.argv[1];
  if (!entry) {
    throw new TermError("TERM_DAEMON_START", "Cannot find the ainecto entry script to start the term daemon.");
  }
  // ★데몬의 stderr 는 daemon.log 로 — 우리 코드가 돌기 전에 죽는 경우(모듈을 못 찾음 등)의 이유도 남는다.
  const stderrFd = openSync(paths.log, "a", PRIVATE_FILE_MODE);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [...process.execArgv, entry, "term", "daemon", "--ready-fd", "3"], {
      cwd: paths.dir,
      detached: true,
      stdio: ["ignore", "ignore", stderrFd, "pipe"],
      env: process.env,
    });
  } finally {
    closeSync(stderrFd);
  }
  const channel = child.stdio[3];
  if (!(channel instanceof Readable)) {
    child.kill();
    throw new TermError("TERM_DAEMON_START", "Could not open the readiness pipe to the term daemon.");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<SpawnOutcome>((resolve, reject) => {
      timer = setTimeout(() => resolve({ status: "silent" }), DAEMON_RESPONSE_TIMEOUT_MS);
      const decoder = new LineDecoder();
      channel.on("data", (chunk: Buffer) => {
        const line = decoder.push(chunk)[0];
        if (line !== undefined) {
          resolve(parseReadiness(line));
        }
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolve({ status: "error", message: `daemon exited (${signal ?? code}) before it was ready — see ${paths.log}` });
      });
    });
  } finally {
    clearTimeout(timer);
    channel.destroy();
    child.unref();
  }
}

function parseReadiness(line: string): DaemonReadiness {
  const value: unknown = JSON.parse(line);
  if (value && typeof value === "object" && "status" in value) {
    const status = (value as { status: unknown }).status;
    if (status === "ready" || status === "locked") {
      return { status };
    }
    if (status === "error") {
      const message = (value as { message?: unknown }).message;
      return { status, message: typeof message === "string" ? message : "unknown error" };
    }
  }
  return { status: "error", message: `unexpected readiness line: ${line}` };
}

/** daemon.json 의 pid — 안내용. 없거나 못 읽으면 undefined. */
function daemonPid(paths: TermPaths): number | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(paths.daemonInfo, "utf8"));
    const pid = value && typeof value === "object" && "pid" in value ? value.pid : undefined;
    return typeof pid === "number" ? pid : undefined;
  } catch {
    // 안내 문장에 pid 를 못 넣을 뿐이다 — 오류 자체는 호출한 쪽이 낸다.
    return undefined;
  }
}

function notListening(paths: TermPaths): string {
  const pid = daemonPid(paths);
  const holder = pid !== undefined && isAlive(pid)
    ? `Daemon pid ${pid} holds the lock but is not listening on ${paths.socket} — it may be stopped (kill -CONT ${pid}) or hung (kill ${pid}).`
    : "No running daemon answered.";
  return `Could not reach the term daemon after starting it ${DAEMON_START_ATTEMPTS} times. ${holder} See ${paths.log}.`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM = 살아 있지만 남의 프로세스(같은 사용자 폴더라 드물다).
    return isNodeError(error, "EPERM");
  }
}
