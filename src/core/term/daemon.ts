import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { ensurePrivateDir, isNodeError } from "../fs/privateFiles";
import { spawnResident, TermClient } from "./client";
import { acquireOuterStartLock } from "./daemonLock";
import { DaemonLog } from "./daemonLog";
import { errorCode, errorMessage, TermError } from "./errors";
import { NO_LEASE_CODE, requestMeta, type DaemonReadiness } from "./holder";
import { holderCaps, type HolderCaps, type OuterCaps } from "./holderTalk";
import {
  afterListen,
  connectAddress,
  helloProof,
  IMPOSTOR_CODE,
  NO_ADDRESS_CODE,
  pointsTo,
  pointTo,
  prepareListen,
  unlinkIfPresent,
  type IpcAddress,
} from "./ipc";
import { DAEMON_RESPONSE_TIMEOUT_MS, DAEMON_START_ATTEMPTS } from "./limits";
import { outerSocketPath, type TermPaths } from "./paths";
import { encodeLine, LineDecoder, parseClientMessage, parseDaemonMessage, RETRY_CODE, type TermRequest, type TermResponse } from "./protocol";

export type { DaemonReadiness } from "./holder";

export interface DaemonOptions {
  paths: TermPaths;
  version: string;
  ready: (readiness: DaemonReadiness) => void;
}

/** 데몬 잠금을 holder 가 아닌 누군가가 쥐고 있다 — 옛 구조 데몬(0.16.x 이하)이 살아 있다(첫 전환 전 · 설계 5절). */
export const OLD_DAEMON_CODE = "TERM_OLD_DAEMON";

/**
 * 상주 프로세스 `ainecto term daemon` = 바깥(세션 유지 구조 설계 3-4) — CLI 연결을 받아 holder 로 잇는 대리. 세션은 holder 가 쥔다.
 * 판마다 프로세스째 갈린다: 새 판의 바깥이 뜨면 옛 바깥에게서 넘겨받고, 그동안 PTY·화면·uuid 는 holder 안에 그대로 있다.
 *
 *   시작(바깥 시작 잠금 안에서 — 두 바깥이 겹치지 않게):
 *     ① holder 에 붙는다(없으면 `term holder` 를 띄운다) ② 쓰기 임대를 청한다
 *        · 비었으면 쥔다 → 자기 주소(outer-<uuid>)에 bind → 공용 주소(ctl.sock)를 자기에게 바꿔 단다
 *        · 다른 바깥이 쥐었고 이 판이 더 높으면 넘겨받는다(자기 주소 → 포인터 → 옛 바깥에 handover → 임대가 풀리면 쥔다)
 *        · 그 밖(같은 판·낮은 판)은 «이미 있음»(locked) — 띄운 CLI 는 공용 주소로 다시 붙는다
 *   끝: holder 가 끝나면(세션 0 · kill-server) · 넘겨줌 · SIGTERM. 처리 중인 요청을 마친 뒤 자기 주소를 지우고,
 *       공용 주소는 «자기를 가리킬 때만» 지운다.
 */
export async function runDaemon(options: DaemonOptions): Promise<number> {
  const { paths } = options;
  await ensurePrivateDir(paths.dir);
  const log = new DaemonLog(paths.log, paths.previousLog);
  const notify = (readiness: DaemonReadiness): boolean => {
    try {
      options.ready(readiness);
      return true;
    } catch (error) {
      log.write({ event: "ready_unread", pid: process.pid, status: readiness.status, message: errorMessage(error) });
      return false;
    }
  };
  const startLock = await acquireOuterStartLock(paths, DAEMON_RESPONSE_TIMEOUT_MS);
  if (!startLock) {
    // 다른 바깥이 그동안 뜨는 중이었다 — 그 바깥이 공용 주소를 연다. 띄운 CLI 는 다시 붙는다.
    log.write({ event: "daemon_locked", pid: process.pid });
    notify({ status: "locked" });
    return 1;
  }
  let outer: Outer | undefined;
  try {
    outer = await startOuter(paths, options.version, log);
  } finally {
    startLock.release();
  }
  if (!outer) {
    log.write({ event: "daemon_locked", pid: process.pid });
    notify({ status: "locked" });
    return 1;
  }
  log.enableRotation();
  log.write({ event: "daemon_start", pid: process.pid, version: options.version, socket: outer.address, outer: outer.uuid, holder: outer.holder.holder });
  const running = outer;
  process.on("SIGTERM", () => void running.shutdown("SIGTERM"));
  process.on("SIGINT", () => void running.shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    log.write({ event: "daemon_crash", pid: process.pid, error: error.stack ?? error.message });
    process.exit(1);
  });
  notify({ status: "ready" });
  return await running.finished;
}

