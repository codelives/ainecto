import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRemoteHttp, openRemoteLog, runRemote, type RemoteResult } from "../src/core/term/remote";
import { screenFrame } from "../src/core/term/remoteFrame";
import { CALL_TIMEOUT_MS, RETRY_MAX_MS, RETRY_MIN_MS, retryWait } from "../src/core/term/remoteLimits";
import { termPaths } from "../src/core/term/paths";
import { cli, LONG, ok, rig, sleep, until, useTermRig } from "./termRig";

describe("term remote — 순수 함수", () => {
  it("화면 = 줄을 \\r\\n 으로 이은 평문 · 같은 줄이면 같은 hash · 다르면 다른 hash", () => {
    const a = screenFrame(["$ cat", "hi"], 1_000);
    expect(Buffer.from(a.d, "base64").toString("utf8")).toBe("$ cat\r\nhi");
    expect(screenFrame(["$ cat", "hi"], 1_000).hash).toBe(a.hash);
    expect(screenFrame(["$ cat", "hi!"], 1_000).hash).not.toBe(a.hash);
    expect(a.dropped).toBe(0);
  });

  it("본문 상한을 넘으면 위(오래된) 줄부터 덜어 낸다 — 한글은 UTF-8 바이트로 잰다", () => {
    const lines = ["가".repeat(10), "b".repeat(10), "c".repeat(10)];
    // base64 길이 = 4*ceil(바이트/3). 마지막 두 줄 = 10+2+10 = 22바이트 → 32 글자.
    const fit = screenFrame(lines, 32);
    expect(fit.dropped).toBe(1);
    expect(Buffer.from(fit.d, "base64").toString("utf8")).toBe(`${"b".repeat(10)}\r\n${"c".repeat(10)}`);
    expect(fit.d.length).toBeLessThanOrEqual(32);
    expect(screenFrame(lines, 0).d).toBe("");
  });

  it("다시 하기 간격 — C12 에서 두 배씩 C13 까지 · 흔들림 0~C12", () => {
    expect(retryWait(0, 0)).toBe(RETRY_MIN_MS);
    expect(retryWait(1, 0)).toBe(RETRY_MIN_MS * 2);
    expect(retryWait(30, 0)).toBe(RETRY_MAX_MS);
    expect(retryWait(0, 0.999)).toBeLessThan(RETRY_MIN_MS * 2);
    expect(retryWait(30, 0.999)).toBeLessThan(RETRY_MAX_MS + RETRY_MIN_MS);
  });
});

/**
 * 서버 PC 계약 4개의 대역(프로세스 안 실제 HTTP). poll 은 붙잡았다가 입력·닫힘이 오면 깨어난다.
 * open 마다 새 remoteId·토큰 — 지금 것과 다른(또는 재시작으로 잊은) remoteId·토큰이면 404 REMOTE_NOT_FOUND(서버 requireCurrent 와 같다).
 */
class FakeServer {
  server!: Server;
  endpoint = "";
  readonly calls: Array<{ op: string; token?: string; body: Record<string, unknown> }> = [];
  readonly frameLog: Array<{ remoteId: string; text: string }> = [];
  remoteId = "";
  remoteToken = "";
  /** 재시작하면 잊는다. */
  private known = false;
  private inputs: string[] = [];
  private closedReason: string | undefined;
  /** 다음 poll 에 줄 오류. */
  pollError: { status: number; code: string } | undefined;
  frameError: { status: number; code: string } | undefined;
  /** poll 마다 원격을 잊는다 — 열자마자 또 404 가 나는 고리. */
  forgetOnPoll = false;
  /** 이 수만큼 poll 에 답하지 않는다(기한 초과 시험). */
  hangPolls = 0;
  private held: Array<{ wake: () => void; res: ServerResponse }> = [];
  private hanging: ServerResponse[] = [];

  get frames(): string[] {
    return this.frameLog.map((frame) => frame.text);
  }

