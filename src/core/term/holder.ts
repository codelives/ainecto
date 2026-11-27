import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { ensurePrivateDir, isNodeError, writePrivateFileAtomic } from "../fs/privateFiles";
import { endedFromOutside } from "../os/launch";
import { acquireDaemonLock } from "./daemonLock";
import { DaemonLog } from "./daemonLog";
import { errorCode, errorMessage, TermError } from "./errors";
import { HOLDER_TALK, type HolderCaps } from "./holderTalk";
import { afterListen, helloProof, prepareListen, type IpcAddress } from "./ipc";
import { mergeEnded, readEndedBook, removeEndedBook, withEnded, withListedTo, withoutAcked, writeEndedBook } from "./endedBook";
import { readManifest, writeManifest, type ManifestEntry } from "./manifest";
import type { TermPaths } from "./paths";
import {
  encodeLine,
  LineDecoder,
  parseClientMessage,
  RETRY_CODE,
  type EndedRecord,
  type EndReason,
  type TermClientMessage,
  type TermEvent,
  type TermRequest,
  type TermResponse,
} from "./protocol";
import { assertSessionName } from "./sessionName";
import { ComputeSlot } from "./computeSlot";
import { TermSession, type SessionCompute, type SessionSink } from "./session";

/** 띄운 쪽(바깥)에게 «준비됨/이미 있음/실패»를 알리는 한 줄 — 바깥·holder 가 같은 모양을 쓴다. */
export type DaemonReadiness = { status: "ready" } | { status: "locked" } | { status: "error"; message: string };

export interface HolderOptions {
  paths: TermPaths;
  version: string;
  ready: (readiness: DaemonReadiness) => void;
}

/** 임대 없이 온 요청의 오류 코드 — 이 연결의 바깥이 쓰기 임대를 쥐고 있지 않다(넘기기 중 · 설계 3-4). 바깥은 받는 즉시 RETRY 로 바꾼다. */
export const NO_LEASE_CODE = "TERM_HOLDER_NO_LEASE";
/** kill-server 에 holder uuid 가 없다 — 구판 CLI(설계 3-4 · G4). */
export const CLI_OUTDATED_CODE = "TERM_CLI_OUTDATED";

/** 임대·via 없이도 받는 op — 증명·기능 묻기·임대 잡기. */
const OPEN_OPS: ReadonlySet<string> = new Set(["hello", "caps", "lease", "via"]);

/**
 * 상주 프로세스 `ainecto term holder`(세션 유지 구조 설계 3-1) — PC 에 한 벌. 세션(PTY·헤드리스 화면·질의 응답·attach·크기)과
 * 이름 예약·uuid·종류 배정·끝 기록 책·매니페스트의 주인이다. 바깥(`term daemon`)만 붙고, 바깥은 판마다 프로세스째 갈린다.
 * 반환값은 끝날 때의 종료 코드.
 *
 *   시작: ① 옛 데몬 잠금(daemon.lock)을 비차단으로 잡는다 — 평생 쥔다(그동안 구판 데몬은 뜰 수 없다). 못 잡으면 바로 끝낸다
 *         ② holder.json 에 pid·판·uuid(안내용) ③ holder 주소에 bind.
 *   끝: 세션 0개 + (임대 연결 말고) 연결 0개가 되면, 또는 kill-server·SIGTERM 이면. 데몬 때와 같은 순서로 끝낸다.
 */
