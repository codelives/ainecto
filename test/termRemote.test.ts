import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { termRequest } from "../src/core/term/client";
import { termPaths } from "../src/core/term/paths";
import { createRemoteHttp, openRemoteLog, remoteCommands, remoteStateOf, runRemoteBridge, watchingOf, type BridgeDeps, type RemoteResult } from "../src/core/term/remote";
import { screenFrame } from "../src/core/term/remoteFrame";
import { CALL_TIMEOUT_MS, RETRY_MAX_MS, RETRY_MIN_MS, retryWait } from "../src/core/term/remoteLimits";
import { wireSessions } from "../src/core/term/remoteSessions";
import { RemoteViewer } from "../src/core/term/remoteViewer";
import { FakeRemoteServer } from "./support/fakeRemoteServer";
import { cli, LONG, ok, rig, screen, sessions, sleep, until, useTermRig } from "./termRig";

const PROJECT = "0b9a8c7d-1111-4222-8333-444455556666";

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

  it("poll 명령 — 서버 순서 그대로 · 세션 이름으로 · 모르는 것·모양 틀림은 뺀다", () => {
    expect(remoteCommands({ commands: [
      { type: "create", requestId: "r1", name: "new", command: "npm test" },
      { type: "resize", session: "a", cols: 120, rows: 40 },
      { type: "input", session: "a", d: "aGk=" },
      { type: "key", session: "a", key: "up" },
      { type: "kill", requestId: "r2", session: "b" },
      { type: "label", requestId: "r3", session: "a", label: "백엔드" },
      { type: "later", x: 1 },
      { type: "input", d: "eA==" },
      { type: "resize", session: "a", cols: 0, rows: 40 },
      { type: "create", name: "no-request" },
      // 꼬리표 모양은 해석에서 버리지 않는다 — 만들기가 거절로 답한다.
      { type: "create", requestId: "r4", name: "tagged", projectUuid: "NOT-A-UUID", cwd: "/tmp" },
    ] })).toEqual([
      { type: "create", requestId: "r1", name: "new", command: "npm test" },
      { type: "resize", session: "a", cols: 120, rows: 40 },
      { type: "input", session: "a", d: "aGk=" },
      { type: "key", session: "a", key: "up" },
      { type: "kill", requestId: "r2", session: "b" },
      { type: "label", requestId: "r3", session: "a", label: "백엔드" },
      { type: "create", requestId: "r4", name: "tagged", projectUuid: "NOT-A-UUID", cwd: "/tmp" },
    ]);
    expect(remoteCommands({ state: "OPEN" })).toEqual([]);
    expect(watchingOf({ watching: ["a", 3, ""] })).toEqual(["a"]);
    expect(remoteStateOf("off-by-web")).toBe("off-by-web");
    expect(remoteStateOf("later")).toBeUndefined();
  });

  it("올릴 목록 — 다리 자기 세션은 뺀다 · label·project·lastOutputAt 은 있을 때만", () => {
    expect(wireSessions([
      { name: "ainecto-pc", pid: 1, clients: 0, cols: 80, rows: 24, cwd: "/", command: null },
      { name: "api", pid: 2, clients: 0, cols: 100, rows: 30, cwd: "/", command: null, label: "백엔드", project: PROJECT,
        lastOutputAt: "2026-11-17T00:00:00Z" },
      { name: "web", pid: 3, clients: 1, cols: 80, rows: 24, cwd: "/", command: ["npm", "start"] },
    ], ["ainecto-pc"])).toEqual([
      { name: "api", label: "백엔드", project: PROJECT, cols: 100, rows: 30, lastOutputAt: "2026-11-17T00:00:00Z" },
      { name: "web", cols: 80, rows: 24 },
    ]);
  });

  it("다시 하기 간격 — C12 에서 두 배씩 C13 까지 · 흔들림 0~C12", () => {
    expect(retryWait(0, 0)).toBe(RETRY_MIN_MS);
    expect(retryWait(1, 0)).toBe(RETRY_MIN_MS * 2);
    expect(retryWait(30, 0)).toBe(RETRY_MAX_MS);
    expect(retryWait(30, 0.999)).toBeLessThan(RETRY_MAX_MS + RETRY_MIN_MS);
  });
});

