import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallError, type AgentHttp, type AgentOp } from "../src/core/agent/http";
import type { AgentLogRecord } from "../src/core/agent/log";
import { runAgentServe, type ServeResult } from "../src/core/agent/serve";
import { AgentSessionMap } from "../src/core/agent/sessions";
import { DaemonLog } from "../src/core/term/daemonLog";

const FAKE = join(__dirname, "fixtures", "fakeClaude.mjs");
const DOC_A = "a".repeat(32);
const DOC_B = "b".repeat(32);

/** 메모리 서버 — poll 은 넣어 둔 응답을 하나씩 주고, 없으면 붙잡는다(멈춤 신호까지). */
class FakeServer implements AgentHttp {
  readonly calls: Array<{ op: AgentOp; body: Record<string, unknown> }> = [];
  private polls: Array<Record<string, unknown> | AgentCallError> = [];
  private waiting: (() => void) | undefined;

  offer(turnUuid: string, conversationUuid: string, text: string, context?: Record<string, unknown>): void {
    this.push({ state: "OPEN", offers: [{ turnUuid, conversationUuid, text, context }] });
  }

  push(response: Record<string, unknown> | AgentCallError): void {
    this.polls.push(response);
    this.waiting?.();
  }

  replies(): Array<Record<string, unknown>> {
    return this.calls.filter((c) => c.op === "reply").map((c) => c.body);
  }

  useLinkToken(): void {}

  async call(op: AgentOp, body: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    this.calls.push({ op, body });
    if (op === "open") {
      return { linkId: "11111111-1111-4111-8111-111111111111", linkToken: "tok", limits: { pollHoldSeconds: 20, textMaxCharacters: 10_000, documentsMax: 50 } };
    }
    if (op !== "poll") return {};
    for (;;) {
      const next = this.polls.shift();
      if (next instanceof AgentCallError) throw next;
      if (next) return next;
      if (options.signal?.aborted) throw new AgentCallError("poll stopped", "poll");
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        options.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      this.waiting = undefined;
    }
  }
}

interface World {
  server: FakeServer;
  stop: AbortController;
  done: Promise<ServeResult>;
  argsLog: string;
  logPath: string;
  sessionsPath: string;
}