export async function runHolder(options: HolderOptions): Promise<number> {
  const { paths } = options;
  await ensurePrivateDir(paths.dir);
  const log = new DaemonLog(paths.holderLog, paths.previousHolderLog);
  const notify = (readiness: DaemonReadiness): boolean => {
    try {
      options.ready(readiness);
      return true;
    } catch (error) {
      log.write({ event: "ready_unread", pid: process.pid, status: readiness.status, message: errorMessage(error) });
      return false;
    }
  };
  const info = await claimHolder(paths, options.version, randomUUID());
  if (!info) {
    log.write({ event: "daemon_locked", pid: process.pid });
    notify({ status: "locked" });
    return 1;
  }
  log.enableRotation();
  let manifest: ManifestEntry[];
  try {
    manifest = await readManifest(paths.manifest);
  } catch (error) {
    // 깨진 매니페스트가 holder 를 막지 않게 — 빈 목록으로 시작하고, 다음 쓰기가 덮는다. 이유는 남긴다.
    log.write({ event: "manifest_error", message: errorMessage(error) });
    manifest = [];
  }
  let ended: EndedRecord[] = [];
  let endedUnread = false;
  let pending: EndedRecord[] = [];
  try {
    // 앞 holder 가 원본을 못 읽는 동안 생긴 끝 기록(리뷰 r2 P1-2) — 원본 위에 얹는다(같은 이름은 이것).
    pending = await readEndedBook(paths.endedPending);
  } catch (error) {
    log.write({ event: "ended_book_error", message: `${paths.endedPending}: ${errorMessage(error)}` });
  }
  try {
    ended = await readEndedBook(paths.ended);
  } catch (error) {
    // ★못 읽은 책은 덮지 않는다(리뷰 0.16.6 P1-2) — 빈 책으로 시작하되, 다시 읽어 합칠 때까지 파일에 쓰지 않는다(원본 보존).
    log.write({ event: "ended_book_error", message: errorMessage(error) });
    endedUnread = true;
  }
  ended = mergeEnded(ended, pending, new Set());
  const compute = new ComputeSlot(paths.computeDir);
  try {
    await compute.clear();
  } catch (error) {
    // 옛 사본이 남을 뿐이다(내용마다 경로가 달라 새 모듈을 막지 않는다) — 이유는 남긴다.
    log.write({ event: "compute_error", what: "clear", message: errorMessage(error) });
  }
  const holder = new Holder(paths, log, info, manifest, ended, endedUnread, pending.length > 0, compute);
  await holder.listen();
  log.write({ event: "holder_start", pid: process.pid, version: options.version, holder: info.holder, socket: holder.address });
  process.on("SIGTERM", () => void holder.shutdown("SIGTERM"));
  process.on("SIGINT", () => void holder.shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    log.write({ event: "daemon_crash", pid: process.pid, error: error.stack ?? error.message });
    process.exit(1);
  });
  if (!notify({ status: "ready" })) {
    // 붙으러 올 바깥이 없다 — 세션·연결이 없으면 보통의 유휴 종료로 끝난다(잠금은 프로세스가 끝날 때 OS 가 푼다).
    holder.stopIfIdle();
  }
  return await holder.finished;
}

/**
 * holder 자리를 차지한다 — 옛 데몬 잠금을 잡고, 잡았으면 holder.json 에 pid·판·uuid 를 쓴다. 못 잡으면 undefined.
 * ★daemon.json 은 쓰지 않는다 — 구판 CLI 가 그 파일의 판으로 업데이트 길(kill-server)에 들어가지 않게(설계 3-4 · r3 P1-1).
 */
export async function claimHolder(paths: TermPaths, version: string, holder: string): Promise<HolderInfo | undefined> {
  const lock = await acquireDaemonLock(paths);
  if (!lock.held) {
    return undefined;
  }
  const info: HolderInfo = { pid: process.pid, version, holder, startedAt: new Date().toISOString() };
  await writeHolderInfo(paths, info);
  return info;
}

/**
 * holder.json — holder 하나만 쓴다(시작 · 임대가 바뀔 때). 지금 임대를 쥔 바깥의 pid 를 함께 적는다.
 * ★안내용이다 — CLI 가 «멈춘 데몬»의 pid 를 대는 데만 읽는다(client.readHolderInfo). 판·구조 판정은 살아 있는 바깥의 caps 로(설계 G4).
 */
export interface HolderInfo {
  pid: number;
  version: string;
  holder: string;
  startedAt: string;
  outer?: { outer: string; version: string; pid: number };
}

function writeHolderInfo(paths: TermPaths, info: HolderInfo): Promise<void> {
  return writePrivateFileAtomic(paths.holderInfo, `${JSON.stringify(info)}\n`);
}

interface Handled {
  data: unknown;
  /** 응답 줄을 쓴 «뒤에» 할 일(attach 의 첫 화면, kill-server 의 종료). */
  after?: () => void;
}

/** 쓰기 임대 — 쥔 바깥과 그 연결(설계 3-4). 연결이 끊기면 풀린다. */
interface Lease {
  outer: string;
  version: string;
  pid: number;
  connection: HolderConnection;
}