describe("원격 다리 — 실 데몬 + 서버 대역(여러 세션)", () => {
  useTermRig();
  let fake: FakeRemoteServer;
  beforeEach(async () => {
    fake = new FakeRemoteServer();
    await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const PC_ID = "6f2c1d3e-0000-4000-8000-000000000001";

  function start(options: { remoteEnabled?: boolean; exclude?: string[]; onAnswer?: BridgeDeps["onAnswer"] } = {}): { done: Promise<RemoteResult>; stop: AbortController; printed: string[] } {
    const paths = termPaths(rig.home);
    const log = openRemoteLog(paths);
    const printed: string[] = [];
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
      exclude: options.exclude ?? ["ainecto-pc"],
      sessionEnv: Object.fromEntries(Object.entries(rig.env).filter((e): e is [string, string] => typeof e[1] === "string")),
      appHome: join(rig.home, "app"),
      signal: stop.signal,
      print: (line) => printed.push(line),
      ...(options.onAnswer ? { onAnswer: options.onAnswer } : {}),
    });
    return { done, stop, printed };
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

  it("열 때 세션 전부(자기 pc 세션 뺌) · 보는 세션만 화면 · 전환 · 세션별 입력 · 멈춤 → close", async () => {
    await ok("term", "new", "a", "--", "cat");
    await ok("term", "new", "b", "--", "cat");
    await ok("term", "new", "ainecto-pc", "--", "/bin/sh", "-c", "sleep 600");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    expect(fake.calls[0]?.body).toMatchObject({ pcId: PC_ID, hostName: "test-host", cliVersion: "dev", remoteEnabled: true });
    expect(fake.listedNames().sort()).toEqual(["a", "b"]);
    await sleep(500);
    expect(fake.frames).toEqual([]);

    fake.watch("a");
    fake.input("a", "hi-a\r");
    await until(() => fake.frames.some((f) => f.session === "a" && f.text.split("\r\n").includes("hi-a")), "a shows hi-a");
    expect(fake.frames.every((f) => f.session === "a")).toBe(true);

    fake.watch("b");
    fake.input("b", "hi-b\r");
    await until(() => fake.frames.some((f) => f.session === "b" && f.text.split("\r\n").includes("hi-b")), "b shows hi-b");
    expect((await screen("a")).includes("hi-b")).toBe(false);

    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
    expect(fake.ops().at(-1)).toBe("close");
    expect(fake.calls.slice(1).every((call) => call.token === fake.linkToken)).toBe(true);
    expectLogPairs();
    const text = readFileSync(termPaths(rig.home).remoteLog, "utf8");
    expect(text).not.toContain(fake.linkToken);
    expect(text).not.toContain(Buffer.from("hi-a\r").toString("base64"));
  }, LONG);

  it("웹 만들기(명령 줄·폴더 없으면 <앱 홈>/sessions/<requestId> 를 만들어 그 안에서) → 데몬에 생김·answer ok·목록에 · 준 폴더는 그대로 · 같은 이름이면 데몬 코드로 실패", async () => {
    await ok("term", "new", "base", "--", "cat");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const id = fake.create("made", { command: "echo made-$((1+2)); pwd; sleep 600" });
    await until(() => fake.answerFor(id) !== undefined, "answer");
    expect(fake.answerFor(id)).toMatchObject({ ok: true });
    await until(() => fake.listedNames().includes("made"), "made listed");
    const folder = join(rig.home, "app", "sessions", id);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const made = (await sessions()).find((s) => s.name === "made");
    expect(made?.cwd).toBe(folder);
    await ok("term", "wait", "made", "--match", "made-3", "--timeout", "10");
    // 긴 경로는 화면 폭에서 줄이 갈린다 — 이어 붙여 본다.
    await until(async () => (await screen("made")).join("").includes(`/sessions/${id}`), "pwd is the session folder");

    const given = fake.create("given", { cwd: rig.home });
    await until(() => fake.answerFor(given) !== undefined, "given answer");
    expect(fake.answerFor(given)).toMatchObject({ ok: true });
    await until(async () => (await sessions()).some((s) => s.name === "given"), "given listed");
    expect((await sessions()).find((s) => s.name === "given")?.cwd).toBe(rig.home);
    expect(existsSync(join(rig.home, "app", "sessions", given))).toBe(false);

    const dup = fake.create("made");
    await until(() => fake.answerFor(dup) !== undefined, "dup answer");
    expect(fake.answerFor(dup)).toMatchObject({ ok: false, code: "TERM_SESSION_EXISTS" });
    // 거절된 만들기 — 방금 만든 빈 세션 폴더는 지운다(받은 폴더는 건드리지 않는다).
    expect(existsSync(join(rig.home, "app", "sessions", dup))).toBe(false);
    expect(existsSync(join(rig.home, "app", "sessions", id))).toBe(true);
    run.stop.abort();
    await run.done;
    expectLogPairs();
  }, LONG);

  it("웹 만들기 프로젝트 꼬리표 — 폴더 <앱 홈>/projects/<uuid>/sessions/<requestId> · ls·목록에 project · 잘못된 꼬리표는 폴더를 줘도 거절 · 거절되면 이번 빈 폴더만 정리", async () => {
    await ok("term", "new", "base", "--", "cat");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const id = fake.create("tagged", { projectUuid: PROJECT, command: "sleep 600" });
    await until(() => fake.answerFor(id) !== undefined, "answer");
    expect(fake.answerFor(id)).toMatchObject({ ok: true });
    const folder = join(rig.home, "app", "projects", PROJECT, "sessions", id);
    expect(statSync(folder).isDirectory()).toBe(true);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const tagged = (await sessions()).find((s) => s.name === "tagged");
    expect(tagged).toMatchObject({ cwd: folder, project: PROJECT });
    await until(() => fake.listed.some((s) => s.name === "tagged" && s.project === PROJECT), "project listed");

    const plain = fake.create("plain", { command: "sleep 600" });
    await until(() => fake.answerFor(plain) !== undefined, "plain answer");
    expect((await sessions()).find((s) => s.name === "plain")).not.toHaveProperty("project");
    expect(existsSync(join(rig.home, "app", "sessions", plain))).toBe(true);

    const badGiven = fake.create("bad-given", { projectUuid: "../x", cwd: rig.home });
    const badFresh = fake.create("bad-fresh", { projectUuid: PROJECT.toUpperCase() });
    await until(() => fake.answerFor(badGiven) !== undefined && fake.answerFor(badFresh) !== undefined, "bad answers");
    expect(fake.answerFor(badGiven)).toMatchObject({ ok: false, code: "TERM_BAD_REQUEST" });
    expect(fake.answerFor(badFresh)).toMatchObject({ ok: false, code: "TERM_BAD_REQUEST" });
    expect((await sessions()).map((s) => s.name).sort()).toEqual(["base", "plain", "tagged"]);
    // 대문자 폴더는 생기지 않는다(macOS 는 대소문자를 가리지 않으니 이름 목록으로 본다).
    expect(readdirSync(join(rig.home, "app", "projects"))).toEqual([PROJECT]);
    expect(readdirSync(join(rig.home, "app", "projects", PROJECT, "sessions"))).toEqual([id]);

    const dup = fake.create("tagged", { projectUuid: PROJECT });
    await until(() => fake.answerFor(dup) !== undefined, "dup answer");
    expect(fake.answerFor(dup)).toMatchObject({ ok: false, code: "TERM_SESSION_EXISTS" });
    expect(existsSync(join(rig.home, "app", "projects", PROJECT, "sessions", dup))).toBe(false);
    expect(existsSync(folder)).toBe(true);
    run.stop.abort();
    await run.done;
    expect(remoteLog().filter((r) => r.event === "remote_create_project_dropped")).toEqual([]);
    expectLogPairs();
  }, LONG);

  it("웹 끝내기·이름 바꾸기 → 데몬 · answer · 목록이 따라간다(label 칸)", async () => {
    await ok("term", "new", "a", "--", "cat");
    await ok("term", "new", "b", "--", "cat");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    const renamed = fake.label("a", "백엔드 서버");
    await until(() => fake.answerFor(renamed) !== undefined, "label answer");
    expect(fake.answerFor(renamed)).toMatchObject({ ok: true });
    await until(() => fake.listed.some((s) => s.name === "a" && s.label === "백엔드 서버"), "label listed");
    const killed = fake.kill("b");
    await until(() => fake.answerFor(killed) !== undefined, "kill answer");
    expect(fake.answerFor(killed)).toMatchObject({ ok: true });
    await until(() => !fake.listedNames().includes("b"), "b gone from the list");
    expect((await sessions()).map((s) => s.name)).toEqual(["a"]);
    run.stop.abort();
    await run.done;
  }, LONG);

  it("끝난 세션 — 데몬이 그 세션을 모르면(웹에서 끝낸 직후의 읽기) 오류 줄이 아니라 «끝남» 한 줄 · 다리는 목록을 다시 본다", async () => {
    await ok("term", "new", "a", "--", "cat");
    const paths = termPaths(rig.home);
    const log = openRemoteLog(paths);
    let gone: string | undefined;
    const viewer = new RemoteViewer({
      paths, session: "gone-already", log, size: { cols: 80, rows: 24 },
      http: createRemoteHttp({ endpoint: fake.endpoint, tokenProvider: { getAccessToken: async () => "t", refreshAfterUnauthorized: async () => "t" }, log }),
      link: () => ({ linkId: "l", generation: 1, frameMaxBytes: 65536 }),
      onGone: (reason) => { gone = reason; },
      onRefused: () => undefined,
      onUnknownSession: () => undefined,
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
    const answers: Array<Parameters<NonNullable<BridgeDeps["onAnswer"]>>[0]> = [];
    const run = start({ onAnswer: (a) => answers.push(a) });
    await until(() => answers.length > 0, "first answer");
    fake.watch();
    await until(() => answers.some((a) => a.tags === undefined && a.watching === 0), "no cli field");
    fake.cli = { next: "0.14.0-next.11", latest: "0.13.1" };
    fake.watch("a");
    await until(() => answers.some((a) => a.tags?.next === "0.14.0-next.11" && a.watching === 1), "tags + watching 1");
    expect(answers.find((a) => a.watching === 1 && a.tags)?.tags).toEqual({ next: "0.14.0-next.11", latest: "0.13.1" });
    run.stop.abort();
    await run.done;
  }, LONG);

  it("키 이름 → 데몬 key(Ctrl-D 로 cat 이 끝남 → 목록에서 빠짐) · 크기 → set-size 와 frame 크기 · 화면 모드 표지", async () => {
    await ok("term", "new", "cat", "--", "cat");
    await ok("term", "new", "app", "--", "/bin/sh", "-c", "printf '\\033[?1h'; echo app-mode; sleep 600");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    fake.watch("app");
    await until(() => fake.frames.some((f) => f.session === "app" && f.modes?.appCursor === true), "app frame with modes");
    fake.resize("app", 100, 30);
    await until(() => fake.frames.some((f) => f.session === "app" && f.cols === 100 && f.rows === 30), "frame at the new size");
    expect((await sessions()).find((s) => s.name === "app")).toMatchObject({ cols: 100, rows: 30 });

    fake.key("cat", "ctrl-d");
    await until(async () => !(await sessions()).some((s) => s.name === "cat"), "cat ended");
    await until(() => !fake.listedNames().includes("cat"), "cat gone from the list");
    fake.key("app", "no-such-key");
    await until(() => remoteLog().some((r) => r.event === "remote_command_result" && r.code === "TERM_UNKNOWN_KEY"), "unknown key logged");
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("PC 설정 끔 → remoteEnabled=false·세션 0 으로 열고 명령은 REMOTE_OFF(이중 거절) · 다리는 계속", async () => {
    await ok("term", "new", "a", "--", "cat");
    const run = start({ remoteEnabled: false });
    await until(() => fake.ops().includes("open"), "open");
    expect(fake.calls[0]?.body).toMatchObject({ remoteEnabled: false, sessions: [] });
    const id = fake.create("x");
    await until(() => fake.answerFor(id) !== undefined, "answer");
    expect(fake.answerFor(id)).toMatchObject({ ok: false, code: "REMOTE_OFF" });
    expect((await sessions()).map((s) => s.name)).toEqual(["a"]);
    expect(run.printed.join("\n")).toContain("Remote terminal: off on this PC");
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
  }, LONG);

  it("웹 «원격 터미널 끊기»(remote=off-by-web) → 화면 멈춤·명령 거절·안내 한 줄 · 링크는 남긴다(poll 계속)", async () => {
    await ok("term", "new", "a", "--", "cat");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    fake.watch("a");
    await until(() => fake.frames.length > 0, "first frame");
    fake.webOff();
    await until(() => run.printed.some((line) => line.includes("turned off from the web")), "off notice");
    const framesAtOff = fake.frames.length;
    fake.input("a", "late\r");
    const id = fake.create("x");
    await until(() => fake.answerFor(id) !== undefined, "answer");
    expect(fake.answerFor(id)).toMatchObject({ ok: false, code: "REMOTE_OFF" });
    await sleep(1_500);
    expect(fake.frames.length).toBe(framesAtOff);
    expect((await screen("a")).includes("late")).toBe(false);
    const polls = fake.ops().filter((op) => op === "poll").length;
    await until(() => fake.ops().filter((op) => op === "poll").length > polls, "still polling");
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
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

  it("api 재시작(poll 404 REMOTE_NOT_FOUND) → 같은 PC 로 다시 open(목록 포함) · 보던 세션 화면이 새 링크로", async () => {
    await ok("term", "new", "a", "--", "cat");
    const run = start();
    await until(() => fake.ops().includes("open"), "open");
    fake.watch("a");
    await until(() => fake.frames.length > 0, "first frame");
    const first = fake.linkId;
    fake.restart();
    await until(() => fake.ops().filter((op) => op === "open").length === 2, "reopened");
    expect(fake.linkId).not.toBe(first);
    expect(fake.listedNames()).toEqual(["a"]);
    fake.input("a", "after\r");
    await until(() => fake.frames.some((f) => f.linkId === fake.linkId && f.text.split("\r\n").includes("after")), "frame on the new link");
    expect(remoteLog().filter((r) => r.event === "remote_reopened")).toEqual([
      expect.objectContaining({ reason: "REMOTE_NOT_FOUND", previousLinkId: first, linkId: fake.linkId })]);
    run.stop.abort();
    await run.done;
    expectLogPairs();
  }, LONG);

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

  it("CLI — term remote 는 이제 PC 연결 안내(MOVED, 종료 1)", async () => {
    const run = await cli("term", "remote", "x");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("ainecto remote on");
    expect(await ok("--help")).not.toContain("ainecto term remote");
    expect((await termRequest(termPaths(rig.home), { op: "ls" }, { start: false })).daemon).toBe(false);
  }, LONG);
});
