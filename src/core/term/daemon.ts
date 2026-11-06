import { chmod, stat, unlink, writeFile } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import { acquireDaemonLock } from "./daemonLock";
import { DaemonLog } from "./daemonLog";
import { TermError } from "./errors";
import { readManifest, writeManifest, type ManifestEntry } from "./manifest";
import type { TermPaths } from "./paths";
import {
  encodeLine,
  LineDecoder,
  parseClientMessage,
  RETRY_CODE,
  type TermClientMessage,
  type TermEvent,
  type TermRequest,
  type TermResponse,
} from "./protocol";
import { assertSessionName } from "./sessionName";
import { TermSession, type SessionSink } from "./session";

/** 데몬을 띄운 클라이언트에게 «준비됨/이미 있음/실패»를 알리는 한 줄(설계 2-1 «뜨는 때»). */
export type DaemonReadiness = { status: "ready" } | { status: "locked" } | { status: "error"; message: string };

export interface DaemonOptions {
  paths: TermPaths;
  version: string;
  ready: (readiness: DaemonReadiness) => void;
}

/**
 * 상주 프로세스 `ainecto term daemon`(설계 2-1). 반환값은 끝날 때의 종료 코드.
 *
 *   시작: ① 잠금을 비차단으로 잡는다 — 못 잡으면 다른 데몬이 살아 있으니 바로 끝낸다
 *         ② 잡은 쪽만 pid 를 daemon.json 에(안내용 — 판정에 쓰지 않는다) ③ 옛 ctl.sock 을 지우고 bind.
 *         ★②를 bind «전에» 쓴다 — 잠금을 쥔 채 bind 전에 멈춘 데몬이 있으면 클라이언트가 그 pid 를 알려 줄 수 있다.
 *   끝: 세션 0개 + 연결 0개가 되면, 또는 kill-server·SIGTERM 이면. 리스너를 먼저 닫고, 그 뒤에 온 요청에는
 *       RETRY 를 답하고, 처리 중인 요청을 마친 뒤 자기 소켓을 지우고 끝난다. 잠금은 프로세스가 끝날 때 OS 가 푼다.
 */
export async function runDaemon(options: DaemonOptions): Promise<number> {
  const { paths } = options;
  await ensurePrivateDir(paths.dir);
  const log = new DaemonLog(paths.log, paths.previousLog);
  // 준비 통보 — 띄운 쪽이 이미 떠났으면(준비 대기 10초가 지난 뒤 다시 움직인 경우 — 리뷰 #82 S1) 통보 실패를
  // 남기고 데몬의 보통 수명을 그대로 산다. 통보 실패가 데몬을 반쯤 뜬 채로 두지 않는다.
  const notify = (readiness: DaemonReadiness): boolean => {
    try {
      options.ready(readiness);
      return true;
    } catch (error) {
      log.write({ event: "ready_unread", pid: process.pid, status: readiness.status, message: errorMessage(error) });
      return false;
    }
  };
  if (!(await claimDaemon(paths, options.version))) {
    log.write({ event: "daemon_locked", pid: process.pid });
    notify({ status: "locked" });
    return 1;
  }
  log.enableRotation();
  let manifest: ManifestEntry[];
  try {
    manifest = await readManifest(paths.manifest);
  } catch (error) {
    // 깨진 매니페스트가 데몬을 막지 않게 — 빈 목록으로 시작하고, 다음 쓰기가 덮는다. 이유는 남긴다.
    log.write({ event: "manifest_error", message: errorMessage(error) });
    manifest = [];
  }
  const daemon = new TermDaemon(paths, log, manifest);
  await daemon.listen();
  log.write({ event: "daemon_start", pid: process.pid, version: options.version, socket: paths.socket });
  process.on("SIGTERM", () => void daemon.shutdown("SIGTERM"));
  process.on("SIGINT", () => void daemon.shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    log.write({ event: "daemon_crash", pid: process.pid, error: error.stack ?? error.message });
    process.exit(1);
  });
  if (!notify({ status: "ready" })) {
    // 붙으러 올 쪽이 없다 — 세션·연결이 없으면 보통의 유휴 종료로 끝난다(잠금은 프로세스가 끝날 때 OS 가 푼다).
    daemon.stopIfIdle();
  }
  return await daemon.finished;
}

/**
 * 데몬 자리를 차지한다 — 잠금을 잡고, 잡았으면 pid 를 daemon.json 에 쓴다. 못 잡으면 false.
 * 데몬 시작의 ①②이고, 시험이 «잠금을 쥔 채 bind 전에 멈춘 데몬»을 같은 코드로 만든다.
 */