  /** api 재시작 — 메모리의 원격을 잊고, 붙잡힌 poll 의 연결은 끊긴다. */
  restart(): void {
    this.known = false;
    const held = this.held;
    this.held = [];
    for (const { res } of held) res.destroy();
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => this.handle(req, res, body));
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", () => done()));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/mcp`;
  }

  async stop(): Promise<void> {
    for (const res of this.hanging) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((done) => this.server.close(() => done()));
  }

  input(text: string): void {
    this.inputs.push(Buffer.from(text, "utf8").toString("base64"));
    this.wake();
  }

  close(reason: string): void {
    this.closedReason = reason;
    this.wake();
  }

  ops(): string[] {
    return this.calls.map((call) => call.op);
  }

  private wake(): void {
    const held = this.held;
    this.held = [];
    for (const { wake } of held) wake();
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const op = (req.url ?? "").replace("/mcp/term/pc/", "");
    const body = JSON.parse(raw) as Record<string, unknown>;
    const token = req.headers["x-remote-token"];
    this.calls.push({ op, token: typeof token === "string" ? token : undefined, body });
    const reply = (status: number, out: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    };
    if (op === "poll" && this.forgetOnPoll) this.known = false;
    if (op !== "open" && (!this.known || body.remoteId !== this.remoteId || token !== this.remoteToken)) {
      reply(404, { code: "REMOTE_NOT_FOUND", detail: "No such open remote terminal." });
      return;
    }
    switch (op) {
      case "open":
        this.remoteId = randomUUID();
        this.remoteToken = `tok-${randomUUID()}`;
        this.known = true;
        reply(201, { remoteId: this.remoteId, remoteToken: this.remoteToken,
          limits: { pollHoldSeconds: 1, frameMaxBytes: 1024 * 1024, bodyMaxBytes: 64 * 1024 } });
        return;
      case "poll": {
        if (this.hangPolls > 0) {
          this.hangPolls -= 1;
          this.hanging.push(res);
          return;
        }
        const answer = () => {
          if (this.pollError) {
            reply(this.pollError.status, { code: this.pollError.code, detail: "refused" });
          } else if (this.closedReason) {
            reply(200, { state: "CLOSED", reason: this.closedReason });
          } else {
            const d = this.inputs.shift();
            reply(200, { state: "OPEN", commands: d ? [{ type: "input", d }] : [] });
          }
        };
        if (this.pollError || this.closedReason || this.inputs.length > 0) {
          answer();
          return;
        }
        const timer = setTimeout(() => {
          this.held = this.held.filter((h) => h.wake !== wakeUp);
          answer();
        }, 1_000);
        const wakeUp = () => {
          clearTimeout(timer);
          answer();
        };
        this.held.push({ wake: wakeUp, res });
        return;
      }
      case "frame":
        if (this.frameError) {
          reply(this.frameError.status, { code: this.frameError.code, detail: "refused" });
          return;
        }
        this.frameLog.push({ remoteId: String(body.remoteId), text: Buffer.from(String(body.d), "base64").toString("utf8") });
        reply(200, { version: this.frameLog.length });
        return;
      case "close":
        reply(200, {});
        return;
      default:
        reply(404, { code: "NOPE" });
    }
  }
}

