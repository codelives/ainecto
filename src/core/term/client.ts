import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import { Readable } from "node:stream";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import type { DaemonReadiness } from "./daemon";
import { TermError } from "./errors";
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
 * ★응답을 기다리는 시간 상한은 두지 않는다 — 설계 2-1 «데몬 응답 대기 시간»은 값이 결재되지 않았다.
 *   늦으면 기다릴 뿐이고, 아무것도 정리하지 않는다(소켓을 지우거나 새 데몬을 띄우지 않는다).
 */
export class TermClient {
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>();
  private eventHandler: (event: TermEvent) => void = () => undefined;
  private closeHandler: () => void = () => undefined;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) {
        this.receive(line);
      }
    });
    socket.on("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new TermError("TERM_DAEMON_GONE", "The term daemon closed the connection before answering — see ~/.ainecto/term/daemon.log."));
      }
      this.pending.clear();
      this.closeHandler();
    });
    // 오류 뒤에는 close 가 온다 — 거기서 정리한다.
    socket.on("error", () => undefined);
  }

  static connect(socketPath: string): Promise<TermClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      socket.once("connect", () => {
        socket.off("error", reject);
        resolve(new TermClient(socket));
      });
      socket.once("error", reject);
    });
  }

  request(body: TermRequestBody): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
 * `start` 가 false 면(ls·read 등) 데몬이 없을 때 undefined — 세션이 없다는 뜻이다.
 */
export async function openTermClient(paths: TermPaths, options: { start: boolean }): Promise<TermClient | undefined> {
  for (;;) {
    try {
      return await TermClient.connect(paths.socket);
    } catch (error) {
      if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ECONNREFUSED") && !isNodeError(error, "ECONNRESET")) {
        throw error;
      }
      if (!options.start) {
        return undefined;
      }
    }
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
async function spawnDaemon(paths: TermPaths): Promise<DaemonReadiness> {
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
  try {
    return await new Promise<DaemonReadiness>((resolve, reject) => {
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
