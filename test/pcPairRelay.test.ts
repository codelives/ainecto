import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPairRelay, offerOf, PairRelayError } from "../src/core/pc/pcPairRelay";
import { E2eError } from "../src/core/term/e2e";
import { runPairing, type MatchedBrowser } from "../src/core/pc/pcPairing";
import {
  assertCommitment,
  browserKeyIdOf,
  generateSigningJwk,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  macEquals,
  registerKeys,
  registerOfferMac,
  registerRevealMac,
  publicRawFromJwk,
  randomBytes,
  verifyBytes,
} from "../src/core/term/e2e";
import { DaemonLog } from "../src/core/term/daemonLog";
import type { RemoteLogRecord } from "../src/core/term/remote";

const USER_ID = "5b1f2c9e-0a7d-4e63-8f41-9c2d7b6a3e10";
const PC_ID = "6f2c1d3e-0000-4000-8000-000000000004";

/**
 * 짝짓기 중계(§14-1 · A5) 왕복 — 실제 HTTP 가짜 서버(pair/open·send·poll) + 진짜 암호로 행동하는 브라우저. 서버는 메시지를 해석하지 않고 넘기기만 한다.
 */
class FakePairServer {
  server!: Server;
  endpoint = "";
  readonly calls: Array<{ op: string; body: Record<string, unknown> }> = [];
  /** PC → 브라우저 메시지(브라우저가 읽는다). */
  readonly toBrowser: Array<Record<string, unknown>> = [];
  private toPc: Array<Record<string, unknown>> = [];
  private held: Array<() => void> = [];
  closed = false;
  attemptId = "attempt-1";
  onPcMessage: (msg: Record<string, unknown>) => void | Promise<void> = () => undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => void this.handle(String(req.url), JSON.parse(raw) as Record<string, unknown>, res));
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", () => done()));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  /** 브라우저 → PC. */
  fromBrowser(msg: Record<string, unknown>): void {
    this.toPc.push(msg);
    for (const wake of this.held.splice(0)) wake();
  }

  close(): void {
    this.closed = true;
    for (const wake of this.held.splice(0)) wake();
  }

  private async handle(url: string, body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const op = url.replace("/mcp/term/pc/", "");
    this.calls.push({ op, body });
    const reply = (status: number, out: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    };
    if (op === "pair/open") {
      reply(200, { attemptId: this.attemptId });
    } else if (op === "pair/send") {
      const msg = body.msg as Record<string, unknown>;
      this.toBrowser.push(msg);
      await this.onPcMessage(msg);   // 브라우저가 먼저 처리한다(macP·done 검증) — 그 뒤 202
      reply(202, {});
    } else if (op === "pair/poll") {
      const answer = () => (this.closed ? reply(200, { closed: true }) : reply(200, { msgs: this.toPc.splice(0) }));
      if (this.closed || this.toPc.length > 0) {
        answer();
        return;
      }
      const timer = setTimeout(() => {
        this.held = this.held.filter((wake) => wake !== wakeUp);
        answer();
      }, 300);
      const wakeUp = () => {
        clearTimeout(timer);
        answer();
      };
      this.held.push(wakeUp);
    } else {
      reply(404, { code: "NOPE" });
    }
  }
}