class Holder {
  private readonly sessions = new Map<string, TermSession>();
  private readonly connections = new Set<HolderConnection>();
  /** watch-sessions 를 건 연결 — 세션 목록 변화(생김·끝·label)를 알린다. */
  private readonly listWatchers = new Set<HolderConnection>();
  private readonly server: Server;
  private nextConnection = 1;
  /** 띄우는 중인 이름 — new·restore 가 같은 이름을 겹쳐 띄우지 않게(리뷰 #81 T1). 이름 예약의 주인은 holder 하나다(설계 3-1). */
  private readonly starting = new Set<string>();
  private inflight = 0;
  private inflightWaiters: (() => void)[] = [];
  /** 새 요청을 받지 않는다 — 이후 요청은 RETRY. */
  private shuttingDown = false;
  private stopping = false;
  private lease: Lease | undefined;
  private manifestWrite: Promise<void> = Promise.resolve();
  private infoWrite: Promise<void> = Promise.resolve();
  private endedWrite: Promise<void> = Promise.resolve();
  /** 책을 못 읽은 동안 ack 한 instance — 다시 읽은 파일에서 되살리지 않는다. */
  private readonly endedAcked = new Set<string>();
  private resolveFinished: (code: number) => void = () => undefined;
  private ipc: IpcAddress | undefined;
  readonly finished = new Promise<number>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(
    private readonly paths: TermPaths,
    private readonly log: DaemonLog,
    /** holder.json 에 쓴 것 — uuid(kill-server 가 실어야 하는 값 · caps 로 알린다)·판. 임대 바깥 칸은 {@link writeInfo} 가 채운다. */
    private readonly info: HolderInfo,
    private manifest: ManifestEntry[],
    /** 끝 기록 책(endedBook.ts) — 서버가 받았다고 다리가 ended-ack 하기 전까지. */
    private ended: EndedRecord[],
    /** 시작 때 책 파일을 못 읽었다(ENOENT 말고) — 다시 읽어 합칠 때까지 파일에 쓰지 않는다. */
    private endedUnread: boolean,
    /** 병합 대기 파일(paths.endedPending)이 있다 — 원본에 합쳐 쓴 뒤 지운다. */
    private endedPendingFile: boolean,
    /** 계산 모듈 자리(설계 3-2) — 열린 세션이 계산할 때마다 지금 모듈을 쓴다. */
    private readonly compute: ComputeSlot,
  ) {
    this.server = createServer((socket) => this.accept(socket));
  }

  get address(): string {
    return this.ipc?.address ?? this.paths.holderSocket;
  }

  async listen(): Promise<void> {
    // ★잠금을 쥔 프로세스만 여기 온다 — 옛 주소를 치워도 살아 있는 holder 의 주소일 수 없다.
    const ipc = await prepareListen(this.paths.holderSocket);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(ipc.address, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.ipc = ipc;
    await afterListen(this.paths.holderSocket);
  }

  /** 끝낸다 — 세션·매니페스트는 건드리지 않는다(SIGTERM·세션 0). 세션까지 끝내는 kill-server 는 handle 이 먼저 정리한다. */
  async shutdown(reason: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.stopAccepting();
    await this.inflightAtMost(0);
    // holder 와 함께 끝나는 세션(SIGTERM·SIGINT — PTY 가 같이 닫힌다)도 끝 기록에. restore 는 매니페스트로 새 인스턴스를 띄운다.
    for (const session of this.sessions.values()) {
      this.recordEnd(session, "exited");
    }
    await this.manifestWrite;
    await this.endedWrite;
    for (const connection of this.connections) {
      connection.end();
    }
    try {
      unlinkSync(this.paths.holderSocket);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        this.log.write({ event: "daemon_crash", pid: process.pid, error: `could not remove ${this.paths.holderSocket}: ${errorMessage(error)}` });
      }
    }
    this.log.write({ event: "daemon_stop", pid: process.pid, reason });
    this.resolveFinished(0);
  }