/** 이 판(a)이 다른 판(b)보다 높은가 — `x.y.z` 셋을 숫자로 견준다. 어느 쪽이든 그 모양이 아니면(로컬 «dev») 거짓 — 넘기지 않는다. 순수 함수. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (value: string): number[] | undefined => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const [left, right] = [parse(a), parse(b)];
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! > right[index]!;
  }
  return false;
}

/** ①② — 임대를 쥐거나 넘겨받은 바깥, 또는 undefined(다른 바깥이 이미 이 판 이상). 실패는 던진다(띄운 CLI 에 오류 한 줄). */
async function startOuter(paths: TermPaths, version: string, log: DaemonLog): Promise<Outer | undefined> {
  const control = await connectHolder(paths);
  const holder = holderCaps(await control.request({ op: "caps" }));
  if (!holder) {
    control.close();
    throw new TermError("TERM_DAEMON_START", `The term holder did not describe itself — see ${paths.holderLog}.`);
  }
  const uuid = freshOuterUuid(paths);
  const lease = await control.request({ op: "lease", outer: uuid, version }) as { granted: boolean; outer?: string; version?: string };
  const previous = lease.granted ? undefined : { outer: String(lease.outer), version: String(lease.version) };
  if (previous && !newerVersion(version, previous.version)) {
    control.close();
    return undefined;
  }
  const outer = new Outer(paths, log, uuid, version, control, holder);
  try {
    await outer.listen();
    if (previous) await outer.takeOver(previous);
    else await outer.publish();
  } catch (error) {
    await outer.shutdown("start failed");
    throw error;
  }
  return outer;
}

/** holder 에 붙는다 — 없으면 띄운다. 잠금은 쥐었는데 답이 없으면(옛 구조 데몬이 잠금을 쥠) {@link OLD_DAEMON_CODE}. */
async function connectHolder(paths: TermPaths): Promise<TermClient> {
  for (let started = 0; ; started += 1) {
    try {
      return await TermClient.connect(paths, paths.holderSocket);
    } catch (error) {
      const code = error instanceof TermError ? error.code : undefined;
      if (code !== IMPOSTOR_CODE && code !== NO_ADDRESS_CODE && !isNodeError(error, "ENOENT") && !isNodeError(error, "ECONNREFUSED")) {
        throw error;
      }
    }
    if (started === DAEMON_START_ATTEMPTS) {
      throw new TermError(OLD_DAEMON_CODE, "Another process holds the term daemon lock but no term holder answers — an older term daemon "
        + "(ainecto 0.16.x or earlier) is probably still running. Run `npx -y ainecto@latest` once in a terminal to switch to the new "
        + `terminal structure. See ${paths.holderLog}.`);
    }
    const readiness = await spawnResident(paths, "holder");
    if (readiness.status === "error") {
      throw new TermError("TERM_DAEMON_START", `The term holder did not start: ${readiness.message}`);
    }
  }
}

/** 자기 주소 파일이 아직 없는 uuid — 주소 이름에는 앞 8글자만 쓰므로(paths.ts) 겹치면 다시 뽑는다. */
function freshOuterUuid(paths: TermPaths): string {
  for (;;) {
    const uuid = randomUUID();
    if (!existsSync(outerSocketPath(paths, uuid))) return uuid;
  }
}

class Outer {
  private readonly server: Server;
  private readonly links = new Set<CliLink>();
  private nextConnection = 1;
  private ipc: IpcAddress | undefined;
  readonly ownFile: string;
  private shuttingDown = false;
  private stopping = false;
  /** holder 로 보낸 뒤 답을 기다리는 요청 수 — 넘겨줄 때·끝날 때 0 이 될 때까지 기다린다. */
  private inflight = 0;
  private inflightWaiters: (() => void)[] = [];
  /** 쓰기 임대를 쥐었다 — 그 전에 온 CLI 요청은 holder 로 보내지 않고 기다린다(설계 3-4 «그 전 쓰기는 적용하지 않음»). */
  readonly leaseReady: Promise<void>;
  private resolveLease: () => void = () => undefined;
  private resolveFinished: (code: number) => void = () => undefined;
  readonly finished = new Promise<number>((resolve) => {
    this.resolveFinished = resolve;
  });