function startServe(options: { turnTimeoutMs?: number } = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "agent-serve-"));
  const argsLog = join(dir, "args.jsonl");
  const logPath = join(dir, "agent.log");
  const sessionsPath = join(dir, "sessions.json");
  const server = new FakeServer();
  const stop = new AbortController();
  const done = runAgentServe({
    http: server,
    log: new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`),
    sessions: new AgentSessionMap(sessionsPath),
    writeTools: new Set(["create_documents"]),
    claudeArgs: ({ resumeSessionId }) => (resumeSessionId ? ["--resume", resumeSessionId] : []),
    spawnImpl: (args, opts) => spawn(process.execPath, [FAKE, ...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] }),
    cwd: dir,
    env: { ...process.env, FAKE_CLAUDE_ARGS_LOG: argsLog },
    hostName: "test-host",
    cliVersion: "0.0.0",
    print: () => {},
    signal: stop.signal,
    turnTimeoutMs: options.turnTimeoutMs,
  });
  return { server, stop, done, argsLog, logPath, sessionsPath };
}

async function until<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const spawned = (w: World): string[][] =>
  existsSync(w.argsLog) ? readFileSync(w.argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];

const logRecords = (w: World): Array<Record<string, unknown>> =>
  readFileSync(w.logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

async function finish(w: World): Promise<ServeResult> {
  w.stop.abort();
  return await w.done;
}

describe("ainecto agent serve", () => {
  it("★K4 — 서버가 같은 요청을 다시 줘도 Claude 에는 한 번만 넣고 답도 한 번", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "hello");
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    w.server.offer("t1", "conv-a", "hello");
    w.server.offer("t2", "conv-a", "next");
    const second = await until(() => w.server.replies()[1]);
    const result = await finish(w);

    expect(reply).toMatchObject({ turnUuid: "t1", conversationUuid: "conv-a", status: "DONE", documentUuids: [] });
    expect(String(reply.reply)).toMatch(/^got hello #1 in sess-/);
    expect(String(second.reply)).toMatch(/^got next #2 in sess-/);   // 같은 프로세스의 두 번째 줄
    expect(w.server.replies()).toHaveLength(2);
    expect(spawned(w)).toHaveLength(1);
    const records = logRecords(w);
    expect(records.filter((r) => r.event === "offer" && r.duplicate === true)).toHaveLength(2);
    expect(records.filter((r) => r.event === "agent_request").map((r) => r.turnUuid)).toEqual(["t1", "t2"]);
    expect(records.filter((r) => r.event === "agent_response").map((r) => r.turnUuid)).toEqual(["t1", "t2"]);
    expect(result).toEqual({ exitCode: 0, reason: "signal" });
    expect(w.server.calls.at(-1)?.op).toBe("close");
  });

  it("★서버가 준 맥락(대화의 프로젝트·열린 문서)을 Claude stdin 한 줄 앞머리로 넣는다", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "이 프로젝트에 문서 만들어", {
      project: { uuid: "p-1", name: "MCP 완주 테스트", workspaceUuid: "w-1", workspaceName: "라이언" },
      openDocument: { uuid: "d".repeat(32), title: "원고", type: "markdown" },
    });
    const reply = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "맥락 없음");
    const plain = await until(() => w.server.replies()[1]);
    await finish(w);
    // 가짜 claude 는 stdin 한 줄을 그대로 «got <글>» 로 돌려준다.
    expect(String(reply.reply)).toContain('got [AiNecto context — "this project" / "this document" mean these] project «MCP 완주 테스트» (projectUuid p-1, workspace «라이언» w-1) · open document «원고» (documentUuid ' + "d".repeat(32) + ", markdown)\n\n이 프로젝트에 문서 만들어 #1");
    expect(String(plain.reply)).toMatch(/^got 맥락 없음 #2/);
  });

  it("대화가 바뀌면 앞 프로세스를 내리고, 돌아오면 그 대화의 세션으로 --resume", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "one");
    const first = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-b", "two");
    await until(() => w.server.replies()[1]);
    w.server.offer("t3", "conv-a", "three");
    const third = await until(() => w.server.replies()[2]);
    await finish(w);

    const sessionA = /in (sess-\d+)$/.exec(String(first.reply))?.[1];
    expect(sessionA).toBeDefined();
    expect(spawned(w)).toEqual([[], [], ["--resume", sessionA]]);
    expect(String(third.reply)).toBe(`got three #1 in ${sessionA}`);
    expect(JSON.parse(readFileSync(w.sessionsPath, "utf8")).conversations["conv-a"].sessionId).toBe(sessionA);
    const exits = logRecords(w).filter((r) => r.event === "process_exit");
    expect(exits.length).toBeGreaterThanOrEqual(2);
  });

  it("문서는 쓰기 도구 결과에서만 · schema 를 어긴 답은 FAILED", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "write-doc");
    const doc = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "bad-schema");
    const bad = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(doc.documentUuids).toEqual([DOC_B]);
    expect(doc.documentUuids).not.toContain(DOC_A);
    expect(bad).toMatchObject({ status: "FAILED", errorCode: "SCHEMA_VIOLATION" });
    expect(String(bad.reply)).toContain('"documents"');
  });

  it("기한(B3)을 넘기면 그 프로세스를 내리고 FAILED TURN_TIMEOUT · 다음 요청은 새 프로세스", async () => {
    const w = startServe({ turnTimeoutMs: 300 });
    w.server.offer("t1", "conv-a", "hang");
    const timedOut = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "after");
    const after = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(timedOut).toMatchObject({ status: "FAILED", errorCode: "TURN_TIMEOUT" });
    expect(after.status).toBe("DONE");
    expect(spawned(w)).toHaveLength(2);
    expect(logRecords(w).find((r) => r.event === "agent_response" && r.turnUuid === "t1")?.outcome).toBe("timeout");
  });

  it("프로세스가 죽으면 FAILED AGENT_EXITED — 응답 줄은 남는다", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "crash");
    const crashed = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(crashed).toMatchObject({ status: "FAILED", errorCode: "AGENT_EXITED" });
    expect(logRecords(w).find((r) => r.event === "agent_response")?.outcome).toBe("exited");
  });

  it("서버가 link 를 모르면(재시작) 다시 하지 않고 끝낸다 · 다른 PC 가 오면 끝낸다", async () => {
    const lost = startServe();
    lost.server.push(new AgentCallError("No such agent link.", "poll", 404, "LINK_NOT_FOUND"));
    expect(await lost.done).toEqual({ exitCode: 1, reason: "link_not_found" });
    expect(lost.server.calls.filter((c) => c.op === "close")).toHaveLength(0);

    const replaced = startServe();
    replaced.server.push({ state: "CLOSED", reason: "REPLACED" });
    expect(await replaced.done).toEqual({ exitCode: 1, reason: "replaced" });
  });

  it("네트워크 실패는 B2 간격으로 다시 한다", async () => {
    const w = startServe();
    w.server.push(new AgentCallError("poll failed: ECONNRESET", "poll"));
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(reply.status).toBe("DONE");
  });
});