describe("짝짓기 중계 — pair/open·send·poll 왕복(A5)", () => {
  let fake: FakePairServer;
  let dir: string;
  beforeEach(async () => {
    fake = new FakePairServer();
    await fake.start();
    dir = await mkdtemp(join(tmpdir(), "apair-"));
  });
  afterEach(async () => {
    await fake.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const logPath = (): string => join(dir, "remote.log");
  const relay = () => createPairRelay({
    endpoint: fake.endpoint,
    tokenProvider: { getAccessToken: async () => "t", refreshAfterUnauthorized: async () => "t" },
    log: new DaemonLog<RemoteLogRecord>(logPath(), `${logPath()}.1`),
    pcId: PC_ID,
    holdMs: 1_000,
  });

  it("한 poll 의 브라우저 메시지 해석(순수) — 비면 다시 · abort · 모양 틀림은 PAIR_BAD_MESSAGE", () => {
    expect(offerOf([])).toBeUndefined();
    expect(offerOf([{ type: "abort", reason: "x" }])).toBe("abort");
    expect(() => offerOf([{ type: "offer", publicKey: "AA", keyId: "k", nB: "AA", name: "n" }])).toThrow(PairRelayError);
    expect(() => offerOf([{ type: "reveal" }])).toThrow(PairRelayError);
  });

  /**
   * 자동 등록 브라우저(auto-register §1) — 주소로 받은 S 로 offer 에 macB 를 달고, reveal 의 commit·macP 를 검증한 뒤 done 서명을 검증한다.
   * tamper 는 브라우저(또는 중계)가 바꾸는 한 가지 — 반례마다 하나씩.
   */
  async function secretBrowser(secret: Uint8Array, tamper: {
    flipBit?: boolean; userId?: string; attemptId?: string; relayRenames?: boolean; noMac?: boolean; keyId?: string; extraOffer?: boolean;
  } = {}) {
    const key = await generateSigningJwk();
    const publicRaw = publicRawFromJwk(key);
    const nB = randomBytes(32);
    const keyId = tamper.keyId ?? await browserKeyIdOf(publicRaw);
    const state: { commit?: Uint8Array; transcript?: Uint8Array; pcPub?: Uint8Array; macPVerified?: boolean; doneVerified?: boolean } = {};
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
    const bytes = (text: unknown) => new Uint8Array(Buffer.from(String(text), "base64url"));
    const own = secret.slice();
    if (tamper.flipBit) own[31] = (own[31] ?? 0) ^ 0x80;
    const keys = await registerKeys(own);
    const name = "Chrome · macOS";
    fake.onPcMessage = async (msg) => {
      if (msg.type === "commit") {
        state.commit = bytes(msg.commit);
        const macB = await registerOfferMac(keys.browser, { userId: tamper.userId ?? USER_ID, pcId: PC_ID, attemptId: tamper.attemptId ?? fake.attemptId,
          commit: state.commit, browserPublicRaw: publicRaw, keyId, nB, name });
        const offer = { type: "offer", publicKey: b64(publicRaw), keyId, nB: b64(nB), name: tamper.relayRenames ? "Evil · Linux" : name,
          ...(tamper.noMac ? {} : { macB: b64(macB) }) };
        fake.fromBrowser(offer);
        if (tamper.extraOffer) fake.fromBrowser(offer);
      } else if (msg.type === "reveal") {
        state.pcPub = bytes(msg.publicKey);
        const nP = bytes(msg.nP);
        await assertCommitment(state.commit!, state.pcPub, nP);
        state.transcript = await pairTranscript({ userId: USER_ID, pcId: PC_ID, pcPublicRaw: state.pcPub, browserPublicRaw: publicRaw, nP, nB });
        state.macPVerified = typeof msg.macP === "string"
          && macEquals(bytes(msg.macP), await registerRevealMac(keys.pc, { transcript: state.transcript, attemptId: fake.attemptId }));
      } else if (msg.type === "done") {
        state.doneVerified = state.macPVerified === true
          && await verifyBytes(publicJwkFromRaw(state.pcPub!), bytes(msg.signature), pairDoneInput(state.transcript!));
      }
    };
    return { keyId, state };
  }

  async function register(secret: Uint8Array) {
    const pinned: MatchedBrowser[] = [];
    const outcome = await runPairing({
      userId: USER_ID, pcId: PC_ID, pcKey: await generateSigningJwk(), transport: relay(), waitMs: 10_000,
      secret,
      pin: async (browserKey) => { pinned.push(browserKey); },
    });
    return { outcome, pinned };
  }

  it("자동 등록(secret) — offer macB 검증 → 핀 → reveal 에 macP → done · 브라우저가 macP·done 을 검증 · 로그에 S·mac 없음", async () => {
    const secret = randomBytes(32);
    const web = await secretBrowser(secret);
    const { outcome, pinned } = await register(secret);
    expect(outcome).toMatchObject({ kind: "paired", doneError: undefined, browser: { name: "Chrome · macOS" } });
    expect(pinned.map((item) => item.keyId)).toEqual([web.keyId]);
    expect(web.state.macPVerified).toBe(true);
    expect(web.state.doneVerified).toBe(true);
    expect(fake.toBrowser.map((msg) => Object.keys(msg).sort())).toEqual([["commit", "type"], ["macP", "nP", "publicKey", "type"], ["signature", "type"]]);
    // 중계 왕복(A5) — open → commit → (poll) offer → reveal → done · 모든 호출이 이 시도(attemptId) · 호출마다 요청·응답 줄.
    expect(fake.calls.map((call) => call.op).filter((op, index, all) => op !== all[index - 1]))
      .toEqual(["pair/open", "pair/send", "pair/poll", "pair/send"]);   // 이어진 같은 호출은 하나로 — poll 은 여러 번일 수 있다
    expect(fake.calls[0]?.body).toEqual({ pcId: PC_ID });
    expect(fake.calls.filter((call) => call.op !== "pair/open").every((call) => call.body.attemptId === fake.attemptId)).toBe(true);
    const log = (await readFile(logPath(), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const requests = log.filter((r) => r.event === "remote_call").map((r) => r.callId);
    const responses = new Set(log.filter((r) => r.event === "remote_call_response").map((r) => r.callId));
    expect(requests.length).toBe(fake.calls.length);
    expect(requests.every((id) => responses.has(id))).toBe(true);
    const text = await readFile(logPath(), "utf8");
    for (const value of [Buffer.from(secret).toString("base64url"), Buffer.from(secret).toString("hex"), String(fake.toBrowser[1]?.macP),
      String(fake.toBrowser[0]?.commit), String(fake.toBrowser[1]?.nP)]) {
      expect(text).not.toContain(value);
    }
  });

  it.each([
    ["S 한 비트가 다르다", { flipBit: true }],
    ["userId 가 다르다(다른 계정)", { userId: "0b1f2c9e-0a7d-4e63-8f41-9c2d7b6a3e10" }],
    ["attemptId 가 다르다(옛 시도)", { attemptId: "attempt-0" }],
    ["중계가 이름을 바꿨다", { relayRenames: true }],
    ["macB 가 없다(옛·수동 브라우저)", { noMac: true }],
  ])("자동 등록 거절 — %s → code-mismatch · 핀 0 · reveal 없이 abort", async (_label, tamper) => {
    const secret = randomBytes(32);
    await secretBrowser(secret, tamper);
    const { outcome, pinned } = await register(secret);
    expect(outcome).toEqual({ kind: "code-mismatch" });
    expect(pinned).toEqual([]);
    expect(fake.toBrowser.map((msg) => msg.type)).toEqual(["commit", "abort"]);
  });

  it("자동 등록 거절 — keyId ≠ 공개키 지문이면 E2E_BAD_INPUT · offer 가 둘이면 PAIR_DUPLICATE — 둘 다 핀 0", async () => {
    const secret = randomBytes(32);
    await secretBrowser(secret, { keyId: "00000000000000000000000000000000" });
    const wrongId = await register(secret).then(() => undefined, (error: unknown) => error);
    expect(wrongId).toBeInstanceOf(E2eError);
    expect((wrongId as E2eError).code).toBe("E2E_BAD_INPUT");

    fake.toBrowser.length = 0;
    await secretBrowser(secret, { extraOffer: true });
    const duplicate = await register(secret).then(() => undefined, (error: unknown) => error);
    expect((duplicate as PairRelayError).code).toBe("PAIR_DUPLICATE");
    expect(fake.toBrowser.some((msg) => msg.type === "reveal")).toBe(false);
  });

  it("offer 의 macB 는 선택 칸 — 있으면 32바이트 base64url 이 아니면 PAIR_BAD_MESSAGE", async () => {
    const key = publicRawFromJwk(await generateSigningJwk());
    const base = { type: "offer", publicKey: Buffer.from(key).toString("base64url"), keyId: "k", nB: Buffer.from(randomBytes(32)).toString("base64url"), name: "n" };
    expect(offerOf([base])).not.toHaveProperty("macB");
    expect((offerOf([{ ...base, macB: Buffer.from(randomBytes(32)).toString("base64url") }]) as { macB?: Uint8Array }).macB).toHaveLength(32);
    expect(() => offerOf([{ ...base, macB: "AA" }])).toThrow(PairRelayError);
  });

  it("제안이 둘 오면(중복) PAIR_DUPLICATE · 서버가 시도를 닫으면 PAIR_CLOSED — 핀 없음 · reveal 없음", async () => {
    const secret = randomBytes(32);
    await secretBrowser(secret, { extraOffer: true });
    const duplicate = await register(secret).then(() => undefined, (error: unknown) => error);
    expect(duplicate).toBeInstanceOf(PairRelayError);
    expect((duplicate as PairRelayError).code).toBe("PAIR_DUPLICATE");

    fake.toBrowser.length = 0;
    fake.onPcMessage = (msg) => {
      if (msg.type === "commit") fake.close();
    };
    const closed = await register(secret).then(() => undefined, (error: unknown) => error);
    expect((closed as PairRelayError).code).toBe("PAIR_CLOSED");
    expect(fake.toBrowser.some((msg) => msg.type === "reveal")).toBe(false);
  });
});