  private stopAccepting(): void {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.server.close();
    }
  }

  private async inflightAtMost(remaining: number): Promise<void> {
    while (this.inflight > remaining) {
      await new Promise<void>((resolve) => this.inflightWaiters.push(resolve));
    }
  }

  private accept(socket: Socket): void {
    const connection = new HolderConnection(this.nextConnection++, socket, (message) => this.receive(connection, message), (code, message) => {
      this.log.write({ event: "bad_message", conn: connection.id, code, message });
    });
    this.connections.add(connection);
    socket.on("close", () => {
      this.connections.delete(connection);
      this.listWatchers.delete(connection);
      for (const session of this.sessions.values()) {
        session.forget(connection);
      }
      if (connection.attachedTo) {
        this.log.write({ event: "detach", conn: connection.id, name: connection.attachedTo.name, reason: "connection closed" });
      }
      if (this.lease?.connection === connection) {
        this.log.write({ event: "lease_released", conn: connection.id, outer: this.lease.outer });
        this.lease = undefined;
        this.writeInfo();
      }
      this.stopIfIdle();
    });
  }

  /** 끄는 요청(kill-server·retire)이 겨눈 holder 가 이 holder 인가 — 칸 없음은 구판 CLI, 다름은 그 사이 갈린 holder. */
  private assertHolder(holder: string | undefined): void {
    if (holder === undefined) {
      throw new TermError(CLI_OUTDATED_CODE, "This CLI is older than the term holder, so it cannot stop it. Run the latest CLI "
        + "(npx -y ainecto@latest term kill-server) and try again.");
    }
    if (holder !== this.info.holder) {
      throw new TermError("TERM_HOLDER_CHANGED", "The term holder changed since this CLI looked; nothing was stopped. Try again.");
    }
  }

  /** 모든 세션을 끝낸다(끝 기록 · 매니페스트 비움) — 끝낸 이름들. */
  private endAll(): string[] {
    const names = [...this.sessions.keys()];
    for (const session of this.sessions.values()) {
      // 사람이 세션마다 지운 것이 아니다 — killed(서버가 줄을 숨김)가 아니라 exited(«끝났습니다» + 지우기).
      this.recordEnd(session, "exited");
      session.kill();
    }
    this.sessions.clear();
    this.updateManifest(() => []);
    return names;
  }

  /** holder.json 을 지금 임대로 다시 쓴다(차례대로 — 늦게 끝난 쓰기가 새 값을 덮지 않게). 못 쓰면 남기고 간다(안내용 파일). */
  private writeInfo(): void {
    const { lease } = this;
    const info: HolderInfo = { ...this.info, ...(lease ? { outer: { outer: lease.outer, version: lease.version, pid: lease.pid } } : {}) };
    this.infoWrite = this.infoWrite
      .then(() => writeHolderInfo(this.paths, info))
      .catch((error: unknown) => this.log.write({ event: "holder_info_error", message: errorMessage(error) }));
  }

  /** 이 연결의 요청을 적용해도 되나 — 임대를 쥔 연결, 또는 임대를 쥔 바깥이 이은 연결(via)만(설계 3-4 «그 전 쓰기는 적용하지 않음»). */
  private leased(connection: HolderConnection): boolean {
    return this.lease !== undefined && (this.lease.connection === connection || connection.outer === this.lease.outer);
  }

  private receive(connection: HolderConnection, message: TermClientMessage): void {
    if (message.op === "in" || message.op === "resize") {
      // 흐름 줄은 답이 없다 — 임대 없는 연결의 것은 버린다(넘기기 뒤 옛 바깥이 남긴 입력).
      if (!this.leased(connection)) return;
      if (message.op === "in") connection.attachedTo?.input(connection, Buffer.from(message.d, "base64"));
      else connection.attachedTo?.resizeFrom(connection, message.cols, message.rows);
      return;
    }
    void this.request(connection, message);
  }

  /** 요청 1줄 + 응답 1줄 — 응답 줄은 성공·실패·RETRY 어느 경우에도 반드시 남는다(실행 원칙 3). */
  private async request(connection: HolderConnection, request: TermRequest): Promise<void> {
    const startedAt = Date.now();
    this.log.write({ event: "request", id: request.id, conn: connection.id, op: request.op, ...requestMeta(request) });
    let response: TermResponse;
    let after: (() => void) | undefined;
    if (this.shuttingDown) {
      response = { id: request.id, ok: false, error: { code: RETRY_CODE, message: "The term holder is stopping; retry with the next one." } };
    } else if (!OPEN_OPS.has(request.op) && !this.leased(connection)) {
      response = { id: request.id, ok: false, error: { code: NO_LEASE_CODE,
        message: "This connection's term daemon does not hold the holder lease (it is being replaced); retry." } };
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

  private caps(): HolderCaps {
    return {
      holder: this.info.holder,
      pid: process.pid,
      version: this.info.version,
      talk: Object.fromEntries(Object.entries(HOLDER_TALK).map(([op, fields]) => [op, [...fields]])),
      lease: this.lease ? { outer: this.lease.outer, version: this.lease.version } : null,
      compute: this.compute.describe(),
    };
  }

  private async handle(connection: HolderConnection, request: TermRequest): Promise<Handled> {
    switch (request.op) {
      case "hello": {
        if (!this.ipc?.key) {
          throw new TermError("TERM_BAD_REQUEST", "hello is only for a named-pipe holder (Windows).");
        }
        return { data: { proof: helloProof(this.ipc.key, this.ipc.address, request.nonce) } };
      }
      case "caps":
        return { data: this.caps() };
      case "lease": {
        if (!this.lease) {
          this.lease = { outer: request.outer, version: request.version, pid: request.pid, connection };
          connection.outer = request.outer;
          this.log.write({ event: "lease_granted", conn: connection.id, outer: request.outer, version: request.version });
          this.writeInfo();
        }
        const mine = this.lease.connection === connection;
        return { data: mine ? { granted: true, holder: this.caps() } : { granted: false, outer: this.lease.outer, version: this.lease.version } };
      }
      case "via":
        connection.outer = request.outer;
        return { data: { via: request.outer } };
      case "handover":
        throw new TermError("TERM_BAD_REQUEST", "handover is for a term daemon, not the holder.");
      case "compute": {
        // ★쓰기 임대를 쥔 그 연결만(설계 3-2 신뢰 경계) — 바깥이 이은 CLI 연결(via)은 계산 모듈을 바꾸지 못한다.
        if (this.lease?.connection !== connection) {
          throw new TermError("TERM_BAD_REQUEST", "Only the term daemon holding the holder lease announces the compute module.");
        }
        const offer = await this.compute.offer(request.file);
        this.log.write(offer.switched
          ? { event: "compute_switched", file: request.file, version: offer.version, digest: offer.digest }
          : { event: "compute_kept", file: request.file, version: offer.version, reason: offer.reason });
        return { data: offer };
      }
      case "new": {
        assertSessionName(request.name);
        // ★종류는 만드는 요청이 정하고 holder 가 그대로 적는다 — 비었으면(구판 CLI) user(설계 원칙 1 «출처를 확인하지 못한 세션은 사용자 세션으로»).
        //   이름·명령으로 짐작하지 않는다(원칙 2). holder 가 만든 세션은 모두 종류를 가진다.
        const entry: ManifestEntry = { name: request.name, cwd: request.cwd, command: request.command, createdAt: new Date().toISOString(),
          ...(request.project !== undefined ? { project: request.project } : {}),
          ...(request.input !== undefined ? { input: request.input } : {}),
          kind: request.kind ?? "user" };
        const session = await this.startSession(entry, request.env, request.cols, request.rows);
        this.updateManifest((entries) => [...entries.filter((item) => item.name !== entry.name), { ...entry, instance: session.instance }]);
        return { data: session.info() };
      }
      case "ls":
        return { data: { sessions: [...this.sessions.values()].map((session) => session.info()), ended: this.ended } };
      case "listed-to": {
        const wanted = new Set(request.instances);
        let marked = 0;
        for (const session of this.sessions.values()) {
          if (!wanted.has(session.instance)) continue;
          session.listedTo = request.to;
          marked += 1;
        }
        // 다리가 목록을 읽은 뒤 이 표시 전에 끝난 세션 — 끝 책의 같은 uuid 에(리뷰 r2 P1-1 · endedBook withListedTo).
        const late = this.ended.filter((record) => record.to === undefined && wanted.has(record.instance)).length;
        if (late > 0) this.updateEnded((book) => withListedTo(book, wanted, request.to));
        return { data: { marked: marked + late } };
      }
      case "ended-ack": {
        const before = this.ended.length;
        if (this.endedUnread) for (const instance of request.instances) this.endedAcked.add(instance);
        this.updateEnded((book) => withoutAcked(book, request.instances));
        return { data: { acked: before - this.ended.length } };
      }
      case "send": {
        const session = this.session(request.name, request.instance);
        await session.send(request.text, request.paste);
        return { data: { name: request.name, instance: session.instance, sent: request.text.length } };
      }
      case "key": {
        const session = this.session(request.name, request.instance);
        await session.key(request.key);
        return { data: { name: request.name, instance: session.instance, key: request.key } };
      }
      case "read": {
        // ★화면과 인스턴스 id 는 같은 세션 객체에서(§14-6 4) — 웹은 이 값으로 다음 명령을 겨눈다.
        const session = this.session(request.name, request.instance);
        const range = { scrollback: request.scrollback, lines: request.lines };
        if (request.styles) {
          const screen = await session.readStyled(range, connection);
          return { data: { name: request.name, instance: session.instance, ...screen, modes: await session.modes() } };
        }
        const lines = await session.read(range, connection);
        return { data: { name: request.name, instance: session.instance, lines, modes: await session.modes() } };
      }
      case "kill": {
        const session = this.session(request.name, request.instance);
        this.sessions.delete(request.name);
        // ★표에서 먼저 뺀다 — 뒤따르는 PTY 끝(sessionEnded)은 current 가 아니라 두 번째 기록을 만들지 않는다.
        this.recordEnd(session, "killed");
        session.kill();
        this.updateManifest((entries) => entries.filter((item) => item.instance !== session.instance));
        this.notifySessions();
        return { data: { name: request.name, instance: session.instance, killed: true } };
      }
      case "kill-server": {
        // ★끌 holder 의 uuid 를 실어야 받는다(설계 3-4 · G4) — 구판 CLI(칸 없음)·다른 holder 를 본 CLI 는 거절.
        this.assertHolder(request.holder);
        // ★먼저 새 요청을 막고, 이미 받은 생성(new·restore)을 마치게 한 «뒤» 일괄로 끝낸다(리뷰 #81 T7). 남은 처리 중 요청은 이 요청 하나다.
        this.stopAccepting();
        await this.inflightAtMost(1);
        return { data: { killed: this.endAll() }, after: () => void this.shutdown("kill-server") };
      }
      case "retire": {
        // holder 갈기(설계 3-6) — 사용자 세션이 0 일 때만 PC 연결 세션째 끝내고 holder 가 끝난다. 다음 연결 명령이 새 판 holder 를 띄운다.
        // ★«0 인지 보고 끈다»를 한 번에: 세기와 새 요청 막기가 같은 동기 구간이다 — 그 사이 새 세션이 생길 수 없다(이름 예약의 주인이 여기).
        this.assertHolder(request.holder);
        const users = [...this.sessions.values()].filter((session) => (session.info().kind ?? "user") === "user").map((session) => session.name);
        if (users.length > 0 || this.starting.size > 0) {
          return { data: { retired: false, users: [...users, ...this.starting] } };
        }
        this.stopAccepting();
        await this.inflightAtMost(1);
        return { data: { retired: true, killed: this.endAll() }, after: () => void this.shutdown("retire") };
      }
      case "restore":
        return { data: await this.restore(request.env) };
      case "attach": {
        const session = this.session(request.name, request.instance);
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
        this.session(request.name, request.instance).watch(connection);
        return { data: { name: request.name } };
      case "watch-sessions":
        this.listWatchers.add(connection);
        return { data: { watching: "sessions" } };
      case "label": {
        const session = this.session(request.name, request.instance);
        session.label = request.label;
        this.updateManifest((entries) => entries.map((item) => item.instance === session.instance ? { ...item, label: request.label } : item));
        this.notifySessions();
        return { data: { name: request.name, instance: session.instance, label: request.label } };
      }
      case "set-size": {
        const session = this.session(request.name, request.instance);
        session.resizeTo(request.cols, request.rows);
        const { cols, rows } = session.info();
        return { data: { name: request.name, instance: session.instance, cols, rows } };
      }
    }
  }

  /**
   * 이름으로 세션을 찾는 한 곳. instance 를 주면 ★지금 그 이름의 세션이 그 인스턴스일 때만 — 같은 이름으로 다시 만든 세션이면
   * SESSION_REPLACED(설계 terminal-e2e §13-1·§14-6 4). 원격 명령의 인스턴스 검사는 다리가 아니라 명령을 적용하는 여기서 한다.
   */
  private session(name: string, instance?: string): TermSession {
    const session = this.sessions.get(name);
    if (!session) {
      throw new TermError("TERM_NO_SESSION", `No session named "${name}".`);
    }
    if (instance !== undefined && session.instance !== instance) {
      throw new TermError("SESSION_REPLACED", `The session "${name}" was replaced by a new one with the same name.`);
    }
    return session;
  }

  /**
   * 세션을 띄우는 곳은 여기 하나(new·restore). ★이름은 첫 await «전에» 확보한다 — 검사와 등록 사이에 같은 이름의
   * 다른 요청이 끼어 PTY 를 둘 띄우지 못하게(리뷰 #81 T1). 실패하면 확보를 푼다.
   */
  private async startSession(entry: ManifestEntry, env: Record<string, string>, cols?: number, rows?: number): Promise<TermSession> {
    if (this.sessions.has(entry.name) || this.starting.has(entry.name)) {
      throw new TermError("TERM_SESSION_EXISTS",
        `A session named "${entry.name}" already exists. Open it with \`ainecto term attach ${entry.name}\`, or choose another name.`);
    }
    this.starting.add(entry.name);
    try {
      await assertDirectory(entry.cwd);
      const computing: SessionCompute = {
        module: () => this.compute.module,
        failed: (what, error) => this.log.write({ event: "compute_error", what: `${entry.name}: ${what}`, message: errorMessage(error) }),
      };
      const session = await TermSession.start(
        { ...entry, env, cols, rows },
        (ended, exitCode, signal) => this.sessionEnded(ended, exitCode, signal),
        computing,
      );
      this.sessions.set(entry.name, session);
      this.notifySessions();
      this.log.write({ event: "session_start", name: entry.name, pid: session.info().pid, cwd: entry.cwd, shell: entry.command === null });
      return session;
    } finally {
      this.starting.delete(entry.name);
    }
  }

  /**
   * 세션이 스스로 끝났다. ★매니페스트에서 지우는 것은 «바깥 사정 없이» 끝났을 때만이다 — 신호로 끝난 세션(재부팅·로그아웃 때
   * 시스템이 보낸 SIGTERM·SIGHUP 포함 · Windows 는 콘솔 닫힘 끝 코드 — launch.endedFromOutside)은 `restore` 가 다시 띄울 수 있게
   * 남긴다. kill 로 지운 세션은 이미 표에 없다.
   */
  private sessionEnded(session: TermSession, exitCode: number, signal: number): void {
    const current = this.sessions.get(session.name) === session;
    const kept = current && endedFromOutside(exitCode, signal);
    if (current) {
      this.sessions.delete(session.name);
      this.recordEnd(session, "exited", exitCode, signal);
      if (!kept) {
        this.updateManifest((entries) => entries.filter((item) => item.instance !== session.instance));
      }
    }
    this.log.write({ event: "session_exit", name: session.name, pid: session.info().pid, exitCode, signal, kept });
    if (current) this.notifySessions();
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
        // 매니페스트 줄의 종류가 비었으면(옛 파일) user — 이름·명령으로 짐작하지 않는다(설계 원칙 1·2). holder 가 만든 세션은 모두 종류를 가진다.
        const kind = entry.kind ?? "user";
        const session = await this.startSession({ ...entry, kind }, env);
        // 되살린 세션은 새 인스턴스다 — 줄의 열쇠(uuid)를 바꿔 단다(G6).
        this.updateManifest((entries) => entries.map((item) => item.name === entry.name ? { ...item, kind, instance: session.instance } : item));
        restored.push(entry.name);
      } catch (error) {
        failed.push({ name: entry.name, code: errorCode(error), message: errorMessage(error) });
      }
    }
    return { restored, running, failed };
  }

  /** 세션 목록이 바뀌었다 — watch-sessions 를 건 연결에 알린다(무엇이 바뀌었는지는 ls 로). */
  private notifySessions(): void {
    for (const connection of this.listWatchers) {
      connection.send({ event: "sessions" });
    }
  }

  /**
   * 끝 기록 한 줄 — 세션이 끝나는 세 곳(스스로 끝남·kill·kill-server)과 holder 종료가 여기 하나로 온다.
   * signal 이 있으면 그 번호를 글로(코드는 뜻이 없다) · 없으면 exitCode(준 때만).
   */
  private recordEnd(session: TermSession, reason: EndReason, exitCode?: number, signal?: number): void {
    const info = session.info();
    const record: EndedRecord = {
      instance: session.instance,
      name: session.name,
      ...(info.kind !== undefined ? { kind: info.kind } : {}),
      command: info.command,
      endedAt: new Date().toISOString(),
      reason,
      ...(signal ? { signal: String(signal) } : exitCode !== undefined ? { exitCode } : {}),
      ...(session.listedTo !== undefined ? { to: session.listedTo } : {}),
    };
    this.updateEnded((book) => withEnded(book, record));
  }

  /**
   * 끝 기록 책도 holder 하나만 쓴다 — 매니페스트와 같은 한 줄 쓰기. 시작 때 못 읽었으면(endedUnread) 쓰기 전에 다시 읽어 합친다:
   * 파일의 줄 위에 그동안 메모리에 생긴 줄을 얹는다(같은 이름은 메모리 것 · ack 한 instance 는 파일 것에서도 뺀다). 또 못 읽으면 원본은 그대로 두고
   * 메모리의 줄을 병합 대기 파일에 쓴다 — 이대로 holder 가 끝나도 다음 holder 가 원본에 합친다(리뷰 r2 P1-2). 원본에 쓴 뒤 그 파일을 지운다.
   * ★그동안 ack 한 instance 는 다음 holder 가 모른다 — 원본에 남아 있던 것은 한 번 더 올라간다(서버는 같은 기록 두 번을 한 번으로 본다).
   */
  private updateEnded(change: (book: EndedRecord[]) => EndedRecord[]): void {
    this.ended = change(this.ended);
    this.endedWrite = this.endedWrite
      .then(async () => {
        if (this.endedUnread) {
          let stored: EndedRecord[];
          try {
            stored = await readEndedBook(this.paths.ended);
          } catch (error) {
            await writeEndedBook(this.paths.endedPending, this.ended);
            this.endedPendingFile = true;
            throw error;
          }
          this.ended = mergeEnded(stored, this.ended, this.endedAcked);
          this.endedUnread = false;
          this.log.write({ event: "ended_book_recovered", records: this.ended.length });
        }
        await writeEndedBook(this.paths.ended, this.ended);
        if (this.endedPendingFile) {
          await removeEndedBook(this.paths.endedPending);
          this.endedPendingFile = false;
        }
      })
      .catch((error) => this.log.write({ event: "ended_book_error", message: errorMessage(error) }));
  }

  /** 매니페스트는 holder 하나만 쓴다 — 쓰기를 한 줄로 세운다. */
  private updateManifest(change: (entries: ManifestEntry[]) => ManifestEntry[]): void {
    this.manifest = change(this.manifest);
    const snapshot = this.manifest;
    this.manifestWrite = this.manifestWrite
      .then(() => writeManifest(this.paths.manifest, snapshot))
      .catch((error) => this.log.write({ event: "manifest_error", message: errorMessage(error) }));
  }

  /**
   * 세션 0개 + 연결 0개면 끝낸다 — ★임대를 쥔 바깥의 연결은 세지 않는다(바깥은 상주한다). holder 가 끝나면 바깥도 그 연결이 끊겨 끝난다.
   * 그래서 «세션 0 · CLI 연결 0 이면 끝» 이 데몬 한 벌 때와 같다.
   */
  stopIfIdle(): void {
    const others = this.connections.size - (this.lease ? 1 : 0);
    if (!this.shuttingDown && this.sessions.size === 0 && others === 0) {
      void this.shutdown("no sessions");
    }
  }
}

/** holder 에 붙은 연결 하나(바깥의 임대 연결 · 바깥이 이은 CLI 연결). */
class HolderConnection implements SessionSink {
  attachedTo: TermSession | undefined;
  /** 이 연결을 낸 바깥(lease·via) — 그 바깥이 임대를 쥔 동안만 요청을 적용한다. */
  outer: string | undefined;
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
    // 끊긴 상대에게 쓰다 난 오류(EPIPE 등)가 holder 를 죽이지 않게 — 닫힘은 close 에서 정리한다.
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

/** 로그에 실을 요청 메타 — ★글·키 내용·환경변수는 싣지 않는다(키 이름은 싣는다). 바깥 로그도 이것을 쓴다. */
export function requestMeta(request: TermRequest): { name?: string; textLength?: number; key?: string } {
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
    case "set-size":
      return { name: request.name };
    case "label":
      return { name: request.name, textLength: request.label.length };
    default:
      return {};
  }
}
