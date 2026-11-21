import { describe, expect, it } from "vitest";
import { generateSigningJwk, publicJwkOf, type EcPrivateJwk } from "../src/core/term/e2e";
import {
  ACTIVE_CHANNEL_MAX,
  answerCodeOf,
  ChannelBook,
  HANDSHAKE_MAX,
  HANDSHAKE_TTL_MS,
  sealedCommand,
  wireCommand,
  type HelloTrust,
  type WireCommand,
} from "../src/core/term/remoteChannel";
import { TestBrowser, type BrowserChannel, type SealedCmd } from "./support/e2eBrowser";

const USER_ID = "5b1f2c9e-0a7d-4e63-8f41-9c2d7b6a3e10";
const PC_ID = "6f2c1d3e-0000-4000-8000-000000000003";
const OP = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const INSTANCE = "inst-1";

/**
 * PC 쪽 채널 장부(remoteChannel.ts) — 진짜 암호로 행동하는 시험 브라우저(support/e2eBrowser)와 맞물린다. 서버·데몬 없음.
 * 설계 §14 · A1~A7 · §13-3(재도착·결번·되감기 구분) · §13-4(C-E8) · C-E5.
 */
describe("E2E 채널 장부 — hello·confirm·순서·봉인", () => {
  let clock = 0;
  const now = (): number => clock;

  async function world(): Promise<{ book: ChannelBook; pcKey: EcPrivateJwk; browser: TestBrowser; trust: HelloTrust }> {
    clock = 1_000;
    const pcKey = await generateSigningJwk();
    const browser = await TestBrowser.create();
    return { book: new ChannelBook(PC_ID, now), pcKey, browser, trust: { userId: USER_ID, pcKey, browsers: [browser.paired()] } };
  }

  async function open(book: ChannelBook, browser: TestBrowser, trust: HelloTrust, channelId: string, confirm = true): Promise<BrowserChannel> {
    const started = await browser.hello({ userId: USER_ID, pcId: PC_ID, tab: `tab-${channelId}` });
    const outcome = await book.hello(channelId, started.hello, trust);
    if (outcome.type !== "welcome") throw new Error(`no welcome: ${outcome.type}`);
    const channel = await started.finish(outcome.welcome, publicJwkOf(trust.pcKey));
    if (confirm) {
      expect(await book.receive(wire(channelId, await channel.seal("confirm", {})))).toMatchObject({ type: "confirmed" });
    }
    return channel;
  }

  const wire = (channelId: string, sealed: SealedCmd, extra: Partial<WireCommand> = {}): WireCommand =>
    ({ channelId, ...sealed, kind: sealed.kind as WireCommand["kind"], ...extra });

  it("상수는 결재한 값 — 미확정 30초·4(C-E8) · 활성 8(C-E5)", () => {
    expect(HANDSHAKE_TTL_MS).toBe(30_000);
    expect(HANDSHAKE_MAX).toBe(4);
    expect(ACTIVE_CHANNEL_MAX).toBe(8);
  });

  it("고정 핀의 hello → welcome 서명을 브라우저가 검증 · confirm(n=0) 복호 뒤에만 활성 · 실행 확인 지점 0", async () => {
    const { book, browser, trust } = await world();
    const channel = await open(book, browser, trust, "c1", false);
    expect(book.isActive("c1")).toBe(false);
    expect(book.executedThrough("c1")).toBeUndefined();
    expect(await book.receive(wire("c1", await channel.seal("confirm", {})))).toEqual({ type: "confirmed", browser: { keyId: browser.keyId, name: browser.name } });
    expect(book.isActive("c1")).toBe(true);
    expect(book.executedThrough("c1")).toBe(0);
  });

  it("짝짓지 않은 키·서명 틀림·모양 틀림·신뢰 없음 → refuse(PAIRING_REQUIRED) · 장부에 남지 않음", async () => {
    const { book, browser, trust } = await world();
    const stranger = await TestBrowser.create();
    const foreign = await stranger.hello({ userId: USER_ID, pcId: PC_ID, tab: "t" });
    expect(await book.hello("x1", foreign.hello, trust)).toEqual({ type: "refuse" });
    // 핀된 keyId 를 대지만 다른 키로 서명.
    const forged = await browser.hello({ userId: USER_ID, pcId: PC_ID, tab: "t", signWith: stranger.key });
    expect(await book.hello("x2", forged.hello, trust)).toEqual({ type: "refuse" });
    // 다른 PC 의 hello(서명 입력에 pcId 가 들어간다).
    const otherPc = await browser.hello({ userId: USER_ID, pcId: "6f2c1d3e-0000-4000-8000-0000000000ff", tab: "t" });
    expect(await book.hello("x3", otherPc.hello, trust)).toEqual({ type: "refuse" });
    const good = await browser.hello({ userId: USER_ID, pcId: PC_ID, tab: "t" });
    expect(await book.hello("x4", { ...good.hello, nB: "short" }, trust)).toEqual({ type: "refuse" });
    expect(await book.hello("x5", good.hello, undefined)).toEqual({ type: "refuse" });
    expect(["x1", "x2", "x3", "x4", "x5"].some((id) => book.has(id))).toBe(false);
  });

  it("미확정 후보는 4개까지(5번째 HANDSHAKE_LIMIT) · 30초 지나면 정리 · 늦은 confirm 은 HANDSHAKE_EXPIRED · 같은 channelId 는 무시", async () => {
    const { book, browser, trust } = await world();
    const pending: BrowserChannel[] = [];
    for (let index = 0; index < HANDSHAKE_MAX; index += 1) pending.push(await open(book, browser, trust, `p${index}`, false));
    const fifth = await browser.hello({ userId: USER_ID, pcId: PC_ID, tab: "t5" });
    expect(await book.hello("p4", fifth.hello, trust)).toEqual({ type: "close", reason: "HANDSHAKE_LIMIT" });
    expect(await book.hello("p0", fifth.hello, trust)).toEqual({ type: "ignored" });
    clock += HANDSHAKE_TTL_MS - 1;
    expect(await book.receive(wire("p0", await pending[0]!.seal("confirm", {})))).toMatchObject({ type: "confirmed" });
    clock += 1;
    expect(await book.receive(wire("p1", await pending[1]!.seal("confirm", {})))).toEqual({ type: "close", reason: "HANDSHAKE_EXPIRED" });
    expect(book.expired().sort()).toEqual(["p2", "p3"]);
    expect(book.isActive("p0")).toBe(true);
  });

  it("활성 채널은 8개까지 — 9번째 confirm 은 CHANNEL_LIMIT", async () => {
    const { book, browser, trust } = await world();
    for (let index = 0; index < ACTIVE_CHANNEL_MAX; index += 1) await open(book, browser, trust, `a${index}`);
    const ninth = await open(book, browser, trust, "a8", false);
    expect(await book.receive(wire("a8", await ninth.seal("confirm", {})))).toEqual({ type: "close", reason: "CHANNEL_LIMIT" });
    expect(book.activeIds()).toHaveLength(ACTIVE_CHANNEL_MAX);
  });

  it("웹→PC 순서 — 정확히 직전 + 1 · 직전 번호 같은 암호문 재도착은 duplicate(실행 없음) · 결번·되감기·다른 암호문 같은 번호는 CHANNEL_OUT_OF_ORDER", async () => {
    const { book, browser, trust } = await world();
    const channel = await open(book, browser, trust, "c1");
    const first = await channel.seal("input", { session: "a", instance: INSTANCE, d: Buffer.from("ls\r").toString("base64") }, { session: "a" });
    const received = await book.receive(wire("c1", first));
    expect(received).toMatchObject({ type: "command", command: { kind: "input", session: "a", instance: INSTANCE } });
    expect(received.type === "command" && received.command.kind === "input" ? received.command.bytes.toString() : "").toBe("ls\r");
    expect(await book.receive(wire("c1", first))).toEqual({ type: "duplicate" });

    // 같은 번호 다른 암호문 → 되감기로 닫힌다.
    const sameN = await channel.seal("key", { session: "a", instance: INSTANCE, key: "enter" }, { session: "a" }, { n: first.n });
    expect(await book.receive(wire("c1", sameN))).toEqual({ type: "close", reason: "CHANNEL_OUT_OF_ORDER" });
    expect(book.has("c1")).toBe(false);

    const gapped = await open(book, browser, trust, "c2");
    gapped.skip();   // n=1 의 poll 응답을 잃었다
    const after = await gapped.seal("key", { session: "a", instance: INSTANCE, key: "enter" }, { session: "a" });
    expect(after.n).toBe(2);
    expect(await book.receive(wire("c2", after))).toEqual({ type: "close", reason: "CHANNEL_OUT_OF_ORDER" });

    const rewound = await open(book, browser, trust, "c3");
    await book.receive(wire("c3", await rewound.seal("key", { session: "a", instance: INSTANCE, key: "up" }, { session: "a" })));
    await book.receive(wire("c3", await rewound.seal("key", { session: "a", instance: INSTANCE, key: "up" }, { session: "a" })));
    const old = await rewound.seal("key", { session: "a", instance: INSTANCE, key: "down" }, { session: "a" }, { n: 1 });
    expect(await book.receive(wire("c3", old))).toEqual({ type: "close", reason: "CHANNEL_OUT_OF_ORDER" });

    // confirm 은 n=0 뿐 — 활성 전 다른 종류도 닫는다.
    const early = await open(book, browser, trust, "c4", false);
    expect(await book.receive(wire("c4", await early.seal("key", { session: "a", instance: INSTANCE, key: "up" }, { session: "a" }))))
      .toEqual({ type: "close", reason: "CHANNEL_OUT_OF_ORDER" });
    expect(await book.receive(wire("gone", first))).toEqual({ type: "unknown" });
  });

  it("AAD = 선 위 칸 — 다른 칸으로 봉인했거나 본문이 선 위와 다르거나 태그가 틀리면 DECRYPT_FAILED · 상태는 넘어가지 않는다", async () => {
    const { book, browser, trust } = await world();
    const body = { session: "a", instance: INSTANCE, key: "enter" };
    const c1 = await open(book, browser, trust, "c1");
    // 서버가 선 위 session 을 b 로 바꿨다(봉인은 a).
    expect(await book.receive(wire("c1", await c1.seal("key", body, { session: "b" }, { aad: { session: "a" } }))))
      .toEqual({ type: "close", reason: "DECRYPT_FAILED" });
    const c2 = await open(book, browser, trust, "c2");
    // AAD·선 위는 b 인데 본문은 a — 봉인 본문 대조에서 걸린다.
    expect(await book.receive(wire("c2", await c2.seal("key", body, { session: "b" })))).toEqual({ type: "close", reason: "DECRYPT_FAILED" });
    const c3 = await open(book, browser, trust, "c3");
    const sealed = await c3.seal("key", body, { session: "a" });
    const flipped = Buffer.from(sealed.c, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(await book.receive(wire("c3", { ...sealed, c: flipped.toString("base64url") }))).toEqual({ type: "close", reason: "DECRYPT_FAILED" });
    // 종류도 AAD 다 — key 로 봉인한 것을 resize 라고 넘기면 열리지 않는다.
    const c4 = await open(book, browser, trust, "c4");
    expect(await book.receive(wire("c4", await c4.seal("key", body, { session: "a" }), { kind: "resize" }))).toEqual({ type: "close", reason: "DECRYPT_FAILED" });
  });

  it("봉인 본문 대조(순수) — 만들기 opId·name·projectUuid 가 선 위와 같아야 · 세션 명령은 instance 필수 · 모르는 칸은 무시", () => {
    const plain = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
    const create = (meta: Partial<WireCommand>) => ({ channelId: "c", n: 1, c: "x", kind: "create" as const, ...meta });
    expect(sealedCommand(create({ session: "w", opId: OP }), plain({ opId: OP, name: "w", command: "npm test", extra: 1 })))
      .toEqual({ kind: "create", opId: OP, name: "w", command: "npm test" });
    expect(sealedCommand(create({ session: "w", opId: OP }), plain({ opId: OP, name: "other" }))).toBeUndefined();
    expect(sealedCommand(create({ session: "w", opId: OP }), plain({ opId: OP, name: "w", projectUuid: OP }))).toBeUndefined();
    expect(sealedCommand(create({ session: "w", opId: OP, projectUuid: OP }), plain({ opId: OP, name: "w", projectUuid: OP })))
      .toEqual({ kind: "create", opId: OP, name: "w", projectUuid: OP });
    const kill = { channelId: "c", n: 1, c: "x", kind: "kill" as const, session: "w", opId: OP };
    expect(sealedCommand(kill, plain({ opId: OP, session: "w", instance: INSTANCE }))).toEqual({ kind: "kill", opId: OP, session: "w", instance: INSTANCE });
    expect(sealedCommand(kill, plain({ opId: OP, session: "w" }))).toBeUndefined();
    expect(sealedCommand({ ...kill, kind: "input", opId: undefined }, plain({ session: "w", instance: INSTANCE, d: "!!" }))).toBeUndefined();
    expect(sealedCommand({ channelId: "c", n: 0, c: "x", kind: "confirm", session: "w" }, plain({}))).toBeUndefined();
    expect(sealedCommand({ channelId: "c", n: 0, c: "x", kind: "confirm" }, new Uint8Array([0xff]))).toBeUndefined();
  });

  it("선 위 cmd 모양(순수) · CRUD 바깥 코드는 허용 목록만(A7)", () => {
    expect(wireCommand({ type: "cmd", channelId: "c", n: 3, c: "AA", kind: "label", session: "s", opId: OP, requestId: "r", extra: true }))
      .toEqual({ channelId: "c", n: 3, c: "AA", kind: "label", session: "s", opId: OP, requestId: "r" });
    expect(wireCommand({ channelId: "c", n: -1, c: "AA", kind: "input" })).toBeUndefined();
    expect(wireCommand({ channelId: "c", n: 1.5, c: "AA", kind: "input" })).toBeUndefined();
    expect(wireCommand({ channelId: "c", n: 1, c: "AA", kind: "later" })).toBeUndefined();
    expect(answerCodeOf("TERM_SESSION_EXISTS")).toBe("TERM_SESSION_EXISTS");
    expect(answerCodeOf("SESSION_REPLACED")).toBe("SESSION_REPLACED");
    expect(answerCodeOf("TERM_BAD_CWD")).toBe("TERM_FAILED");
    expect(answerCodeOf("EACCES")).toBe("TERM_FAILED");
  });

  it("PC→웹 봉인 — 채널마다 번호 하나(frame·answer 공유, 0부터) · 브라우저가 같은 AAD 로 연다 · 실행 확인 지점은 연속으로만 · 닫힌 채널은 봉인 거절", async () => {
    const { book, browser, trust } = await world();
    const channel = await open(book, browser, trust, "c1");
    const frames = await Promise.all([
      book.seal("c1", { kind: "frame", session: "a" }, { d: "eA==", instance: INSTANCE, executedThrough: 0 }),
      book.seal("c1", { kind: "answer", session: "w", opId: OP }, { opId: OP, kind: "create", ok: true }),
    ]);
    expect(frames.map((box) => box.n)).toEqual([0, 1]);
    expect(await channel.open("frame", 0, frames[0]!.c, { session: "a" })).toEqual({ d: "eA==", instance: INSTANCE, executedThrough: 0 });
    expect(await channel.open("answer", 1, frames[1]!.c, { session: "w", opId: OP })).toEqual({ opId: OP, kind: "create", ok: true });
    await expect(channel.open("frame", 1, frames[1]!.c, { session: "w", opId: OP })).rejects.toThrow();
    expect(book.executed("c1", 2)).toBe(false);
    expect(book.executed("c1", 1)).toBe(true);
    expect(book.executedThrough("c1")).toBe(1);
    book.drop("c1");
    await expect(book.seal("c1", { kind: "frame", session: "a" }, {})).rejects.toMatchObject({ reason: "CHANNEL_GONE" });
  });

  it("웹→PC 번호가 2^32 에 닿으면 MESSAGE_LIMIT(C-E4)", async () => {
    const { book, browser, trust } = await world();
    await open(book, browser, trust, "c1");
    expect(await book.receive({ channelId: "c1", n: 2 ** 32, c: "AA", kind: "input", session: "a" })).toEqual({ type: "close", reason: "MESSAGE_LIMIT" });
  });
});