describe("ainecto term remote — 실 데몬 + 서버 대역", () => {
  useTermRig();
  let fake: FakeServer;
  beforeEach(async () => {
    fake = new FakeServer();
    await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  function start(name: string, stop = new AbortController()): { done: Promise<RemoteResult>; stop: AbortController; printed: string[] } {
    const paths = termPaths(rig.home);
    const log = openRemoteLog(paths);
    const printed: string[] = [];
    const done = runRemote({
      paths,
      session: name,
      http: createRemoteHttp({
        endpoint: fake.endpoint,
        tokenProvider: { getAccessToken: async () => "t", refreshAfterUnauthorized: async () => "t" },
        log,
      }),
      log,
      hostName: "test-host",
      cliVersion: "dev",
      signal: stop.signal,
      print: (line) => printed.push(line),
    });
    return { done, stop, printed };
  }

  function remoteLog(): Array<Record<string, unknown>> {
    return readFileSync(termPaths(rig.home).remoteLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  /** 요청 줄마다 같은 callId 의 응답 줄이 있다. */
  function expectCallPairs(): void {
    const records = remoteLog();
    const requests = records.filter((r) => r.event === "remote_call").map((r) => r.callId);
    const responses = new Set(records.filter((r) => r.event === "remote_call_response").map((r) => r.callId));
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((id) => !responses.has(id))).toEqual([]);
  }

  it("웹 입력 hi\\r·Esc → 세션 → 화면에 hi·^[ · 멈춤 신호 → close · 토큰은 open 밖에만", async () => {
    await ok("term", "new", "t", "--", "cat");
    const run = start("t");
    await until(() => fake.frames.length > 0, "first frame");
    fake.input("hi\r");
    await until(() => fake.frames.some((frame) => frame.split("\r\n").includes("hi")), "frame shows hi");
    // Esc 한 바이트도 그대로 — 터미널 반향이 ^[ 로 그린다.
    fake.input("\x1b");
    await until(() => fake.frames.some((frame) => frame.includes("^[")), "frame shows ^[");
    run.stop.abort();
    const result = await run.done;
    expect(result.exitCode).toBe(0);
    expect(fake.ops()[0]).toBe("open");
    expect(fake.ops().at(-1)).toBe("close");
    expect(fake.ops().filter((op) => op === "open")).toHaveLength(1);
    expect(fake.calls[0]?.body).toMatchObject({ session: "t", hostName: "test-host", cliVersion: "dev" });
    expect(fake.calls[0]?.token).toBeUndefined();
    expect(fake.calls.slice(1).every((call) => call.token === fake.remoteToken && call.body.remoteId === fake.remoteId)).toBe(true);
    expectCallPairs();
    // 화면 글자·입력·토큰은 로그에 남지 않는다.
    const text = readFileSync(termPaths(rig.home).remoteLog, "utf8");
    expect(text).not.toContain(fake.remoteToken);
    expect(text).not.toContain(Buffer.from("hi\r").toString("base64"));
  }, LONG);

  it("Ctrl 바이트도 그대로 — Ctrl-D 로 cat 이 끝나면 close 보내고 끝(0)", async () => {
    await ok("term", "new", "t", "--", "cat");
    const run = start("t");
    await until(() => fake.frames.length > 0, "first frame");
    fake.input("\x04");
    const result = await run.done;
    expect(result.exitCode).toBe(0);
    expect(result.reason).toMatch(/exited/);
    expect(fake.ops().at(-1)).toBe("close");
    expectCallPairs();
  }, LONG);

  it("서버가 CLOSED → 종료 코드 0 · close 를 보내지 않고 다시 open 하지 않는다", async () => {
    await ok("term", "new", "t", "--", "cat");
    const run = start("t");
    await until(() => fake.frames.length > 0, "first frame");
    fake.close("CLOSED_BY_WEB");
    const result = await run.done;
    expect(result.exitCode).toBe(0);
    expect(result.reason).toContain("CLOSED_BY_WEB");
    expect(fake.ops().filter((op) => op === "open")).toHaveLength(1);
    expect(fake.ops()).not.toContain("close");
    expectCallPairs();
  }, LONG);

  it("api 재시작(poll 404 REMOTE_NOT_FOUND) → 같은 세션으로 다시 open · 새 원격에 첫 장부터 · 입력·화면이 새 원격으로", async () => {
    await ok("term", "new", "t", "--", "cat");
    const run = start("t");
    await until(() => fake.frames.length > 0, "first frame");
    const first = fake.remoteId;
    fake.restart();
    await until(() => fake.ops().filter((op) => op === "open").length === 2, "reopened");
    const second = fake.remoteId;
    expect(second).not.toBe(first);
    // 화면이 바뀌지 않았어도 새 원격에 첫 장을 올린다(hash 초기화).
    await until(() => fake.frameLog.some((frame) => frame.remoteId === second), "first frame on the new remote");
    fake.input("hi\r");
    await until(() => fake.frameLog.some((frame) => frame.remoteId === second && frame.text.split("\r\n").includes("hi")), "hi on the new remote");
    run.stop.abort();
    const result = await run.done;
    expect(result.exitCode).toBe(0);
    const opens = fake.calls.filter((call) => call.op === "open");
    expect(opens.map((call) => call.body.session)).toEqual(["t", "t"]);
    expect(opens.every((call) => call.token === undefined)).toBe(true);
    const close = fake.calls.at(-1);
    expect(close).toMatchObject({ op: "close", token: fake.remoteToken, body: { remoteId: second } });
    expect(remoteLog().filter((r) => r.event === "remote_reopened"))
      .toEqual([expect.objectContaining({ reason: "REMOTE_NOT_FOUND", previousRemoteId: first, remoteId: second })]);
    expectCallPairs();
  }, LONG);

  it("열자마자 또 404 인 고리 — 다시 열기는 C12 부터 두 배씩 벌어진다(폭주 없음)", async () => {
    await ok("term", "new", "t", "--", "cat");
    fake.forgetOnPoll = true;
    const run = start("t");
    await until(() => fake.ops().filter((op) => op === "open").length >= 2, "reopening");
    const started = Date.now();
    await sleep(RETRY_MIN_MS * 4);
    // 기다림 없이 돌면 수백 번이다. 간격 0.5~1초 → 1~1.5초 → … 이므로 2초 동안 많아야 몇 번.
    const opens = fake.ops().filter((op) => op === "open").length;
    expect(opens).toBeLessThanOrEqual(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(RETRY_MIN_MS * 4);
    run.stop.abort();
    expect((await run.done).exitCode).toBe(0);
    expectCallPairs();
  }, LONG);

  it("poll 401(로그인 거절) → 끝(1) · 다시 open 하지 않는다", async () => {
    await ok("term", "new", "t", "--", "cat");
    fake.pollError = { status: 401, code: "UNAUTHORIZED" };
    const result = await start("t").done;
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("401");
    expect(fake.ops().filter((op) => op === "open")).toHaveLength(1);
    expectCallPairs();
  }, LONG);

  it("그 밖 4xx → 사유와 함께 비정상 종료(1)", async () => {
    await ok("term", "new", "t", "--", "cat");
    fake.frameError = { status: 413, code: "FRAME_TOO_LARGE" };
    const result = await start("t").done;
    expect(result.exitCode).toBe(1);
    expect(result.reason).toContain("FRAME_TOO_LARGE");
    expectCallPairs();
  }, LONG);

  it("서버가 poll 에 답하지 않으면 기한 초과 응답 줄을 남기고 같은 remoteId 로 다시 poll", async () => {
    await ok("term", "new", "t", "--", "cat");
    fake.hangPolls = 1;
    const run = start("t");
    // poll 기한 = 붙잡는 시간(1초) + C8 — 리그의 until(10초)보다 길다.
    const deadline = Date.now() + 1_000 + CALL_TIMEOUT_MS + RETRY_MIN_MS * 2 + 5_000;
    while (fake.ops().filter((op) => op === "poll").length < 2) {
      if (Date.now() > deadline) throw new Error("no second poll");
      await sleep(100);
    }
    fake.close("CLOSED_BY_WEB");
    expect((await run.done).exitCode).toBe(0);
    const timedOut = remoteLog().find((r) => r.event === "remote_call_response" && r.op === "poll" && r.error === "TimeoutError");
    expect(timedOut).toBeDefined();
    const polls = fake.calls.filter((call) => call.op === "poll");
    expect(new Set(polls.map((call) => call.body.remoteId))).toEqual(new Set([fake.remoteId]));
    expect(fake.ops().filter((op) => op === "open")).toHaveLength(1);
    expectCallPairs();
  }, LONG);

  it("없는 세션 → 서버를 부르지 않고 오류", async () => {
    await ok("term", "new", "t", "--", "cat");
    await expect(start("nope").done).rejects.toMatchObject({ code: "TERM_NO_SESSION" });
    expect(fake.calls).toEqual([]);
  }, LONG);

  it("CLI 진입 — term remote 는 도움말에 있고, 없는 세션이면 1", async () => {
    expect(await ok("--help")).toContain("ainecto term remote <name>");
    const run = await cli("term", "remote", "nope");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("nope");
  }, LONG);
});