  constructor(
    readonly paths: TermPaths,
    readonly log: DaemonLog,
    readonly uuid: string,
    private readonly version: string,
    /** holder 에 낸 임대 연결 — 끊기면(holder 끝) 바깥도 끝난다. */
    private readonly control: TermClient,
    readonly holder: HolderCaps,
  ) {
    this.ownFile = outerSocketPath(paths, uuid);
    this.leaseReady = new Promise((resolve) => {
      this.resolveLease = resolve;
    });
    this.server = createServer((socket) => this.accept(socket));
    control.onClose(() => void this.shutdown("holder gone"));
  }

  get address(): string {
    return this.ipc?.address ?? this.ownFile;
  }

  async listen(): Promise<void> {
    const ipc = await prepareListen(this.ownFile);
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(ipc.address, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.ipc = ipc;
    await afterListen(this.ownFile);
  }

  /** 임대를 처음부터 쥐었다 — 공용 주소를 이 바깥으로. */
  async publish(): Promise<void> {
    await pointTo(this.paths.socket, this.ownAddress(), this.ownFile);
    this.resolveLease();
  }

  /**
   * 넘겨받기(설계 3-4 순서) — 포인터를 바꿔 단다 → 옛 바깥에 «넘겨라»(옛 바깥의 자기 주소로) → 옛 바깥이 처리 중인 것을 마치고 임대를 놓으면 쥔다.
   * 기한 안에 못 쥐면 포인터를 옛 바깥으로 되돌리고 실패한다(옛 주소는 그대로 살아 있다).
   */
  async takeOver(previous: { outer: string; version: string }): Promise<void> {
    const previousFile = outerSocketPath(this.paths, previous.outer);
    const previousAddress = await connectAddress(previousFile).catch(() => undefined);
    this.log.write({ event: "handover_start", from: previous.outer, fromVersion: previous.version, to: this.uuid, version: this.version });
    await pointTo(this.paths.socket, this.ownAddress(), this.ownFile);
    try {
      const old = await TermClient.connect(this.paths, previousFile);
      try {
        await old.request({ op: "handover", to: this.uuid });
      } finally {
        old.close();
      }
    } catch (error) {
      // 옛 바깥에 못 닿았다(이미 끝남 · 응답 없음) — 임대가 풀렸는지로만 판정한다.
      this.log.write({ event: "handover_unanswered", from: previous.outer, code: errorCode(error), message: errorMessage(error) });
    }
    const until = Date.now() + DAEMON_RESPONSE_TIMEOUT_MS;
    for (;;) {
      const lease = await this.control.request({ op: "lease", outer: this.uuid, version: this.version }) as { granted: boolean };
      if (lease.granted) break;
      if (Date.now() >= until) {
        if (previousAddress) await pointTo(this.paths.socket, previousAddress, previousFile);
        this.log.write({ event: "handover_failed", from: previous.outer, to: this.uuid });
        throw new TermError("TERM_HANDOVER_FAILED", `The running term daemon (${previous.version}) did not hand over within `
          + `${DAEMON_RESPONSE_TIMEOUT_MS / 1000} s; it keeps serving. See ${this.paths.log}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.log.write({ event: "handover_done", from: previous.outer, to: this.uuid });
    this.resolveLease();
  }

  /** CLI 의 기능 묻기 답 — 이 바깥 + holder(설계 G4: 판·구조는 살아 있는 상대에게). */
  caps(): OuterCaps {
    return { outer: this.uuid, version: this.version, holder: this.holder.holder, holderVersion: this.holder.version, holderPid: this.holder.pid,
      talk: this.holder.talk };
  }

  helloProof(nonce: string): string {
    if (!this.ipc?.key) {
      throw new TermError("TERM_BAD_REQUEST", "hello is only for a named-pipe daemon (Windows).");
    }
    return helloProof(this.ipc.key, this.ipc.address, nonce);
  }

  get accepting(): boolean {
    return !this.shuttingDown;
  }

  began(): void {
    this.inflight += 1;
  }

  ended(count = 1): void {
    this.inflight -= count;
    for (const wake of this.inflightWaiters.splice(0)) {
      wake();
    }
  }

  /** 넘겨주기(옛 바깥 쪽) — 새 요청은 RETRY(공용 주소는 이미 새 바깥) · 처리 중인 것을 마친 뒤 답하고 끝난다(임대는 끝나며 풀린다). */
  async handOver(link: CliLink, request: TermRequest & { op: "handover" }, startedAt: number): Promise<void> {
    this.stopAccepting();
    await this.inflightAtMost(0);
    this.log.write({ event: "handed_over", to: request.to });
    link.reply(request, { id: request.id, ok: true, data: { handedOver: true, to: request.to } }, startedAt);
    void this.shutdown("handover");
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    this.stopAccepting();
    await this.inflightAtMost(0);
    for (const link of this.links) {
      link.close();
    }
    this.control.close();
    try {
      // ★공용 주소는 이 바깥을 가리킬 때만 지운다 — 넘겨준 뒤라면 새 바깥의 포인터다(설계 3-4).
      if (this.ipc && await pointsTo(this.paths.socket, this.ipc, this.ownFile)) {
        await unlinkIfPresent(this.paths.socket);
      }
      await unlinkIfPresent(this.ownFile);
    } catch (error) {
      this.log.write({ event: "daemon_crash", pid: process.pid, error: `could not remove ${this.ownFile}: ${errorMessage(error)}` });
    }
    this.log.write({ event: "daemon_stop", pid: process.pid, reason });
    this.resolveFinished(0);
  }

  private ownAddress(): IpcAddress {
    if (!this.ipc) throw new TermError("TERM_INTERNAL", "The term daemon is not listening yet.");
    return this.ipc;
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
    const link = new CliLink(this.nextConnection++, socket, this);
    this.links.add(link);
    socket.on("close", () => this.links.delete(link));
  }
}

/**
 * CLI 연결 하나 ↔ holder 연결 하나(그 바깥이 이은 것 — via). 들어온 줄은 모양을 검사하고 바깥이 답할 것(증명·기능 묻기·넘기기)은 여기서,
 * 나머지는 줄 그대로 holder 로. holder 의 답·이벤트는 줄 그대로 CLI 로. 요청 1줄 + 응답 1줄을 바깥 로그(daemon.log)에도 남긴다.
 */
class CliLink {
  private readonly decoder = new LineDecoder();
  private readonly holderDecoder = new LineDecoder();
  private holder: Promise<Socket> | undefined;
  /** holder 로 보낸 줄의 차례 — CLI 가 보낸 순서 그대로 간다. */
  private chain: Promise<void> = Promise.resolve();
  /** holder 에 보낸 뒤 답을 기다리는 요청 — id → (op·보낸 시각). */
  private readonly pending = new Map<string, { op: string; startedAt: number }>();

  constructor(
    private readonly id: number,
    private readonly socket: Socket,
    private readonly outer: Outer,
  ) {
    socket.on("data", (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) {
        if (!this.receive(line)) return;
      }
    });
    socket.on("error", (error) => outer.log.write({ event: "bad_message", conn: id, code: errorCode(error), message: errorMessage(error) }));
    socket.on("close", () => {
      // CLI 가 떠났다 — 답을 기다리던 요청은 holder 가 마저 처리한다(이미 임대 확인을 지났다). 그 결과는 받을 쪽이 없다.
      this.outer.ended(this.pending.size);
      this.pending.clear();
      void this.holder?.then((holderSocket) => holderSocket.destroy(), () => undefined);
    });
  }

  close(): void {
    this.socket.end();
  }

  /** 응답 한 줄을 CLI 에 쓰고 로그에 남긴다. */
  reply(request: { id: string; op: string }, response: TermResponse, startedAt: number): void {
    this.write(encodeLine(response));
    this.outer.log.write({
      event: "response",
      id: request.id,
      conn: this.id,
      op: request.op,
      ok: response.ok,
      ...(response.ok ? {} : { code: response.error.code, message: response.error.message }),
      ms: Date.now() - startedAt,
    });
  }

  /** CLI 의 한 줄 — 모양이 틀리면 연결을 끊고 false. */
  private receive(line: string): boolean {
    let message;
    try {
      message = parseClientMessage(line);
    } catch (error) {
      this.outer.log.write({ event: "bad_message", conn: this.id, code: errorCode(error), message: errorMessage(error) });
      this.socket.destroy();
      return false;
    }
    if (message.op === "in" || message.op === "resize") {
      this.forward(line);
      return true;
    }
    const request = message;
    const startedAt = Date.now();
    this.outer.log.write({ event: "request", id: request.id, conn: this.id, op: request.op, ...requestMeta(request) });
    const fail = (code: string, text: string): void => this.reply(request, { id: request.id, ok: false, error: { code, message: text } }, startedAt);
    if (!this.outer.accepting) {
      fail(RETRY_CODE, "The term daemon is stopping; retry with the next one.");
      return true;
    }
    switch (request.op) {
      case "hello":
        try {
          this.reply(request, { id: request.id, ok: true, data: { proof: this.outer.helloProof(request.nonce) } }, startedAt);
        } catch (error) {
          fail(errorCode(error), errorMessage(error));
        }
        return true;
      case "caps":
        this.reply(request, { id: request.id, ok: true, data: this.outer.caps() }, startedAt);
        return true;
      case "lease":
      case "via":
        fail("TERM_BAD_REQUEST", `${request.op} is between a term daemon and the holder, not for a CLI.`);
        return true;
      case "handover":
        void this.outer.handOver(this, request, startedAt);
        return true;
      default:
        this.pending.set(request.id, { op: request.op, startedAt });
        this.outer.began();
        this.forward(line);
        return true;
    }
  }

  /** 줄을 holder 로 — 연결은 처음 보낼 때 잇는다(임대를 쥔 뒤). 잇지 못하면 보내지 않은 요청이라 RETRY 로 답한다(다음 바깥에서 다시). */
  private forward(line: string): void {
    this.chain = this.chain
      .then(async () => {
        (await this.holderSocket()).write(`${line}\n`);
      })
      .catch((error: unknown) => {
        this.failPending(RETRY_CODE, `The term holder could not be reached (${errorMessage(error)}); retry.`);
        this.socket.end();
      });
  }

  private holderSocket(): Promise<Socket> {
    this.holder ??= (async () => {
      await this.outer.leaseReady;
      const client = await TermClient.connect(this.outer.paths, this.outer.paths.holderSocket);
      await client.request({ op: "via", outer: this.outer.uuid });
      const holderSocket = client.release();
      holderSocket.on("data", (chunk: Buffer) => {
        for (const line of this.holderDecoder.push(chunk)) this.fromHolder(line);
      });
      holderSocket.on("close", () => {
        // ★보낸 뒤 답이 없는 요청은 결과를 모른다 — RETRY 가 아니라 «끊김»(다시 실행하지 않는다 · 설계 4절 규칙 3).
        this.failPending("TERM_DAEMON_GONE", `The term holder closed the connection before answering — see ${this.outer.paths.holderLog}.`);
        this.socket.end();
      });
      return holderSocket;
    })();
    return this.holder;
  }

  /** holder 의 한 줄 — 응답이면 기다리던 요청을 풀고(임대 없음 → RETRY), 이벤트는 그대로 CLI 로. */
  private fromHolder(line: string): void {
    let message;
    try {
      message = parseDaemonMessage(line);
    } catch {
      this.write(`${line}\n`);
      return;
    }
    const waiting = "event" in message ? undefined : this.pending.get(message.id);
    if ("event" in message || !waiting) {
      this.write(`${line}\n`);
      return;
    }
    this.pending.delete(message.id);
    this.outer.ended();
    // 임대 없이 holder 가 받지 않은 요청 — 적용되지 않았으니 다음 바깥에서 다시 보내도 된다.
    const response: TermResponse = !message.ok && message.error.code === NO_LEASE_CODE
      ? { id: message.id, ok: false, error: { code: RETRY_CODE, message: message.error.message } }
      : message;
    if (response === message) {
      this.write(`${line}\n`);
      this.outer.log.write({ event: "response", id: message.id, conn: this.id, op: waiting.op, ok: message.ok,
        ...(message.ok ? {} : { code: message.error.code, message: message.error.message }), ms: Date.now() - waiting.startedAt });
    } else {
      this.reply({ id: message.id, op: waiting.op }, response, waiting.startedAt);
    }
  }

  private failPending(code: string, text: string): void {
    const waiting = [...this.pending];
    this.pending.clear();
    for (const [id, { op, startedAt }] of waiting) {
      this.reply({ id, op }, { id, ok: false, error: { code, message: text } }, startedAt);
    }
    this.outer.ended(waiting.length);
  }

  private write(line: string): void {
    if (this.socket.writable) {
      this.socket.write(line);
    }
  }
}
