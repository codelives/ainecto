import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPairRelay, offerOf, PairRelayError } from "../src/core/pc/pcPairRelay";
import { runPairing, type MatchedBrowser } from "../src/core/pc/pcPairing";
import {
  assertCommitment,
  browserKeyIdOf,
  generateSigningJwk,
  pairCodes,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicRawFromJwk,
  randomBytes,
  verifyBytes,
  type PairCodes,
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
      await this.onPcMessage(msg);   // 브라우저가 먼저 처리한다(코드 계산) — 그 뒤 202
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

  /** commit 을 받으면 offer 를 보내고, reveal 을 받으면 약속값을 대조해 코드를 계산하고, done 을 검증하는 브라우저. */
  async function browser(options: { extraOffer?: boolean } = {}) {
    const key = await generateSigningJwk();
    const publicRaw = publicRawFromJwk(key);
    const nB = randomBytes(32);
    const keyId = await browserKeyIdOf(publicRaw);
    const state: { commit?: Uint8Array; transcript?: Uint8Array; codes?: PairCodes; doneVerified?: boolean; pcPub?: Uint8Array } = {};
    const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
    const bytes = (text: unknown) => new Uint8Array(Buffer.from(String(text), "base64url"));
    const offer = { type: "offer", publicKey: b64(publicRaw), keyId, nB: b64(nB), name: "Firefox · Linux" };
    fake.onPcMessage = async (msg) => {
      if (msg.type === "commit") {
        state.commit = bytes(msg.commit);
        fake.fromBrowser(offer);
        if (options.extraOffer) fake.fromBrowser(offer);
      } else if (msg.type === "reveal") {
        state.pcPub = bytes(msg.publicKey);
        const nP = bytes(msg.nP);
        await assertCommitment(state.commit!, state.pcPub, nP);
        state.transcript = await pairTranscript({ userId: USER_ID, pcId: PC_ID, pcPublicRaw: state.pcPub, browserPublicRaw: publicRaw, nP, nB });
        state.codes = await pairCodes(state.transcript);
      } else if (msg.type === "done") {
        state.doneVerified = await verifyBytes(publicJwkFromRaw(state.pcPub!), bytes(msg.signature), pairDoneInput(state.transcript!));
      }
    };
    return { keyId, state };
  }

  async function pair(answer: () => string) {
    const pcKey = await generateSigningJwk();
    const pinned: MatchedBrowser[] = [];
    let asked = false;
    const outcome = await runPairing({
      userId: USER_ID, pcId: PC_ID, pcKey, transport: relay(), waitMs: 10_000,
      prompt: { show: () => undefined, ask: async () => { asked = true; return answer(); } },
      pin: async (browserKey) => { pinned.push(browserKey); },
    });
    return { outcome, pinned, asked };
  }

  it("맞는 코드 — open → commit → (poll) offer → reveal → 코드 B → done 을 브라우저가 검증 · 메시지 모양(A5) · 호출마다 요청·응답 줄, 내용은 남기지 않음", async () => {
    const web = await browser();
    const { outcome, pinned } = await pair(() => web.state.codes!.b);
    expect(outcome).toMatchObject({ kind: "paired", doneError: undefined });
    expect(pinned.map((item) => item.keyId)).toEqual([web.keyId]);
    expect(web.state.doneVerified).toBe(true);
    expect(fake.calls.map((call) => call.op).filter((op, index, all) => op !== all[index - 1]))
      .toEqual(["pair/open", "pair/send", "pair/poll", "pair/send"]);   // 이어진 같은 호출은 하나로 — poll 은 여러 번일 수 있다
    expect(fake.calls.filter((call) => call.op === "pair/send")).toHaveLength(3);
    expect(fake.calls[0]?.body).toEqual({ pcId: PC_ID });
    expect(fake.toBrowser.map((msg) => Object.keys(msg).sort())).toEqual([
      ["commit", "type"], ["nP", "publicKey", "type"], ["signature", "type"]]);
    expect(fake.calls.filter((call) => call.op !== "pair/open").every((call) => call.body.attemptId === fake.attemptId)).toBe(true);
    const log = (await readFile(logPath(), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const requests = log.filter((r) => r.event === "remote_call").map((r) => r.callId);
    const responses = new Set(log.filter((r) => r.event === "remote_call_response").map((r) => r.callId));
    expect(requests.length).toBe(fake.calls.length);
    expect(requests.every((id) => responses.has(id))).toBe(true);
    const text = JSON.stringify(log);
    for (const secret of [web.state.codes!.a, web.state.codes!.b, String(fake.toBrowser[0]?.commit), String(fake.toBrowser[1]?.nP)]) {
      expect(text).not.toContain(secret);
    }
  });

  it("틀린 코드 → code-mismatch · done 없음 · abort 를 보낸다", async () => {
    const web = await browser();
    const { outcome, pinned } = await pair(() => (web.state.codes!.b === "000000" ? "000001" : "000000"));
    expect(outcome).toEqual({ kind: "code-mismatch" });
    expect(pinned).toEqual([]);
    expect(fake.toBrowser.map((msg) => msg.type)).toEqual(["commit", "reveal", "abort"]);
    expect(fake.toBrowser.at(-1)).toEqual({ type: "abort", reason: "code-mismatch" });
  });

  it("제안이 둘 오면(중복) PAIR_DUPLICATE · 서버가 시도를 닫으면 PAIR_CLOSED — 코드를 묻지 않고 핀 없음", async () => {
    await browser({ extraOffer: true });
    const duplicate = await pair(() => "123456").then(() => undefined, (error: unknown) => error);
    expect(duplicate).toBeInstanceOf(PairRelayError);
    expect((duplicate as PairRelayError).code).toBe("PAIR_DUPLICATE");

    fake.onPcMessage = (msg) => {
      if (msg.type === "commit") fake.close();
    };
    const closed = await pair(() => "123456").then(() => undefined, (error: unknown) => error);
    expect((closed as PairRelayError).code).toBe("PAIR_CLOSED");
  });

  it("한 poll 의 브라우저 메시지 해석(순수) — 비면 다시 · abort · 모양 틀림은 PAIR_BAD_MESSAGE", () => {
    expect(offerOf([])).toBeUndefined();
    expect(offerOf([{ type: "abort", reason: "x" }])).toBe("abort");
    expect(() => offerOf([{ type: "offer", publicKey: "AA", keyId: "k", nB: "AA", name: "n" }])).toThrow(PairRelayError);
    expect(() => offerOf([{ type: "reveal" }])).toThrow(PairRelayError);
  });
});