export async function claimDaemon(paths: TermPaths, version: string): Promise<boolean> {
  const lock = await acquireDaemonLock(paths);
  if (!lock.held) {
    return false;
  }
  await writeFile(paths.daemonInfo, `${JSON.stringify({ pid: process.pid, version, startedAt: new Date().toISOString() })}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  return true;
}

interface Handled {
  data: unknown;
  /** 응답 줄을 쓴 «뒤에» 할 일(attach 의 첫 화면, kill-server 의 종료). */
  after?: () => void;
}

class TermDaemon {
  private readonly sessions = new Map<string, TermSession>();
  private readonly connections = new Set<Connection>();
  private readonly server: Server;
  private nextConnection = 1;
  /** 띄우는 중인 이름 — new·restore 가 같은 이름을 겹쳐 띄우지 않게(리뷰 #81 T1). */
  private readonly starting = new Set<string>();
  private inflight = 0;
  /** 처리 중인 요청 수가 줄 때마다 깨운다. */
  private inflightWaiters: (() => void)[] = [];
  /** 새 요청을 받지 않는다 — 이후 요청은 RETRY. */
  private shuttingDown = false;
  private stopping = false;
  private manifestWrite: Promise<void> = Promise.resolve();
  private resolveFinished: (code: number) => void = () => undefined;
  readonly finished = new Promise<number>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(
    private readonly paths: TermPaths,
    private readonly log: DaemonLog,
    private manifest: ManifestEntry[],
  ) {
    this.server = createServer((socket) => this.accept(socket));
  }

  async listen(): Promise<void> {
    // ★잠금을 쥔 프로세스만 여기 온다 — 옛 세대의 소켓을 지워도 살아 있는 데몬의 소켓일 수 없다.
    try {
      await unlink(this.paths.socket);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.paths.socket, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    await chmod(this.paths.socket, PRIVATE_FILE_MODE);
  }

  /** 끝낸다 — 세션·매니페스트는 건드리지 않는다(SIGTERM·세션 0). 세션까지 끝내는 kill-server 는 handle 이 먼저 정리한다. */
  async shutdown(reason: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.stopAccepting();
    await this.inflightAtMost(0);
    await this.manifestWrite;
    for (const connection of this.connections) {
      connection.end();
    }
    try {
      unlinkSync(this.paths.socket);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        this.log.write({ event: "daemon_crash", pid: process.pid, error: `could not remove ${this.paths.socket}: ${errorMessage(error)}` });
      }
    }
    this.log.write({ event: "daemon_stop", pid: process.pid, reason });
    this.resolveFinished(0);
  }

  /** 리스너를 닫고 이후 요청에 RETRY 를 답한다. 여러 번 불러도 한 번. */
  private stopAccepting(): void {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.server.close();
    }
  }

  /** 처리 중인 요청이 `remaining` 개 이하가 될 때까지 기다린다. */
  private async inflightAtMost(remaining: number): Promise<void> {
    while (this.inflight > remaining) {
      await new Promise<void>((resolve) => this.inflightWaiters.push(resolve));
    }
  }

  private accept(socket: Socket): void {
    const connection = new Connection(this.nextConnection++, socket, (message) => this.receive(connection, message), (code, message) => {
      this.log.write({ event: "bad_message", conn: connection.id, code, message });
    });
    this.connections.add(connection);
    socket.on("close", () => {
      this.connections.delete(connection);
      for (const session of this.sessions.values()) {
        session.forget(connection);
      }
      if (connection.attachedTo) {
        this.log.write({ event: "detach", conn: connection.id, name: connection.attachedTo.name, reason: "connection closed" });
      }
      this.stopIfIdle();
    });
  }

  private receive(connection: Connection, message: TermClientMessage): void {
    if (message.op === "in") {
      connection.attachedTo?.input(connection, Buffer.from(message.d, "base64"));
      return;
    }
    if (message.op === "resize") {
      connection.attachedTo?.resizeFrom(connection, message.cols, message.rows);
      return;
    }
    void this.request(connection, message);
  }

  /** 요청 1줄 + 응답 1줄 — 응답 줄은 성공·실패·RETRY 어느 경우에도 반드시 남는다(실행 원칙 3). */
  private async request(connection: Connection, request: TermRequest): Promise<void> {
    const startedAt = Date.now();
    this.log.write({ event: "request", id: request.id, conn: connection.id, op: request.op, ...requestMeta(request) });
    let response: TermResponse;
    let after: (() => void) | undefined;
    if (this.shuttingDown) {
      response = { id: request.id, ok: false, error: { code: RETRY_CODE, message: "The term daemon is stopping; retry with the next one." } };
    } else {
      this.inflight += 1;
      try {
        const handled = await this.handle(connection, request);
        response = { id: request.id, ok: true, data: handled.data };
        after = handled.after;
      } catch (error) {
        response = { id: request.id, ok: false, error: { code: errorCode(error), message: errorMessage(error) } };
      } finally {
        this.inflight -= 1;
        for (const wake of this.inflightWaiters.splice(0)) {
          wake();
        }
      }
    }
    connection.respond(response);
    this.log.write({
      event: "response",
      id: request.id,
      conn: connection.id,
      op: request.op,
      ok: response.ok,
      ...(response.ok ? {} : { code: response.error.code, message: response.error.message }),
      ms: Date.now() - startedAt,
    });
    after?.();
  }

  private async handle(connection: Connection, request: TermRequest): Promise<Handled> {
    switch (request.op) {
      case "new": {
        assertSessionName(request.name);
        const entry: ManifestEntry = { name: request.name, cwd: request.cwd, command: request.command, createdAt: new Date().toISOString() };
        const session = await this.startSession(entry, request.env, request.cols, request.rows);
        this.updateManifest((entries) => [...entries.filter((item) => item.name !== entry.name), entry]);
        return { data: session.info() };
      }
      case "ls":
        return { data: { sessions: [...this.sessions.values()].map((session) => session.info()) } };
      case "send":
        await this.session(request.name).send(request.text, request.paste);
        return { data: { name: request.name, sent: request.text.length } };
      case "key":
        await this.session(request.name).key(request.key);
        return { data: { name: request.name, key: request.key } };
      case "read": {
        const lines = await this.session(request.name).read({ scrollback: request.scrollback, lines: request.lines }, connection);
        return { data: { name: request.name, lines } };
      }
      case "kill": {
        const session = this.session(request.name);
        this.sessions.delete(request.name);
        session.kill();
        this.updateManifest((entries) => entries.filter((item) => item.name !== request.name));
        return { data: { name: request.name, killed: true } };
      }
      case "kill-server": {
        // ★먼저 새 요청을 막고, 이미 받은 생성(new·restore)을 마치게 한 «뒤» 일괄로 끝낸다 — 성공을 답한 생성이
        //   목록·매니페스트에서 빠지거나 남지 않는다(리뷰 #81 T7). 남은 처리 중 요청은 이 요청 하나다.
        this.stopAccepting();
        await this.inflightAtMost(1);
        const names = [...this.sessions.keys()];
        for (const session of this.sessions.values()) {
          session.kill();
        }
        this.sessions.clear();
        this.updateManifest(() => []);
        return { data: { killed: names }, after: () => void this.shutdown("kill-server") };
      }
      case "restore":
        return { data: await this.restore(request.env) };
      case "attach": {
        const session = this.session(request.name);
        connection.attachedTo = session;
        this.log.write({ event: "attach", conn: connection.id, name: session.name });
        return { data: { name: session.name }, after: () => session.attach(connection, request.cols, request.rows) };
      }
      case "detach": {
        const session = connection.attachedTo;
        if (!session) {
          throw new TermError("TERM_NOT_ATTACHED", "This connection is not attached to a session.");
        }
        connection.attachedTo = undefined;
        this.log.write({ event: "detach", conn: connection.id, name: session.name, reason: "detach key" });
        return { data: { name: session.name, reset: Buffer.from(session.detach(connection), "utf8").toString("base64") } };
      }
      case "watch":
        this.session(request.name).watch(connection);
        return { data: { name: request.name } };
    }
  }

  private session(name: string): TermSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new TermError("TERM_NO_SESSION", `No session named "${name}".`);
    }
    return session;
  }

  /**
   * 세션을 띄우는 곳은 여기 하나(new·restore). ★이름은 첫 await «전에» 확보한다 — 검사와 등록 사이에 같은 이름의
   * 다른 요청이 끼어 PTY 를 둘 띄우지 못하게(리뷰 #81 T1). 실패하면 확보를 푼다.
   */
  private async startSession(entry: ManifestEntry, env: Record<string, string>, cols?: number, rows?: number): Promise<TermSession> {
    if (this.sessions.has(entry.name) || this.starting.has(entry.name)) {
      throw new TermError("TERM_SESSION_EXISTS", `A session named "${entry.name}" already exists.`);
    }
    this.starting.add(entry.name);
    try {
      await assertDirectory(entry.cwd);
      const session = await TermSession.start(
        { ...entry, env, cols, rows },
        (ended, exitCode, signal) => this.sessionEnded(ended, exitCode, signal),
      );
      this.sessions.set(entry.name, session);
      this.log.write({ event: "session_start", name: entry.name, pid: session.info().pid, cwd: entry.cwd, shell: entry.command === null });
      return session;
    } finally {
      this.starting.delete(entry.name);
    }
  }

  /**
   * 세션이 스스로 끝났다. ★매니페스트에서 지우는 것은 «신호 없이» 끝났을 때만이다 — 신호로 끝난 세션(재부팅·로그아웃 때
   * 시스템이 보낸 SIGTERM·SIGHUP 포함)은 `restore` 가 다시 띄울 수 있게 남긴다. kill 로 지운 세션은 이미 표에 없다.
   */
  private sessionEnded(session: TermSession, exitCode: number, signal: number): void {
    const current = this.sessions.get(session.name) === session;
    const kept = current && signal !== 0;
    if (current) {
      this.sessions.delete(session.name);
      if (!kept) {
        this.updateManifest((entries) => entries.filter((item) => item.name !== session.name));
      }
    }
    this.log.write({ event: "session_exit", name: session.name, pid: session.info().pid, exitCode, signal, kept });
    this.stopIfIdle();
  }

  private async restore(env: Record<string, string>): Promise<{ restored: string[]; running: string[]; failed: { name: string; code: string; message: string }[] }> {
    const restored: string[] = [];
    const running: string[] = [];
    const failed: { name: string; code: string; message: string }[] = [];
    for (const entry of this.manifest) {
      if (this.sessions.has(entry.name) || this.starting.has(entry.name)) {
        running.push(entry.name);
        continue;
      }
      try {
        await this.startSession(entry, env);
        restored.push(entry.name);
      } catch (error) {
        failed.push({ name: entry.name, code: errorCode(error), message: errorMessage(error) });
      }
    }
    return { restored, running, failed };
  }

  /** 매니페스트는 데몬 하나만 쓴다 — 쓰기를 한 줄로 세운다. */
  private updateManifest(change: (entries: ManifestEntry[]) => ManifestEntry[]): void {
    this.manifest = change(this.manifest);
    const snapshot = this.manifest;
    this.manifestWrite = this.manifestWrite
      .then(() => writeManifest(this.paths.manifest, snapshot))
      .catch((error) => this.log.write({ event: "manifest_error", message: errorMessage(error) }));
  }

  /** 세션 0개·연결 0개면 끝낸다. */
  stopIfIdle(): void {
    if (!this.shuttingDown && this.sessions.size === 0 && this.connections.size === 0) {
      void this.shutdown("no sessions");
    }
  }
}

/** 소켓 하나. 들어오는 줄을 메시지로, 나가는 응답·이벤트를 줄로. */
class Connection implements SessionSink {
  attachedTo: TermSession | undefined;
  private readonly decoder = new LineDecoder();

  constructor(
    readonly id: number,
    private readonly socket: Socket,
    onMessage: (message: TermClientMessage) => void,
    onBadMessage: (code: string, message: string) => void,
  ) {
    socket.on("data", (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) {
        try {
          onMessage(parseClientMessage(line));
        } catch (error) {
          // 모양이 틀린 줄 — 누가 보냈는지 모르는 연결이라 끊는다. 이유는 남긴다.
          onBadMessage(errorCode(error), errorMessage(error));
          socket.destroy();
          return;
        }
      }
    });
    // 끊긴 상대에게 쓰다 난 오류(EPIPE 등)가 데몬을 죽이지 않게 — 닫힘은 close 에서 정리한다.
    socket.on("error", (error) => onBadMessage(errorCode(error), errorMessage(error)));
  }

  send(event: TermEvent): void {
    this.write(encodeLine(event));
  }

  respond(response: TermResponse): void {
    this.write(encodeLine(response));
  }

  end(): void {
    this.socket.end();
  }

  private write(line: string): void {
    if (this.socket.writable) {
      this.socket.write(line);
    }
  }
}

async function assertDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) {
      return;
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  throw new TermError("TERM_BAD_CWD", `${path} is not a directory.`);
}

/** 로그에 실을 요청 메타 — ★글·키 내용·환경변수는 싣지 않는다(키 이름은 싣는다). */
function requestMeta(request: TermRequest): { name?: string; textLength?: number; key?: string } {
  switch (request.op) {
    case "send":
      return { name: request.name, textLength: request.text.length };
    case "key":
      return { name: request.name, key: request.key };
    case "new":
    case "read":
    case "kill":
    case "attach":
    case "watch":
      return { name: request.name };
    default:
      return {};
  }
}

function errorCode(error: unknown): string {
  if (error instanceof TermError) {
    return error.code;
  }
  if (error instanceof Error && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "TERM_INTERNAL";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
