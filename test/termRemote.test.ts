import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { termRequest } from "../src/core/term/client";
import { accountKey } from "../src/core/pc/pcSettings";
import { termPaths } from "../src/core/term/paths";
import { createPcNotifier } from "../src/core/pc/pcNotify";
import { createRemoteHttp, openRemoteLog, pollItems, remoteStateOf, runRemoteBridge, type BridgeDeps, type RemoteResult } from "../src/core/term/remote";
import { frameBudget, screenFrame } from "../src/core/term/remoteFrame";
import type { CellStyle } from "../src/core/term/screen";
import { CALL_TIMEOUT_MS, IMAGE_KEEP_MS, RETRY_MAX_MS, RETRY_MIN_MS, retryWait } from "../src/core/term/remoteLimits";
import { endedThatFit, listing } from "../src/core/term/remoteSessions";
import { RemoteViewer } from "../src/core/term/remoteViewer";
import { FakeRemoteServer } from "./support/fakeRemoteServer";
import { FakeWeb, WebChannel, type Crud, type OpenedFrame } from "./support/fakeWeb";
import { loadPcKeys } from "../src/core/pc/pcKeys";
import type { RequestRelay } from "../src/core/pc/pcPairRelay";
import {
  assertCommitment,
  browserKeyIdOf,
  generateSigningJwk,
  importSigningKey,
  pairApproveInput,
  pairCodes,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicRawFromJwk,
  randomBytes,
  signBytes,
  verifyBytes,
} from "../src/core/term/e2e";
import { cli, daemonPids, holderPids, json, LONG, ok, pcBridgeSession, rig, screen, sessions, sleep, startOuterAt, until, useTermRig } from "./termRig";

const PROJECT = "0b9a8c7d-1111-4222-8333-444455556666";
const USER_ID = "5b1f2c9e-0a7d-4e63-8f41-9c2d7b6a3e10";
const PC_ID = "6f2c1d3e-0000-4000-8000-000000000001";

describe("원격 다리 — 순수 함수", () => {
  it("화면 = 줄을 \\r\\n 으로 이은 평문 · 같은 줄이면 같은 hash · 상한을 넘으면 위 줄부터 덜어 낸다", () => {
    const a = screenFrame(["$ cat", "hi"], 1_000);
    expect(Buffer.from(a.d, "base64").toString("utf8")).toBe("$ cat\r\nhi");
    expect(screenFrame(["$ cat", "hi"], 1_000).hash).toBe(a.hash);
    expect(screenFrame(["$ cat", "hi!"], 1_000).hash).not.toBe(a.hash);
    const fit = screenFrame(["가".repeat(10), "b".repeat(10), "c".repeat(10)], 32);
    expect(fit.dropped).toBe(1);
    expect(screenFrame(["x"], 0).d).toBe("");
  });

  it("Ryan 11-25 색 싣기 — 속성 구간은 그 줄과 함께 덜어 내고 커서 줄 번호도 옮긴다 · 덜어 낸 줄의 커서는 없다 · 속성만 바뀌어도 hash 가 바뀐다", () => {
    const styles: CellStyle[] = [{ dim: true }];
    const attributes = { styles, runs: [[0, 1, 0], [], [0, 2, 0]], cursor: { row: 2, col: 1 } };
    const whole = screenFrame(["a", "b", "cc"], 1_000, attributes);
    expect(whole).toMatchObject({ runs: [[0, 1, 0], [], [0, 2, 0]], cursor: { row: 2, col: 1 }, dropped: 0 });
    expect(whole.hash).not.toBe(screenFrame(["a", "b", "cc"], 1_000).hash);
    expect(screenFrame(["a", "b", "cc"], 1_000, { ...attributes, cursor: { row: 2, col: 2 } }).hash).not.toBe(whole.hash);
    // 상한 — 글자(base64)와 구간 JSON 을 함께 센다: 위 한 줄을 덜면 구간도 한 줄 준다.
    const tight = screenFrame(["a", "b", "cc"], base64Size("b\r\ncc") + 10 + cursorSize() + "[],".length + "[0,2,0],".length, attributes);
    expect(tight).toMatchObject({ dropped: 1, runs: [[], [0, 2, 0]], cursor: { row: 1, col: 1 } });
    expect(screenFrame(["a", "b", "cc"], 1_000, { ...attributes, cursor: { row: 0, col: 0 } }).cursor).toEqual({ row: 0, col: 0 });
    const lost = screenFrame(["a", "b", "cc"], base64Size("b\r\ncc") + 10 + cursorSize() + 20, { ...attributes, cursor: { row: 0, col: 0 } });
    expect(lost.dropped).toBe(1);
    expect(lost).not.toHaveProperty("cursor");
    // 줄 수가 다른 구간(데몬이 어긴 모양)은 싣지 않는다.
    expect(screenFrame(["a"], 1_000, { styles, runs: [] })).not.toHaveProperty("runs");
  });

  it("봉인 frame 의 d 자리 = 상한 − 바깥 칸(번호는 가장 긴 값) − base64url − 태그 16 − 봉인 본문의 다른 칸 · 그 d 로 만든 본문은 상한 안", () => {
    const outer = { linkId: randomUUID(), channelId: randomUUID(), session: "main", cols: 120, rows: 40 };
    const sealed = { modes: { altScreen: false, appCursor: true, bracketedPaste: false }, instance: randomUUID() };
    const maxD = frameBudget(8_000, outer, sealed);
    const plain = JSON.stringify({ d: "A".repeat(maxD), ...sealed, executedThrough: 2 ** 32 - 1 });
    const c = Buffer.alloc(Buffer.byteLength(plain) + 16).toString("base64url");
    expect(Buffer.byteLength(JSON.stringify({ ...outer, n: 2 ** 32 - 1, c }))).toBeLessThanOrEqual(8_000);
    const overC = Buffer.alloc(Buffer.byteLength(plain) + 16 + 3).toString("base64url");
    expect(Buffer.byteLength(JSON.stringify({ ...outer, n: 2 ** 32 - 1, c: overC }))).toBeGreaterThan(8_000);
  });

  it("poll 항목(A1) — hello·cmd·watch·channel-closed 만 · 서버 순서 그대로 · 모양 틀린 cmd 는 채널을 알면 bad-cmd · 옛 평문 칸은 버린다", () => {
    expect(pollItems({ commands: [
      { type: "hello", channelId: "c1", hello: { channel: "t" } },
      { type: "cmd", channelId: "c1", n: 0, c: "AA", kind: "confirm" },
      { type: "watch", channels: [{ channelId: "c1", session: "a" }, { channelId: "", session: "b" }, { session: "x" }] },
      { type: "cmd", channelId: "c1", n: 1, kind: "input" },
      { type: "channel-closed", channelId: "c2" },
      { type: "input", session: "a", d: "aGk=" },
      { type: "create", requestId: "r1", name: "new", command: "npm test" },
      { type: "hello" },
    ] })).toEqual([
      { type: "hello", channelId: "c1", hello: { channel: "t" } },
      { type: "cmd", command: { channelId: "c1", n: 0, c: "AA", kind: "confirm" } },
      { type: "watch", channels: [{ channelId: "c1", session: "a" }] },
      { type: "bad-cmd", channelId: "c1", n: 1 },
      { type: "channel-closed", channelId: "c2" },
    ]);
    expect(pollItems({ state: "OPEN" })).toEqual([]);
    expect(remoteStateOf("off-by-web")).toBe("off-by-web");
    expect(remoteStateOf("later")).toBeUndefined();
  });

  it("올릴 목록 — PC 연결 세션(종류 pc-bridge)은 뺀다 · 남은 줄은 kind user · label·project·lastOutputAt·instance 는 있을 때만(옛 데몬은 instance 칸 없음)", () => {
    const instance = randomUUID();
    const pcRun = ["npx", "-y", "--package", "@ainecto/mcp@0.16.4", "ainecto", "pc", "run"];
    const got = listing([
      { name: "ainecto-pc", pid: 1, clients: 0, cols: 80, rows: 24, cwd: "/", command: pcRun, instance: randomUUID(), kind: "pc-bridge" },
      { name: "api", pid: 2, clients: 0, cols: 100, rows: 30, cwd: "/", command: null, label: "백엔드", project: PROJECT,
        lastOutputAt: "2026-11-17T00:00:00Z", instance },
      { name: "web", pid: 3, clients: 1, cols: 80, rows: 24, cwd: "/", command: ["npm", "start"] },
    ], undefined, "srv#u1");
    expect(got.sessions).toEqual([
      { name: "api", label: "백엔드", project: PROJECT, cols: 100, rows: 30, lastOutputAt: "2026-11-17T00:00:00Z", instance, kind: "user" },
      { name: "web", cols: 80, rows: 24, kind: "user" },
    ]);
    expect(got.bridges).toEqual(["ainecto-pc"]);
    // 옛 데몬(ls 에 ended 칸 없음) — 올릴 끝 기록 0 · 지울 것도 모름(ended-ack·listed-to 를 보내지 않는다)
    expect(got.ended).toEqual([]);
    expect(got.drop).toEqual([]);
    expect(got.known).toBe(false);
  });

  it("올릴 끝 기록 — 이 수신처가 목록으로 받은 user 것만 서버 모양으로(command·to 는 싣지 않음) · 다른 수신처 것은 싣지도 지우지도 않음 · PC 연결 세션·아무도 못 본 세션의 끝은 올리지 않고 지운다 · 수신처를 모르면 아무것도 안 다룬다", () => {
    const pcRun = ["npx", "-y", "--package", "@ainecto/mcp@0.16.3", "ainecto", "pc", "run"];
    const [a, b, c, d, e, f] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const book = [
      { instance: a, name: "api", command: null, endedAt: "2026-11-26T01:00:00.000Z", reason: "exited" as const, exitCode: 3, to: "srv#u1" },
      { instance: b, name: "ainecto-pc", kind: "pc-bridge" as const, command: pcRun, endedAt: "2026-11-26T01:00:01.000Z", reason: "killed" as const, to: "srv#u1" },
      { instance: c, name: "ainecto-pc", command: pcRun, endedAt: "2026-11-26T01:00:02.000Z", reason: "exited" as const, signal: "15" },
      { instance: d, name: "job", kind: "user" as const, command: ["node", "tasks.js", "pc", "run"], endedAt: "2026-11-26T01:00:03.000Z", reason: "killed" as const, to: "srv#u1" },
      { instance: e, name: "other", kind: "user" as const, command: null, endedAt: "2026-11-26T01:00:04.000Z", reason: "exited" as const, exitCode: 0, to: "srv#u2" },
      { instance: f, name: "never", kind: "user" as const, command: null, endedAt: "2026-11-26T01:00:05.000Z", reason: "exited" as const, exitCode: 0 },
    ];
    const got = listing([], book, "srv#u1");
    expect(got.ended).toEqual([
      { instance: a, name: "api", kind: "user", endedAt: "2026-11-26T01:00:00.000Z", reason: "exited", exitCode: 3 },
      { instance: d, name: "job", kind: "user", endedAt: "2026-11-26T01:00:03.000Z", reason: "killed" },
    ]);
    expect(got.drop).toEqual([b, c, f]);   // e(다른 수신처)는 없다
    expect(got.known).toBe(true);
    expect(listing([], book, "srv#u2").ended.map((r) => r.instance)).toEqual([e]);
    expect(listing([], book, undefined)).toMatchObject({ ended: [], drop: [] });
  });

  it("본문 상한 안의 끝 기록 수 — 앞에서부터 들어가는 만큼 · 상한을 모르면 전부 · 하나도 안 들어가면 0", () => {
    const ended = Array.from({ length: 50 }, (_, i) => ({ instance: randomUUID(), name: `s${i}`, kind: "user" as const,
      endedAt: "2026-11-26T01:00:00.000Z", reason: "exited" as const, exitCode: 0 }));
    const body = { linkId: randomUUID(), sessions: [] };
    expect(endedThatFit(body, ended, undefined)).toBe(50);
    const count = endedThatFit(body, ended, 2000);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(50);
    expect(Buffer.byteLength(JSON.stringify({ ...body, ended: ended.slice(0, count) }))).toBeLessThanOrEqual(2000);
    expect(Buffer.byteLength(JSON.stringify({ ...body, ended: ended.slice(0, count + 1) }))).toBeGreaterThan(2000);
    expect(endedThatFit(body, ended, 10)).toBe(0);
  });

  it("다시 하기 간격 — C12 에서 두 배씩 C13 까지 · 흔들림 0~C12", () => {
    expect(retryWait(0, 0)).toBe(RETRY_MIN_MS);
    expect(retryWait(1, 0)).toBe(RETRY_MIN_MS * 2);
    expect(retryWait(30, 0)).toBe(RETRY_MAX_MS);
    expect(retryWait(30, 0.999)).toBeLessThan(RETRY_MAX_MS + RETRY_MIN_MS);
  });
});

describe("원격 다리 E2E — 실 데몬 + 서버 대역 + 시험 브라우저(진짜 암호)", () => {
  useTermRig();
  let fake: FakeRemoteServer;
  beforeEach(async () => {
    fake = new FakeRemoteServer();
    await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const keysPath = (): string => join(rig.home, ".ainecto", "pc-keys.json");
  const ids = () => ({ userId: USER_ID, pcId: PC_ID, keysPath: keysPath(), accountKey: accountKey(fake.endpoint, USER_ID) });
  const web = (options: { pin?: boolean; name?: string } = {}): Promise<FakeWeb> => FakeWeb.create(fake, ids(), options);

  function start(options: { remoteEnabled?: boolean; destination?: string; onAnswer?: BridgeDeps["onAnswer"]; trust?: boolean;
    pairRelay?: BridgeDeps["pairRelay"] } = {})
    : { done: Promise<RemoteResult>; stop: AbortController; printed: string[]; notified: string[][] } {
    const paths = termPaths(rig.home);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });   // 운영은 pcRemoteSetup 이 만든다
    const log = openRemoteLog(paths);
    const printed: string[] = [];
    /** 알림 도구에 넘긴 인자(macOS osascript 모양) — 실제 알림은 띄우지 않는다. */
    const notified: string[][] = [];
    const stop = new AbortController();
    const done = runRemoteBridge({
      paths,
      http: createRemoteHttp({
        endpoint: fake.endpoint,
        tokenProvider: { getAccessToken: async () => "t", refreshAfterUnauthorized: async () => "t" },
        log,
      }),
      log,
      pcId: PC_ID,
      hostName: "test-host",
      cliVersion: "dev",
      remoteEnabled: options.remoteEnabled ?? true,
      trust: options.trust === false ? undefined : { keysPath: keysPath(), accountKey: accountKey(fake.endpoint, USER_ID), userId: USER_ID.toUpperCase() },
      destination: options.destination ?? (options.trust === false ? undefined : accountKey(fake.endpoint, USER_ID)),
      notifier: createPcNotifier({ log, platform: "darwin", run: async (_file, args) => { notified.push(args); } }),
      sessionEnv: Object.fromEntries(Object.entries(rig.env).filter((e): e is [string, string] => typeof e[1] === "string")),
      appHome: join(rig.home, "app"),
      signal: stop.signal,
      print: (line) => printed.push(line),
      ...(options.onAnswer ? { onAnswer: options.onAnswer } : {}),
      ...(options.pairRelay ? { pairRelay: options.pairRelay } : {}),
    });
    return { done, stop, printed, notified };
  }

  function remoteLog(): Array<Record<string, unknown>> {
    return readFileSync(termPaths(rig.home).remoteLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** 요청 줄마다 같은 callId 의 응답 줄이 있다 · 명령 줄마다 결과 줄이 있다. */
  function expectLogPairs(): void {
    const records = remoteLog();
    const requests = records.filter((r) => r.event === "remote_call").map((r) => r.callId);
    const responses = new Set(records.filter((r) => r.event === "remote_call_response").map((r) => r.callId));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((id) => !responses.has(id))).toEqual([]);
    expect(records.filter((r) => r.event === "remote_command").length)
      .toBe(records.filter((r) => r.event === "remote_command_result").length);
  }

  /** 그 채널에서 그 세션의 화면이 조건을 만족할 때까지 — 그 화면. */
  async function frameWhere(channel: WebChannel, session: string, check: (frame: OpenedFrame) => boolean, what: string) {
    let found: Awaited<ReturnType<WebChannel["latest"]>>;
    await until(async () => {
      found = (await channel.frames()).filter((frame) => frame.session === session).find(check);
      return found !== undefined;
    }, what);
    return found!;
  }

  const lines = (text: string): string[] => text.split("\r\n");

  it("open 에 e2e:1 · 짝지은 브라우저 hello → welcome(서명 검증) → confirm 뒤 보는 세션만 봉인 화면 · 세션별 입력 · 선 위 본문에 표지 없음 · 멈춤 → close", async () => {
    await ok("term", "new", "a", "--", "cat");
    await ok("term", "new", "b", "--", "cat");
    await pcBridgeSession();   // PC 연결 세션(종류 pc-bridge — holder 는 종류 없는 요청을 user 로 적는다)
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    expect(fake.calls[0]?.body).toMatchObject({ pcId: PC_ID, hostName: "test-host", cliVersion: "dev", remoteEnabled: true, e2e: 1 });
    expect(fake.listedNames().sort()).toEqual(["a", "b"]);
    const channel = await browser.connect();
    channel.watch("a");
    const first = await frameWhere(channel, "a", () => true, "first frame of a");
    expect(first.executedThrough).toBe(0);
    const marker = `E2E-${randomUUID()}`;
    await channel.input("a", first.instance, `${marker}\r`);
    const shown = await frameWhere(channel, "a", (frame) => lines(frame.text).includes(marker), "a shows the marker");
    expect(shown.executedThrough).toBe(1);
    expect((await channel.frames()).every((frame) => frame.session === "a")).toBe(true);

    channel.watch("b");
    const b = await frameWhere(channel, "b", () => true, "first frame of b");
    await channel.input("b", b.instance, "hi-b\r");
    await frameWhere(channel, "b", (frame) => lines(frame.text).includes("hi-b"), "b shows hi-b");
    expect((await screen("a")).includes("hi-b")).toBe(false);

    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
    expect(fake.ops().at(-1)).toBe("close");
    expect(fake.calls.slice(1).every((call) => call.token === fake.linkToken)).toBe(true);
    expectLogPairs();
    // ★서버가 본 모든 본문(요청·응답)과 다리 로그에 표지가 원문으로도 base64 로도 없다(§11-8).
    for (const text of [fake.wireText(), readFileSync(termPaths(rig.home).remoteLog, "utf8")]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain(Buffer.from(marker).toString("base64").slice(0, 16));
      expect(text).not.toContain(Buffer.from(marker).toString("base64url").slice(0, 16));
    }
    expect(readFileSync(termPaths(rig.home).remoteLog, "utf8")).not.toContain(fake.linkToken);
  }, LONG);

  it("짝짓지 않은 브라우저·신뢰 없음 → welcome refuse PAIRING_REQUIRED · 채널 없음 · 그 채널 이름의 명령은 실행 안 함 · hello 마다 pc-keys 를 다시 읽는다", async () => {
    await ok("term", "new", "a", "--", "cat");
    const pinned = await web();
    const stranger = await web({ pin: false });
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    expect(await stranger.hello()).toMatchObject({ refused: "PAIRING_REQUIRED" });
    // 다리를 다시 띄우지 않고 짝지으면 다음 hello 부터 받는다(§6).
    await stranger.pin();
    const channel = await stranger.connect();
    channel.watch("a");
    await frameWhere(channel, "a", () => true, "frame after a later pairing");
    expect(await pinned.connect()).toBeInstanceOf(WebChannel);
    run.stop.abort();
    await run.done;
    expect(remoteLog().filter((r) => r.event === "remote_hello" && r.result === "refused")).toHaveLength(1);

    const noTrust = await web();
    const blind = start({ trust: false });
    await until(() => fake.ops().filter((op) => op === "open").length === 2, "second open");
    expect(await noTrust.hello()).toMatchObject({ refused: "PAIRING_REQUIRED" });
    blind.stop.abort();
    await blind.done;
  }, LONG);

  it("웹 만들기(봉인 create — 폴더 없으면 <앱 홈>/sessions/<opId>) → 봉인 답 ok + 새 인스턴스 · 준 폴더 그대로 · 같은 이름이면 바깥 TERM_SESSION_EXISTS · 사유는 봉인 detail 에만", async () => {
    await ok("term", "new", "base", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    const made = await channel.create({ name: "made", command: "echo made-$((1+2)); pwd; sleep 600" });
    await until(async () => (await channel.answer(made)) !== undefined, "answer");
    const answer = await channel.answer(made);
    expect(answer?.outer).toMatchObject({ ok: true, channelId: channel.id });
    expect(answer?.outer).not.toHaveProperty("code");
    expect(answer?.sealed).toMatchObject({ opId: made.opId, kind: "create", session: "made", ok: true });
    expect(typeof answer?.sealed.instance).toBe("string");
    await until(() => fake.listedNames().includes("made"), "made listed");
    const folder = join(rig.home, "app", "sessions", made.opId);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect((await sessions()).find((s) => s.name === "made")?.cwd).toBe(folder);
    await ok("term", "wait", "made", "--match", "made-3", "--timeout", "10");
    await until(async () => (await screen("made")).join("").includes(`/sessions/${made.opId}`), "pwd is the session folder");

    const given = await channel.create({ name: "given", cwd: rig.home });
    await until(async () => (await channel.answer(given)) !== undefined, "given answer");
    expect((await channel.answer(given))?.sealed).toMatchObject({ ok: true });
    expect((await sessions()).find((s) => s.name === "given")?.cwd).toBe(rig.home);
    expect(existsSync(join(rig.home, "app", "sessions", given.opId))).toBe(false);

    const dup = await channel.create({ name: "made" });
    await until(async () => (await channel.answer(dup)) !== undefined, "dup answer");
    const refused = await channel.answer(dup);
    expect(refused?.outer).toMatchObject({ ok: false, code: "TERM_SESSION_EXISTS" });
    expect(String(refused?.sealed.detail)).toContain("TERM_SESSION_EXISTS");
    expect(existsSync(join(rig.home, "app", "sessions", dup.opId))).toBe(false);

    const badCwd = await channel.create({ name: "bad-cwd", cwd: join(rig.home, "no-such-dir") });
    await until(async () => (await channel.answer(badCwd)) !== undefined, "bad cwd answer");
    const bad = await channel.answer(badCwd);
    // ★바깥 코드는 허용 목록만(A7) — 경로가 든 사유는 봉인 답 안에만.
    expect(bad?.outer).toMatchObject({ ok: false, code: "TERM_FAILED" });
    expect(JSON.stringify(bad?.outer)).not.toContain("no-such-dir");
    expect(String(bad?.sealed.detail)).toContain("no-such-dir");
    expect(fake.wireText()).not.toContain("no-such-dir");
    expect(readFileSync(termPaths(rig.home).remoteLog, "utf8")).not.toContain("no-such-dir");
    // 답한 CRUD 는 ok 여부와 상관없이 실행 확인 지점을 올린다(A6).
    expect(remoteLog().filter((r) => r.event === "remote_command_result" && r.type === "create").map((r) => r.executedThrough)).toEqual([1, 2, 3, 4]);
    run.stop.abort();
    await run.done;
    // PC 알림(§11-7) — confirm 뒤 «연결» · 데몬이 만든 뒤 «명령»/«셸» · 거절된 만들기는 없음 · 글에 명령·폴더·키 id 없음 · 고정 스크립트 + 데이터 인자.
    const bodies = run.notified.map((args) => args.at(-1) ?? "");
    expect(run.notified.every((args) => args.slice(0, 6).join("|")
      === "-e|on run argv|-e|display notification (item 2 of argv) with title (item 1 of argv)|-e|end run" && args[6] === "AiNecto")).toBe(true);
    expect(bodies).toEqual([
      expect.stringMatching(/^Chrome · macOS opened a terminal connection to this PC — \d\d:\d\d\. Not you\? Run `ainecto remote off`\.$/),
      expect.stringContaining("started a command in a new terminal"),
      expect.stringContaining("started a new shell"),
    ]);
    for (const body of bodies) {
      for (const secret of ["made-", "echo", rig.home, made.opId, browser.browser.keyId]) expect(body).not.toContain(secret);
    }
    expect(remoteLog().filter((r) => r.event === "pc_notify").map((r) => r.kind)).toEqual(["session", "command", "shell"]);
    expect(remoteLog().filter((r) => r.event === "pc_notify_result").every((r) => r.ok === true)).toBe(true);
    expectLogPairs();
  }, LONG);

  it("웹 만들기 프로젝트 꼬리표 — <앱 홈>/projects/<uuid>/sessions/<opId> · 잘못된 꼬리표는 거절(TERM_BAD_REQUEST) · 선 위 projectUuid 와 봉인이 다르면 채널이 닫힌다", async () => {
    await ok("term", "new", "base", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    const tagged = await channel.create({ name: "tagged", projectUuid: PROJECT, command: "sleep 600" });
    await until(async () => (await channel.answer(tagged)) !== undefined, "answer");
    expect((await channel.answer(tagged))?.sealed).toMatchObject({ ok: true });
    const folder = join(rig.home, "app", "projects", PROJECT, "sessions", tagged.opId);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect((await sessions()).find((s) => s.name === "tagged")).toMatchObject({ cwd: folder, project: PROJECT });
    await until(() => fake.listed.some((s) => s.name === "tagged" && s.project === PROJECT), "project listed");

    const bad = await channel.create({ name: "bad", projectUuid: PROJECT.toUpperCase() });
    await until(async () => (await channel.answer(bad)) !== undefined, "bad answer");
    expect((await channel.answer(bad))?.outer).toMatchObject({ ok: false, code: "TERM_BAD_REQUEST" });
    expect(readdirSync(join(rig.home, "app", "projects"))).toEqual([PROJECT]);

    // 서버가 선 위 projectUuid 를 지웠다 — AAD 가 달라 열리지 않는다.
    const opId = randomUUID();
    const sealed = await channel.channel.seal("create", { opId, name: "swapped", projectUuid: PROJECT }, { session: "swapped", opId },
      { aad: { session: "swapped", opId, projectUuid: PROJECT } });
    channel.push(sealed, randomUUID());
    await until(() => channel.closedReason() !== undefined, "channel closed");
    expect(channel.closedReason()).toBe("DECRYPT_FAILED");
    expect((await sessions()).map((s) => s.name).sort()).toEqual(["base", "tagged"]);
    run.stop.abort();
    await run.done;
    expect(remoteLog().filter((r) => r.event === "remote_create_project_dropped")).toEqual([]);
  }, LONG);

  it("웹 끝내기·이름 바꾸기(봉인, 인스턴스 실음) → 데몬 · 봉인 답 · 목록이 따라간다", async () => {
    await ok("term", "new", "a", "--", "cat");
    await ok("term", "new", "b", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    channel.watch("a", "b");
    const a = await frameWhere(channel, "a", () => true, "frame a");
    const b = await frameWhere(channel, "b", () => true, "frame b");
    const renamed = await channel.label("a", a.instance, "백엔드 서버");
    await until(async () => (await channel.answer(renamed)) !== undefined, "label answer");
    expect((await channel.answer(renamed))?.sealed).toMatchObject({ ok: true, kind: "label", instance: a.instance });
    await until(() => fake.listed.some((s) => s.name === "a" && s.label === "백엔드 서버"), "label listed");
    const killed = await channel.kill("b", b.instance);
    await until(async () => (await channel.answer(killed)) !== undefined, "kill answer");
    expect((await channel.answer(killed))?.outer).toMatchObject({ ok: true });
    await until(() => !fake.listedNames().includes("b"), "b gone from the list");
    expect((await sessions()).map((s) => s.name)).toEqual(["a"]);
    run.stop.abort();
    await run.done;
  }, LONG);

  it("r4 조건 4 — 같은 이름으로 다시 만든 세션: 올린 목록의 instance 가 새 값으로 바뀐다 · 옛 인스턴스의 입력은 데몬이 SESSION_REPLACED 로 거절 · 새 세션에 안 감 · 실행 확인 지점 그대로 · 채널 닫힘 · 옛 목록 인스턴스로 끝내기는 답 SESSION_REPLACED", async () => {
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const listedInstance = () => fake.listed.find((s) => s.name === "a")?.instance;
    const before = listedInstance();
    const channel = await browser.connect();
    const side = await browser.connect();
    channel.watch("a");
    const old = await frameWhere(channel, "a", () => true, "frame of the first a");
    expect(before, "목록의 인스턴스 = 화면과 같은 세션 객체의 값").toBe(old.instance);
    await ok("term", "kill", "a");
    await ok("term", "new", "a", "--", "cat");
    const replaced = (await sessions()).find((s) => s.name === "a");
    expect(replaced).toBeDefined();
    await until(() => listedInstance() !== undefined && listedInstance() !== before, "new instance listed");

    // 화면을 연 적 없는 곳(side)이 목록에서 본 옛 인스턴스로 끝내기 → 데몬이 적용하는 자리에서 거절.
    const killOld = await side.kill("a", before as string);
    await until(async () => (await side.answer(killOld)) !== undefined, "kill answer");
    expect((await side.answer(killOld))?.outer).toMatchObject({ ok: false, code: "SESSION_REPLACED" });
    expect((await sessions()).map((s) => s.name)).toEqual(["a"]);

    await channel.input("a", old.instance, "to-the-old-one\r");
    await until(() => channel.closedReason() !== undefined, "channel closed");
    expect(channel.closedReason()).toBe("SESSION_REPLACED");
    await sleep(300);
    expect((await screen("a")).join("\n")).not.toContain("to-the-old-one");
    expect((await channel.frames()).every((frame) => frame.executedThrough === 0)).toBe(true);
    expect(remoteLog().filter((r) => r.event === "remote_command_result" && r.type === "input")).toEqual([
      expect.objectContaining({ ok: false, code: "SESSION_REPLACED" })]);

    // 새 인스턴스로는 된다(새 채널 — 화면이 새 인스턴스를 알린다).
    const fresh = await browser.connect();
    fresh.watch("a");
    const now = await frameWhere(fresh, "a", () => true, "frame of the new a");
    expect(now.instance).not.toBe(old.instance);
    expect(now.instance, "새 목록의 인스턴스 = 새 화면의 값").toBe(listedInstance());
    await fresh.input("a", now.instance, "to-the-new-one\r");
    await frameWhere(fresh, "a", (frame) => lines(frame.text).includes("to-the-new-one"), "new a echoes");
    run.stop.abort();
    await run.done;
  }, LONG);

  it("r4 조건 1 — ②화면이 그대로인 정상 실행(에코 끈 셸)도 executedThrough 가 오른 봉인 프레임이 다시 온다 · ①마지막 입력의 poll 유실 → 실행 확인 지점은 그 앞에 머문다(자동 재생 없음) · 다음 번호는 결번으로 채널을 닫는다", async () => {
    await ok("term", "new", "quiet", "--", "/bin/sh", "-c", "stty -echo; echo ready; cat > /dev/null");
    await ok("term", "wait", "quiet", "--match", "ready", "--timeout", "10");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    channel.watch("quiet");
    const first = await frameWhere(channel, "quiet", () => true, "first frame");
    expect(first.executedThrough).toBe(0);
    await channel.input("quiet", first.instance, "silent\r");
    const second = await frameWhere(channel, "quiet", (frame) => frame.executedThrough === 1, "executedThrough 1");
    expect(second.text).toBe(first.text);
    await channel.key("quiet", first.instance, "enter");
    await frameWhere(channel, "quiet", (frame) => frame.executedThrough === 2, "executedThrough 2");

    // ①n=3 을 실은 poll 응답을 잃었다(다리는 받지 못함) — 다음 입력이 오기 전까지 3 은 확인되지 않는다.
    channel.channel.skip();
    channel.watch("quiet");   // 다른 이유로 화면이 다시 가도
    await sleep(1_500);
    expect(Math.max(...(await channel.frames()).map((frame) => frame.executedThrough))).toBe(2);
    expect(channel.closedReason()).toBeUndefined();
    await channel.input("quiet", first.instance, "after-gap\r");
    await until(() => channel.closedReason() !== undefined, "channel closed on the gap");
    expect(channel.closedReason()).toBe("CHANNEL_OUT_OF_ORDER");
    expect(remoteLog().filter((r) => r.event === "remote_command" && r.type === "input").map((r) => r.n)).toEqual([1]);
    run.stop.abort();
    await run.done;
  }, LONG);

  it("같은 번호·같은 암호문 재도착은 확인만(두 번 실행 안 함) · 되감기·복호 실패는 그 채널만 닫는다(다른 채널은 계속)", async () => {
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    const other = await browser.connect();
    channel.watch("a");
    other.watch("a");
    const frame = await frameWhere(channel, "a", () => true, "frame");
    const once = await channel.input("a", frame.instance, "once\r");
    await frameWhere(channel, "a", (f) => lines(f.text).includes("once"), "once shown");
    channel.push(once);
    await until(() => remoteLog().some((r) => r.event === "remote_command_skipped" && r.why === "duplicate"), "duplicate skipped");
    await sleep(300);
    expect((await screen("a")).filter((line) => line === "once")).toHaveLength(2);   // cat 의 에코 + 터미널 에코 = 한 번 실행
    // 되감기 — 이미 지난 번호에 다른 암호문.
    const rewound = await channel.channel.seal("key", { session: "a", instance: frame.instance, key: "enter" }, { session: "a" }, { n: 0 });
    channel.push(rewound);
    await until(() => channel.closedReason() !== undefined, "rewind closes");
    expect(channel.closedReason()).toBe("CHANNEL_OUT_OF_ORDER");
    // 다른 채널은 그대로 — 태그를 깨면 그 채널도 닫힌다.
    const otherFrame = await frameWhere(other, "a", () => true, "other frame");
    await other.input("a", otherFrame.instance, "still-on\r");
    await frameWhere(other, "a", (f) => lines(f.text).includes("still-on"), "other channel still works");
    const broken = await other.channel.seal("key", { session: "a", instance: otherFrame.instance, key: "enter" }, { session: "a" });
    other.push({ ...broken, c: `${broken.c.slice(0, -2)}AA` });
    await until(() => other.closedReason() !== undefined, "broken tag closes");
    expect(other.closedReason()).toBe("DECRYPT_FAILED");
    run.stop.abort();
    await run.done;
  }, LONG);

  it("끝난 세션 — 데몬이 그 세션을 모르면(웹에서 끝낸 직후의 읽기) 오류 줄이 아니라 «끝남» 한 줄 · 다리는 목록을 다시 본다", async () => {
    await ok("term", "new", "a", "--", "cat");
    const paths = termPaths(rig.home);
    const log = openRemoteLog(paths);
    let gone: string | undefined;
    const viewer = new RemoteViewer({
      paths, session: "gone-already", channelId: "c", log, size: { cols: 80, rows: 24 },
      http: createRemoteHttp({ endpoint: fake.endpoint, tokenProvider: { getAccessToken: async () => "t", refreshAfterUnauthorized: async () => "t" }, log }),
      link: () => ({ linkId: "l", generation: 1, frameMaxBytes: 65536 }),
      seal: async () => ({ n: 0, c: "AA" }),
      executedThrough: () => 0,
      onGone: (reason) => { gone = reason; },
      onRefused: () => undefined,
      onUnknownSession: () => undefined,
      onChannelEnded: () => undefined,
    });
    await viewer.run();
    expect(gone).toContain("gone-already");
    expect(remoteLog().filter((r) => r.event === "remote_daemon_error")).toEqual([]);
    expect(remoteLog().filter((r) => r.event === "remote_session_ended")).toEqual([
      expect.objectContaining({ session: "gone-already", op: "watch", code: "TERM_NO_SESSION" }),
    ]);
  }, LONG);

  it("poll 응답의 cli 칸(npm 꼬리표)과 보는 세션 수를 pc run 에 넘긴다 · 칸이 없으면 undefined(옛 서버)", async () => {
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const answers: Array<Parameters<NonNullable<BridgeDeps["onAnswer"]>>[0]> = [];
    const run = start({ onAnswer: (a) => answers.push(a) });
    await until(() => answers.length > 0, "first answer");
    expect(answers.at(-1)).toEqual({ tags: undefined, watching: 0 });
    const channel = await browser.connect();
    fake.cli = { next: "0.14.0-next.11", latest: "0.13.1" };
    channel.watch("a");
    await until(() => answers.some((a) => a.tags?.next === "0.14.0-next.11" && a.watching === 1), "tags + watching 1");
    run.stop.abort();
    await run.done;
  }, LONG);

  it("키 이름 → 데몬 key(Ctrl-D 로 cat 이 끝남 → 목록에서 빠짐) · 크기 → set-size 와 frame 크기 · 화면 모드 표지 · 모르는 키는 채널을 닫는다(A6)", async () => {
    await ok("term", "new", "cat", "--", "cat");
    await ok("term", "new", "app", "--", "/bin/sh", "-c", "printf '\\033[?1h'; echo app-mode; sleep 600");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    channel.watch("app", "cat");
    const app = await frameWhere(channel, "app", (frame) => frame.modes?.appCursor === true, "app frame with modes");
    const cat = await frameWhere(channel, "cat", () => true, "cat frame");
    await channel.resize("app", app.instance, 100, 30);
    await frameWhere(channel, "app", (frame) => frame.cols === 100 && frame.rows === 30, "frame at the new size");
    expect((await sessions()).find((s) => s.name === "app")).toMatchObject({ cols: 100, rows: 30 });
    await channel.key("cat", cat.instance, "ctrl-d");
    await until(async () => !(await sessions()).some((s) => s.name === "cat"), "cat ended");
    await until(() => !fake.listedNames().includes("cat"), "cat gone from the list");
    await channel.key("app", app.instance, "no-such-key");
    await until(() => channel.closedReason() !== undefined, "unknown key closes the channel");
    expect(channel.closedReason()).toBe("COMMAND_FAILED");
    expect(remoteLog().some((r) => r.event === "remote_command_result" && r.code === "TERM_UNKNOWN_KEY")).toBe(true);
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("Ryan 11-25 색 싣기·스크롤 — 봉인 화면에 속성 표·줄마다 구간·커서 · modes.mouse · 웹 wheel-up 키 → 앱에 SGR 휠 보고", async () => {
    await ok("term", "new", "color", "--", "/bin/sh", "-c", "printf 'a \\033[2mhint\\033[0m'; sleep 600");
    const app = "import os,tty; tty.setraw(0); os.write(1, b'\\x1b[?1049h\\x1b[?1000h\\x1b[?1006hready\\r\\n');"
      + " got=b''\nwhile b'M' not in got: got += os.read(0, 64)\nos.write(1, repr(got).encode() + b'\\r\\n')\nimport time; time.sleep(600)";
    await ok("term", "new", "mouse", "--", "python3", "-c", app);
    await ok("term", "wait", "mouse", "--match", "ready", "--timeout", "10");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    channel.watch("color", "mouse");
    const color = await frameWhere(channel, "color", (frame) => frame.text.includes("hint"), "styled frame");
    const row = color.runs![lines(color.text).indexOf("a hint")]!;
    expect(row).toHaveLength(3);
    expect(lines(color.text).find((line) => line.includes("hint"))!.slice(row[0], row[1])).toBe("hint");
    expect(color.styles![row[2]!]).toEqual({ dim: true });
    expect(color.cursor).toEqual({ row: lines(color.text).indexOf("a hint"), col: 6 });
    expect(color.modes).toMatchObject({ mouse: false });
    const mouse = await frameWhere(channel, "mouse", (frame) => frame.modes?.mouse === true, "mouse frame");
    await channel.key("mouse", mouse.instance, "wheel-up");
    await frameWhere(channel, "mouse", (frame) => frame.text.includes("[<64;40;12M"), "app got the wheel report");
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("PC 설정 끔 → remoteEnabled=false·세션 0 으로 열고 hello 는 REMOTE_OFF 로 닫는다(이중 거절) · 다리는 계속", async () => {
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const run = start({ remoteEnabled: false });
    await until(() => fake.ops().includes("open"), "open");
    expect(fake.calls[0]?.body).toMatchObject({ remoteEnabled: false, sessions: [], e2e: 1 });
    expect(await browser.hello()).toMatchObject({ closed: "REMOTE_OFF" });
    expect(run.printed.join("\n")).toContain("Remote terminal: off on this PC");
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("웹 «원격 터미널 끊기»(remote=off-by-web) → 채널을 모두 REMOTE_OFF 로 닫음 · 화면 멈춤 · 안내 한 줄 · 링크는 남긴다(poll 계속)", async () => {
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    channel.watch("a");
    const frame = await frameWhere(channel, "a", () => true, "first frame");
    fake.webOff();
    await until(() => run.printed.some((line) => line.includes("turned off from the web")), "off notice");
    await until(() => channel.closedReason() !== undefined, "closed");
    expect(channel.closedReason()).toBe("REMOTE_OFF");
    const framesAtOff = fake.frames.length;
    await channel.input("a", frame.instance, "late\r");
    await sleep(1_500);
    expect(fake.frames.length).toBe(framesAtOff);
    expect((await screen("a")).includes("late")).toBe(false);
    const polls = fake.ops().filter((op) => op === "poll").length;
    await until(() => fake.ops().filter((op) => op === "poll").length > polls, "still polling");
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("웹이 채널을 닫으면(channel-closed) 화면을 멈추고 그 채널의 명령은 실행하지 않는다", async () => {
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    channel.watch("a");
    const frame = await frameWhere(channel, "a", () => true, "first frame");
    fake.webClose(channel.id);
    await until(() => remoteLog().some((r) => r.event === "remote_channel" && r.by === "web"), "closed by web");
    await channel.input("a", frame.instance, "after-close\r");
    await until(() => remoteLog().some((r) => r.event === "remote_command_skipped" && r.why === "unknown-channel"), "skipped");
    expect((await screen("a")).includes("after-close")).toBe(false);
    run.stop.abort();
    await run.done;
  }, LONG);

  it("같은 PC 의 다른 다리가 열면(CLOSED REPLACED) → 끝(0) · close 보내지 않음 · 다시 열지 않음", async () => {
    await ok("term", "new", "a", "--", "cat");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    fake.replace();
    const result = await run.done;
    expect(result.exitCode).toBe(0);
    expect(result.reason).toContain("REPLACED");
    expect(fake.ops()).not.toContain("close");
    expect(fake.ops().filter((op) => op === "open")).toHaveLength(1);
  }, LONG);

  /** 데몬 끝 기록 책(ended.json) — 없으면 빈 목록. */
  const endedBook = (): Array<Record<string, unknown>> => {
    const path = termPaths(rig.home).ended;
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { ended: Array<Record<string, unknown>> }).ended : [];
  };
  const instanceOf = async (name: string): Promise<string> =>
    ((await json("term", "ls")).data as { sessions: Array<{ name: string; instance: string }> }).sessions.find((s) => s.name === name)!.instance;
  const endedSent = (): Array<Record<string, unknown>> => fake.calls.flatMap((call) =>
    Array.isArray(call.body.ended) ? (call.body.ended as Array<Record<string, unknown>>).map((item) => ({ op: call.op, ...item })) : []);

  it("장부 끝 기록 — 스스로 끝남(exit 3)·웹 밖 kill 을 목록이 같아도 sessions 에 싣는다 · 5xx 면 책 그대로 다시 · 2xx 뒤 ended-ack 로 책이 빈다 · command 는 올리지 않는다", async () => {
    await ok("term", "new", "keep", "--", "cat");
    await ok("term", "new", "gone", "--", "cat");
    const run = start();
    try {
      await until(() => fake.ops().includes("open"), "open");
      const gone = await instanceOf("gone");
      fake.sessionsError = { status: 503, code: "UNAVAILABLE" };
      await ok("term", "new", "x", "--", "/bin/sh", "-c", "sleep 2; exit 3");
      // 끝 기록은 그 세션을 목록으로 받은 수신처의 것 — x 가 먼저 목록(503 이어도 보내기 전에 표시)에 오른 뒤 끝난다
      await until(() => fake.calls.some((call) => call.op === "sessions"
        && (call.body.sessions as Array<{ name: string }>).some((item) => item.name === "x")), "x listed");
      // instance 는 끝 기록 책에서 — ls 보다 먼저 끝날 수 있다
      await until(() => endedBook().some((r) => r.name === "x"), "x ended into the book");
      const x = endedBook().find((r) => r.name === "x")!.instance;
      await ok("term", "kill", "gone");
      await until(() => endedSent().filter((r) => r.instance === gone).length >= 2, "kept resending while the server answers 503");
      expect(endedBook().map((r) => r.instance).sort()).toEqual([gone, x].sort());   // 2xx 전에는 지우지 않는다
      fake.sessionsError = undefined;
      await until(() => endedBook().length === 0, "acked after 2xx");
      const sent = endedSent();
      expect(sent.find((r) => r.instance === x)).toEqual({ op: "sessions", instance: x, name: "x", kind: "user", endedAt: expect.any(String), reason: "exited", exitCode: 3 });
      expect(sent.find((r) => r.instance === gone)).toEqual({ op: "sessions", instance: gone, name: "gone", kind: "user", endedAt: expect.any(String), reason: "killed" });
      expect(sent.every((r) => !("command" in r))).toBe(true);
      // 다 받은 뒤에는 목록이 같으면 다시 보내지 않는다
      const calls = fake.calls.filter((call) => call.op === "sessions").length;
      await sleep(2500);
      expect(fake.calls.filter((call) => call.op === "sessions").length).toBe(calls);
      expect(remoteLog().some((r) => r.event === "remote_ended_acked" && (r.acked as number) >= 1)).toBe(true);
    } finally {
      // 단언이 실패해도 다리를 멈춘다 — 안 그러면 지운 HOME 에 다음 시험 내내 poll 을 남긴다
      run.stop.abort();
      await run.done;
    }
    expectLogPairs();
  }, LONG);

  /** 다리를 띄워 첫 open 이 끝날 때까지 — 멈추는 것은 부르는 쪽(finally). */
  async function opened(options: Parameters<typeof start>[0] = {}) {
    const before = fake.calls.filter((call) => call.op === "open").length;
    const run = start(options);
    await until(() => fake.calls.filter((call) => call.op === "open").length > before, "open");
    return run;
  }
  const stopped = async (run: ReturnType<typeof start>) => {
    run.stop.abort();
    await run.done;
  };

  it("장부 끝 기록 — 다리가 없던 사이 끝난 세션은 그 수신처의 다음 open 에 실린다(원격을 끈 채여도 · 목록은 안 싣는다) · 201 뒤 책이 빈다 · PC 연결 세션의 끝과 아무 서버도 못 본 세션의 끝은 올리지 않고 지운다", async () => {
    await ok("term", "new", "keep", "--", "cat");
    await pcBridgeSession();
    await ok("term", "new", "done", "--", "cat");
    const pc = await instanceOf("ainecto-pc");
    const done = await instanceOf("done");
    const first = await opened();   // 이 수신처가 done 을 목록으로 받는다
    await stopped(first);
    await ok("term", "kill", "done");
    await ok("term", "kill", "ainecto-pc");
    await ok("term", "new", "unseen", "--", "/bin/sh", "-c", "exit 0");   // 다리가 없을 때 생겼다 끝남 — 아무 서버도 못 봤다
    await until(() => endedBook().length === 3, "three ends in the book");
    expect(endedBook().find((r) => r.instance === done)?.to).toBe(accountKey(fake.endpoint, USER_ID));
    const calls = fake.calls.length;
    const run = await opened({ remoteEnabled: false });
    try {
      expect(fake.calls[calls]?.body).toMatchObject({ remoteEnabled: false, sessions: [],
        ended: [{ instance: done, name: "done", kind: "user", endedAt: expect.any(String), reason: "killed" }] });
      expect(endedSent().some((r) => r.instance === pc || r.name === "unseen")).toBe(false);
      await until(() => endedBook().length === 0, "all three gone after 201");
    } finally {
      await stopped(run);
    }
  }, LONG);

  it("리뷰 0.16.6 P0-2 — 끝 기록은 그 세션을 목록으로 받은 수신처에만: A 가 받은 세션이 A 를 닫은 뒤 끝나면, 다른 계정 B 의 open 에는 싣지도 ACK 하지도 않고 책에 남는다 · A 가 다시 열면 A 로 간다", async () => {
    await ok("term", "new", "keep", "--", "cat");
    await ok("term", "new", "project-a", "--", "/bin/sh", "-c", "sleep 600");
    const a = await instanceOf("project-a");
    await stopped(await opened());   // A = 기본 수신처
    await ok("term", "kill", "project-a");
    await until(() => endedBook().some((r) => r.instance === a), "ended into the book");
    const calls = fake.calls.length;
    const other = accountKey(fake.endpoint, "7c2d0f1e-0000-4000-8000-0000000000b2");
    const b = await opened({ remoteEnabled: false, destination: other });
    try {
      await sleep(1500);   // poll 몇 번 — B 가 아무것도 싣지 않는다
      expect(fake.calls.slice(calls).some((call) => Array.isArray(call.body.ended)), "B 에 끝 기록 0").toBe(false);
      expect(endedBook().map((r) => r.instance), "책에 남는다").toEqual([a]);
    } finally {
      await stopped(b);
    }
    const again = fake.calls.length;
    const back = await opened({ remoteEnabled: false });
    try {
      expect(fake.calls[again]?.body.ended).toEqual([expect.objectContaining({ instance: a, name: "project-a", reason: "killed" })]);
      await until(() => endedBook().length === 0, "A acked");
    } finally {
      await stopped(back);
    }
  }, LONG);

  it("리뷰 0.16.6 P1-1 — 끝 기록이 본문 상한을 넘으면 413 의 maxBytes 로 나눠 보낸다: 첫 open 은 들어가는 만큼 · 원격 켜짐이면 이어서 sessions 로 · 받은 묶음만 ACK · 모든 본문이 상한 안", async () => {
    await ok("term", "new", "keep", "--", "cat");
    const paths = termPaths(rig.home);
    const env = Object.fromEntries(Object.entries(rig.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    const names = Array.from({ length: 24 }, (_, i) => `bulk-${String(i).padStart(2, "0")}`);
    for (const name of names) await termRequest(paths, { op: "new", name, cwd: rig.home, command: ["cat"], env, kind: "user" }, { start: false });
    await stopped(await opened());   // 이 수신처가 24개를 목록으로 받는다
    for (const name of names) await termRequest(paths, { op: "kill", name }, { start: false });
    await until(() => endedBook().length === 24, "24 ends");
    fake.bodyMaxBytes = 2500;
    const calls = fake.calls.length;
    const run = await opened();
    try {
      await until(() => endedBook().length === 0, "all acked in pieces");
      const sent = fake.calls.slice(calls);
      const tooLarge = sent.filter((call) => Buffer.byteLength(call.raw, "utf8") > 2500);
      expect(tooLarge.map((call) => call.op), "상한을 넘은 것은 상한을 모르던 첫 open 하나").toEqual(["open"]);
      const carried = sent.filter((call) => Buffer.byteLength(call.raw, "utf8") <= 2500 && Array.isArray(call.body.ended));
      expect(carried.length, "여러 묶음").toBeGreaterThan(1);
      const instances = carried.flatMap((call) => (call.body.ended as Array<{ name: string }>).map((r) => r.name));
      expect([...new Set(instances)].sort()).toEqual(names);
      expect(remoteLog().some((r) => r.event === "remote_body_limit" && r.op === "open" && r.maxBytes === 2500)).toBe(true);
    } finally {
      await stopped(run);
    }
  }, LONG);

  it("U6 경우 1 — 바깥만 갈림(넘기기 0.16.7 → 0.16.8 · holder·PTY 그대로): 화면 루프는 지우지 않고 같은 채널·같은 uuid 로 다시 watch · 화면·입력이 이어진다", async () => {
    // 다리는 이 시험 프로세스 안에서 돈다 — 바깥은 진짜 CLI 로 띄우고 넘긴다(다리가 띄우면 vitest 를 띄운다).
    expect((await startOuterAt("0.16.7")).status).toBe("ready");
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    channel.watch("a");
    const first = await frameWhere(channel, "a", () => true, "first frame of a");
    const watching = () => remoteLog().filter((r) => r.event === "remote_watching").length;
    const before = watching();
    const holders = holderPids();
    const [oldOuter] = daemonPids();

    expect((await startOuterAt("0.16.8")).status).toBe("ready");
    await until(() => !daemonPids().includes(oldOuter as number), "old outer ended");
    await until(() => remoteLog().some((r) => r.event === "remote_viewer_reconnect" && r.channelId === channel.id && r.session === "a"), "viewer reconnects");
    expect(holderPids()).toEqual(holders);

    const marker = `AFTER-${randomUUID()}`;
    await channel.input("a", first.instance, `${marker}\r`);
    const shown = await frameWhere(channel, "a", (frame) => lines(frame.text).includes(marker), "a shows the marker after the handover");
    expect(shown.instance).toBe(first.instance);
    expect(channel.closedReason()).toBeUndefined();
    // ★화면 루프가 지워졌다가 poll 의 보기 목록으로 다시 만들어지지 않았다(그러면 remote_watching 이 다시 찍힌다).
    expect(watching()).toBe(before);
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("U6 규칙 2 — 답하는 데몬이 없으면(바깥·holder 둘 다 끝) «세션 0개»를 올리지 않는다 · 직전 목록 그대로", async () => {
    await ok("term", "new", "a", "--", "cat");
    const run = start();
    await until(() => fake.listedNames().includes("a"), "a listed");
    const uploads = () => fake.calls.filter((call) => call.op === "sessions" || call.op === "open");
    for (const pid of [...daemonPids(), ...holderPids()]) process.kill(pid, "SIGKILL");
    await until(() => daemonPids().length + holderPids().length === 0, "daemons gone");
    const polls = fake.ops().filter((op) => op === "poll").length;
    // poll 이 돌아올 때마다 목록을 견준다(붙잡기 1초) — 세 번 견줄 동안.
    await until(() => fake.ops().filter((op) => op === "poll").length >= polls + 3, "three more polls");
    expect(uploads().filter((call) => Array.isArray(call.body.sessions) && call.body.sessions.length === 0)).toEqual([]);
    expect(fake.listedNames()).toEqual(["a"]);
    run.stop.abort();
    await run.done;
  }, LONG);

  it("U6 규칙 3 — 웹 만들기의 결과를 모르면(데몬이 답하기 전에 끊음) 거절로 답하지 않는다 · 실행 확인 지점 그대로 · 채널을 닫는다 · 세션 폴더를 지우지 않는다", async () => {
    await ok("term", "new", "base", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const channel = await browser.connect();
    // 공용 주소를 «요청을 읽고 답 없이 끊는» 상대로 바꾼다 — 보낸 요청의 결과를 모른다(TERM_DAEMON_GONE).
    const paths = termPaths(rig.home);
    const real = readlinkSync(paths.socket);
    const silent = createServer((socket) => socket.once("data", () => socket.destroy()));
    await new Promise<void>((resolve) => silent.listen(join(paths.dir, "silent.sock"), resolve));
    const point = (target: string): void => {
      symlinkSync(target, `${paths.socket}.t`);
      renameSync(`${paths.socket}.t`, paths.socket);
    };
    point("silent.sock");
    try {
      const made = await channel.create({ name: "made" });
      await until(() => channel.closedReason() !== undefined, "channel closed");
      expect(channel.closedReason()).toBe("COMMAND_FAILED");
      expect(await channel.answer(made)).toBeUndefined();
      const results = remoteLog().filter((r) => r.event === "remote_command_result" && r.type === "create");
      expect(results).toEqual([expect.objectContaining({ ok: false, code: "TERM_DAEMON_GONE" })]);
      expect(results[0]).not.toHaveProperty("executedThrough");
      expect(existsSync(join(rig.home, "app", "sessions", made.opId))).toBe(true);
    } finally {
      point(real);
      await new Promise((resolve) => silent.close(resolve));
    }
    run.stop.abort();
    await run.done;
  }, LONG);

  it("PC 연결 세션 이름 — 웹이 그 이름으로 만들지 못한다(PC 연결이 못 뜨게 되므로) · 이름만 같은 사용자 셸(옛 줄·pc run 아님)은 목록에 오르고 입력도 간다", async () => {
    const browser = await web();
    await ok("term", "new", "base", "--", "cat");
    const run = start();
    try {
      await until(() => fake.ops().includes("open"), "open");
      const channel = await browser.connect();
      const taken = await channel.create({ name: "ainecto-pc" });
      await until(async () => (await channel.answer(taken)) !== undefined, "answer");
      expect((await channel.answer(taken))?.outer).toMatchObject({ ok: false, code: "TERM_NO_SESSION" });
      expect((await sessions()).some((s) => s.name === "ainecto-pc")).toBe(false);
      await ok("term", "new", "ainecto-pc", "--", "cat");
      await until(() => fake.listedNames().includes("ainecto-pc"), "a user shell named ainecto-pc is listed");
      channel.watch("ainecto-pc");
      const frame = await frameWhere(channel, "ainecto-pc", () => true, "frame");
      await channel.input("ainecto-pc", frame.instance, "typed-into-it\r");
      await frameWhere(channel, "ainecto-pc", (f) => lines(f.text).includes("typed-into-it"), "input reached it");
    } finally {
      run.stop.abort();
      await run.done;
    }
  }, LONG);

  it("api 재시작(poll 404 REMOTE_NOT_FOUND) → 같은 PC 로 다시 open(목록 포함) · 옛 채널은 버린다(새 hello 로만) · 새 채널 화면이 새 링크로", async () => {
    await ok("term", "new", "a", "--", "cat");
    const browser = await web();
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const old = await browser.connect();
    old.watch("a");
    const frame = await frameWhere(old, "a", () => true, "first frame");
    const first = fake.linkId;
    fake.restart();
    await until(() => fake.ops().filter((op) => op === "open").length === 2, "reopened");
    expect(fake.linkId).not.toBe(first);
    expect(fake.listedNames()).toEqual(["a"]);
    await old.input("a", frame.instance, "on-the-old-channel\r");
    await until(() => remoteLog().some((r) => r.event === "remote_command_skipped" && r.why === "unknown-channel"), "old channel ignored");
    const channel = await browser.connect();
    channel.watch("a");
    const now = await frameWhere(channel, "a", () => true, "new channel frame");
    await channel.input("a", now.instance, "after\r");
    await frameWhere(channel, "a", (f) => lines(f.text).includes("after"), "frame on the new link");
    expect(fake.frames.filter((f) => f.channelId === channel.id).every((f) => f.linkId === fake.linkId)).toBe(true);
    expect(remoteLog().filter((r) => r.event === "remote_reopened")).toEqual([
      expect.objectContaining({ reason: "REMOTE_NOT_FOUND", previousLinkId: first, linkId: fake.linkId, channelsDropped: 1 })]);
    expect((await screen("a")).includes("on-the-old-channel")).toBe(false);
    run.stop.abort();
    await run.done;
    expectLogPairs();
  }, LONG);

  it("새 CLI 가 아직 옛 서버를 만나면(open 400 INVALID) — 능력 표시(images) 없이 한 번 더 · 그래도 거절이면 «서버가 아직 새 판이 아님» 사유로 끝(1)", async () => {
    fake.openError = { status: 400, code: "INVALID" };
    const run = start();
    const result = await run.done;
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("not on the new version yet");
    expect(fake.ops()).toEqual(["open", "open"]);
    expect(fake.calls[1]?.body).not.toHaveProperty("images");
  }, LONG);

  it("새 CLI(devices:true)가 직전 서버(devices 는 알고 images 만 모름)를 만나면 — images 만 빼고 한 번 더 · devices 는 그대로(기기 관리 유지)", async () => {
    await ok("term", "new", "a", "--", "cat");
    fake.refuseFields = ["images"];
    const run = start({ pairRelay: () => { throw new Error("no pair relay in this test"); } });
    await until(() => fake.ops().filter((op) => op === "open").length === 2 && fake.ops().includes("poll"), "second open and poll");
    const opens = fake.calls.filter((call) => call.op === "open").map((call) => call.body as Record<string, unknown>);
    expect(opens).toHaveLength(2);
    expect(opens[0]).toMatchObject({ devices: true, images: true });
    expect(opens[1]).toMatchObject({ devices: true });
    expect(opens[1]).not.toHaveProperty("images");
    expect(remoteLog().filter((r) => r.event === "remote_open_without_devices").map((r) => r.reason))
      .toEqual(["server refused the images field"]);
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("새 CLI(devices:true)가 그 전 서버(devices·images 둘 다 모름)를 만나면 — images 빼고 · 그래도 거절이면 devices 도 빼고 · 기존 터미널은 열린다", async () => {
    await ok("term", "new", "a", "--", "cat");
    fake.refuseFields = ["devices", "images"];
    const run = start({ pairRelay: () => { throw new Error("no pair relay in this test"); } });
    await until(() => fake.ops().filter((op) => op === "open").length === 3 && fake.ops().includes("poll"), "third open and poll");
    const opens = fake.calls.filter((call) => call.op === "open").map((call) => call.body as Record<string, unknown>);
    expect(opens).toHaveLength(3);
    expect(opens[0]).toMatchObject({ devices: true, images: true });
    expect(opens[1]).toMatchObject({ devices: true });
    expect(opens[1]).not.toHaveProperty("images");
    expect(opens[2]).not.toHaveProperty("devices");
    expect(opens[2]).not.toHaveProperty("images");
    expect(remoteLog().filter((r) => r.event === "remote_open_without_devices").map((r) => r.reason))
      .toEqual(["server refused the images field", "server refused the devices field"]);
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("이미지 붙여넣기 표시(계약 §2) — 기기 관리가 없어도 open 에 images:true · 옛 서버(400 INVALID)면 images 를 빼고 한 번 더", async () => {
    fake.refuseFields = ["images"];
    const run = start({ trust: false });
    await until(() => fake.ops().filter((op) => op === "open").length === 2 && fake.ops().includes("poll"), "second open and poll");
    const opens = fake.calls.filter((call) => call.op === "open").map((call) => call.body as Record<string, unknown>);
    expect(opens[0]).toMatchObject({ images: true });
    expect(opens[0]).not.toHaveProperty("devices");
    expect(opens[1]).not.toHaveProperty("images");
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  describe("이미지 붙여넣기(계약 §1·§4) — 봉인 image → PC 에 저장 → 봉인 답 result.path", () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
    const images = (): string => termPaths(rig.home).images;

    async function sent(channel: WebChannel, crud: Crud): Promise<{ outer: Record<string, unknown>; sealed: Record<string, unknown> }> {
      await until(async () => (await channel.answer(crud)) !== undefined, "image answer");
      return (await channel.answer(crud))!;
    }

    it("저장 성공 — <opId>.png 0600 · 답 {kind:image, session, ok, result.path} · 로그는 bytes·mime 만(경로 없음) · 다리 시작 때 24시간 지난 파일 정리", async () => {
      mkdirSync(images(), { recursive: true, mode: 0o700 });
      const stalePath = join(images(), `${randomUUID()}.png`);
      writeFileSync(stalePath, PNG);
      const stale = new Date(Date.now() - IMAGE_KEEP_MS - 60_000);
      utimesSync(stalePath, stale, stale);
      await ok("term", "new", "a", "--", "cat");
      const browser = await web();
      const run = start();
      await until(() => fake.ops().includes("open"), "open");
      expect(existsSync(stalePath)).toBe(false);
      expect(remoteLog()).toContainEqual(expect.objectContaining({ event: "remote_images_pruned", removed: 1, failed: 0 }));
      const channel = await browser.connect();
      channel.watch("a");
      const { instance } = await frameWhere(channel, "a", () => true, "frame of a");
      const crud = await channel.image("a", instance, "image/png", PNG);
      const answered = await sent(channel, crud);
      const path = join(images(), `${crud.opId}.png`);
      expect(answered.outer).toMatchObject({ ok: true });
      expect(answered.sealed).toEqual({ opId: crud.opId, kind: "image", session: "a", ok: true, result: { path } });
      expect(readFileSync(path)).toEqual(PNG);
      if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(remoteLog()).toContainEqual(expect.objectContaining({ event: "remote_command", type: "image", session: "a", opId: crud.opId,
        bytes: PNG.length, mime: "image/png" }));
      expect(remoteLog()).toContainEqual(expect.objectContaining({ event: "remote_command_result", type: "image", ok: true }));
      expect(readFileSync(termPaths(rig.home).remoteLog, "utf8")).not.toContain(path);
      run.stop.abort();
      await run.done;
      expectLogPairs();
    }, LONG);

    it.skipIf(process.platform === "win32")("다리 시작 때 정리도 저장과 같은 폴더 검사 — images 가 링크면 정리하지 않는다(링크 너머 파일 그대로 · 한 줄 남기고 다리는 연다)", async () => {
      const target = join(rig.home, "elsewhere");
      mkdirSync(target, { recursive: true });
      const victim = join(target, `${randomUUID()}.png`);
      writeFileSync(victim, PNG);
      const stale = new Date(Date.now() - IMAGE_KEEP_MS - 60_000);
      utimesSync(victim, stale, stale);
      mkdirSync(termPaths(rig.home).dir, { recursive: true, mode: 0o700 });
      symlinkSync(target, images());
      const run = start();
      await until(() => fake.ops().includes("poll"), "poll");
      expect(existsSync(victim)).toBe(true);
      expect(remoteLog()).toContainEqual(expect.objectContaining({ event: "remote_images_pruned", when: "start", removed: 0, failed: 1 }));
      run.stop.abort();
      expect((await run.done).exitCode).toBe(0);
    }, LONG);

    it("거절 답 — magic 틀림 TERM_BAD_REQUEST · 모르는 세션·instance 불일치·PC 연결 세션 TERM_NO_SESSION · 파일 없음 · 채널은 계속", async () => {
      await ok("term", "new", "a", "--", "cat");
      await pcBridgeSession();   // PC 연결 세션(종류 pc-bridge — 0.16.8 합본: holder 는 종류 없는 PC 연결을 거절)
      const browser = await web();
      const run = start();
      await until(() => fake.ops().includes("open"), "open");
      const channel = await browser.connect();
      channel.watch("a");
      const { instance } = await frameWhere(channel, "a", () => true, "frame of a");
      const cases: Array<[Crud, string]> = [
        [await channel.image("a", instance, "image/jpeg", PNG), "TERM_BAD_REQUEST"],
        [await channel.image("nope", instance, "image/png", PNG), "TERM_NO_SESSION"],
        [await channel.image("a", randomUUID(), "image/png", PNG), "TERM_NO_SESSION"],
        [await channel.image("ainecto-pc", instance, "image/png", PNG), "TERM_NO_SESSION"],
      ];
      for (const [crud, code] of cases) {
        const answered = await sent(channel, crud);
        expect(answered.outer).toMatchObject({ ok: false, code });
        expect(answered.sealed).toMatchObject({ opId: crud.opId, kind: "image", ok: false, result: {} });
        expect(String(answered.sealed.detail)).toMatch(new RegExp(`^${code}: `));
      }
      expect(existsSync(images()) ? readdirSync(images()) : []).toEqual([]);
      expect(channel.closedReason()).toBeUndefined();
      run.stop.abort();
      await run.done;
      expectLogPairs();
    }, LONG);

    it("방금 끝난 세션 — 다리의 마지막 목록에 남아 있어도 저장 직전 데몬에 다시 물어 TERM_NO_SESSION(파일 없음)", async () => {
      await ok("term", "new", "a", "--", "cat");
      const browser = await web();
      const run = start();
      await until(() => fake.ops().includes("poll"), "poll");
      const channel = await browser.connect();
      channel.watch("a");
      const { instance } = await frameWhere(channel, "a", () => true, "frame of a");
      // 목록 올리기를 붙잡는다 — 그 뒤 목록 알림은 줄을 서서 다리의 마지막 목록이 «a 있음» 그대로 남는다
      fake.hangSessions = 1;
      const before = fake.ops().filter((op) => op === "sessions").length;
      await ok("term", "new", "b", "--", "cat");
      await until(() => fake.ops().filter((op) => op === "sessions").length > before, "held sessions upload");
      await ok("term", "kill", "a");
      const crud = await channel.image("a", instance, "image/png", PNG);
      const answered = await sent(channel, crud);
      expect(answered.outer).toMatchObject({ ok: false, code: "TERM_NO_SESSION" });
      expect(existsSync(images()) ? readdirSync(images()) : []).toEqual([]);
      run.stop.abort();
      await run.done;
    }, LONG);

    it("원격 꺼짐(웹 끊기) — 채널이 REMOTE_OFF 로 닫혀 그 뒤 image 는 실행하지 않는다(파일 없음)", async () => {
      await ok("term", "new", "a", "--", "cat");
      const browser = await web();
      const run = start();
      await until(() => fake.ops().includes("open"), "open");
      const channel = await browser.connect();
      channel.watch("a");
      const { instance } = await frameWhere(channel, "a", () => true, "frame of a");
      fake.webOff();
      await until(() => channel.closedReason() === "REMOTE_OFF", "channel closed by remote off");
      await channel.image("a", instance, "image/png", PNG);
      await until(() => remoteLog().some((r) => r.event === "remote_command_skipped" && r.why === "unknown-channel"), "image skipped");
      expect(existsSync(images()) ? readdirSync(images()) : []).toEqual([]);
      run.stop.abort();
      await run.done;
    }, LONG);
  });

  it("poll 기한 초과 → 기한 줄 남기고 같은 링크로 다시 poll · poll 401(로그인 거절) → 끝(1)", async () => {
    await ok("term", "new", "a", "--", "cat");
    fake.hangPolls = 1;
    const run = start();
    const deadline = Date.now() + 1_000 + CALL_TIMEOUT_MS + RETRY_MIN_MS * 2 + 5_000;
    while (fake.ops().filter((op) => op === "poll").length < 2) {
      if (Date.now() > deadline) throw new Error("no second poll");
      await sleep(100);
    }
    expect(remoteLog().some((r) => r.event === "remote_call_response" && r.op === "poll" && r.error === "TimeoutError")).toBe(true);
    fake.pollError = { status: 401, code: "UNAUTHORIZED" };
    const result = await run.done;
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("401");
    expect(fake.ops().filter((op) => op === "open")).toHaveLength(1);
  }, LONG);

  /** device 명령 하나를 보내고 봉인 답의 본문을 기다린다. */
  async function ask(channel: WebChannel, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const crud = await channel.device(body);
    await until(async () => (await channel.answer(crud)) !== undefined, `device ${String(body.action)} answer`);
    const answered = await channel.answer(crud);
    expect(answered?.sealed).toMatchObject({ opId: crud.opId, kind: "device", ok: true });
    return answered!.sealed.result as Record<string, unknown>;
  }

  it("새 기기 허용(approve-new-device) — pair-request → B1 이 물어 같은 숫자 → B1 허용 + 새 기기 [같아요] 서명 → 핀 · 목록 · 지우기는 그 키 채널만 닫고 그 키의 hello 는 거절", async () => {
    await ok("term", "new", "a", "--", "cat");
    const b1 = await web({ name: "Chrome · macOS" });
    // 새 기기 N — 진짜 암호. 중계는 기억 안 대역(서버 pair 중계는 api 시험이 본다).
    const nKey = await generateSigningJwk();
    const nPub = publicRawFromJwk(nKey);
    const nB = randomBytes(32);
    const device: { commit?: Uint8Array; transcript?: Uint8Array; pcPub?: Uint8Array; clicked: boolean; doneVerified: boolean; aborts: string[] } = {
      clicked: false, doneVerified: false, aborts: [],
    };
    const relay: RequestRelay = {
      async refuse(reason) {
        device.aborts.push(`refused:${reason}`);
      },
      async offer(commit) {
        device.commit = commit;
        return { keyId: await browserKeyIdOf(nPub), publicRaw: nPub, nB, name: "Safari · iPhone", attemptId: "attempt-1" };
      },
      async reveal(pcPub, nP) {
        await assertCommitment(device.commit!, pcPub, nP);
        device.pcPub = pcPub;
        device.transcript = await pairTranscript({ userId: USER_ID, pcId: PC_ID, pcPublicRaw: pcPub, browserPublicRaw: nPub, nP, nB });
      },
      async deviceConsent() {
        await until(() => device.clicked, "device click");
        return await signBytes(await importSigningKey(nKey), pairApproveInput(device.transcript!));
      },
      async done(signature) {
        device.doneVerified = await verifyBytes(publicJwkFromRaw(device.pcPub!), signature, pairDoneInput(device.transcript!));
      },
      async abort(reason) {
        device.aborts.push(reason);
      },
    };
    const run = start({ pairRelay: () => relay });
    await until(() => fake.ops().includes("open"), "open");
    expect(fake.calls.find((call) => call.op === "open")?.body).toMatchObject({ devices: true });
    const channel = await b1.connect();
    expect(await ask(channel, { action: "pending" })).toEqual({ request: null });

    fake.push({ type: "pair-request", requestId: randomUUID() });
    let request: Record<string, unknown> | null = null;
    await until(async () => {
      request = (await ask(channel, { action: "pending" })).request as Record<string, unknown> | null;
      return request !== null;
    }, "pending request");
    const shown = request as unknown as { T: string; code: string; name: string };
    expect(shown.name).toBe("Safari · iPhone");
    expect(shown.code).toBe((await pairCodes(device.transcript!)).a);
    expect(await ask(channel, { action: "approve", T: shown.T, accept: true })).toEqual({ result: "recorded" });
    await sleep(200);
    const nKeyId = await browserKeyIdOf(nPub);
    // 새 기기가 [같아요]를 누르기 전엔 핀 0
    expect((await loadPcKeys(keysPath())).accounts[accountKey(fake.endpoint, USER_ID)]?.browsers.map((b) => b.keyId)).not.toContain(nKeyId);
    device.clicked = true;
    await until(() => device.doneVerified, "device got done");
    expect((await loadPcKeys(keysPath())).accounts[accountKey(fake.endpoint, USER_ID)]?.browsers.map((b) => b.keyId)).toContain(nKeyId);
    expect(device.aborts).toEqual([]);

    const listed = (await ask(channel, { action: "list" })).devices as Array<{ keyId: string; current: boolean }>;
    expect(listed.map((d) => d.keyId).sort()).toEqual([b1.browser.keyId, nKeyId].sort());
    expect(listed.find((d) => d.keyId === b1.browser.keyId)?.current).toBe(true);

    // 지우기 — 다른 브라우저 b2 의 채널만 닫히고 B1 은 계속 · b2 의 다음 hello 는 거절
    const b2 = await web({ name: "Firefox · Linux" });
    const other = await b2.connect();
    expect(await ask(channel, { action: "remove", keyId: b2.browser.keyId })).toEqual({ removed: true });
    await until(() => other.closedReason() === "PAIRING_REQUIRED", "b2 channel closed");
    expect(channel.closedReason()).toBeUndefined();
    expect(((await ask(channel, { action: "list" })).devices as Array<{ keyId: string }>).map((d) => d.keyId)).not.toContain(b2.browser.keyId);
    const again = await b2.hello();
    expect(again).toMatchObject({ refused: "PAIRING_REQUIRED" });
    run.stop.abort();
    await run.done;
    expectLogPairs();
  }, LONG);

  it("CLI — term remote 는 이제 PC 연결 안내(MOVED, 종료 1)", async () => {
    const run = await cli("term", "remote", "x");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("ainecto remote on");
    expect(await ok("--help")).not.toContain("ainecto term remote");
    expect((await termRequest(termPaths(rig.home), { op: "ls" }, { start: false })).daemon).toBe(false);
  }, LONG);
});

function base64Size(text: string): number {
  return 4 * Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}

function cursorSize(): number {
  return JSON.stringify({ cursor: { row: 2 ** 32 - 1, col: 2 ** 32 - 1 } }).length;
}
