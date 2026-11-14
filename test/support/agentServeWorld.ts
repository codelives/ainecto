import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentId } from "../../src/core/agent/agents";
import type { AgentSpawn } from "../../src/core/agent/child";
import { claudeCodeAdapter } from "../../src/core/agent/claudeCode";
import { codexAdapter } from "../../src/core/agent/codex";
import { AgentCallError, type AgentHttp, type AgentOp } from "../../src/core/agent/http";
import type { AgentLogRecord } from "../../src/core/agent/log";
import { runAgentServe, type ServeResult } from "../../src/core/agent/serve";
import { AgentSessionMap } from "../../src/core/agent/sessions";
import { DaemonLog } from "../../src/core/term/daemonLog";

const FAKES: Record<string, string> = {
  claude: join(__dirname, "..", "fixtures", "fakeClaude.mjs"),
  codex: join(__dirname, "..", "fixtures", "fakeCodex.mjs"),
};

/** 가짜 Agent 띄우기 — 실행 파일 이름으로 가짜 스크립트를 고른다. 모르는 이름은 진짜로 띄워 ENOENT 를 낸다. */
export const fakeSpawn: AgentSpawn = (command, args, opts) => {
  const script = FAKES[command];
  return script
    ? spawn(process.execPath, [script, ...args], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
};

/** 메모리 서버 — poll 은 넣어 둔 응답을 하나씩 주고, 없으면 붙잡는다(멈춤 신호까지). */
export class FakeServer implements AgentHttp {
  readonly calls: Array<{ op: AgentOp; body: Record<string, unknown> }> = [];
  private polls: Array<Record<string, unknown> | AgentCallError> = [];
  private waiting: (() => void) | undefined;

  offer(turnUuid: string, conversationUuid: string, text: string, context?: Record<string, unknown>, agent?: string): void {
    this.push({ state: "OPEN", offers: [{ turnUuid, conversationUuid, text, context, ...(agent ? { agent } : {}) }] });
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

export interface World {
  server: FakeServer;
  stop: AbortController;
  done: Promise<ServeResult>;
  argsLog: string;
  codexArgsLog: string;
  logPath: string;
  sessionsPath: string;
}

export interface WorldOptions {
  turnTimeoutMs?: number;
  /** 설치된 Agent(기본 Claude Code 만 — 단계 2 와 같은 PC). */
  installed?: AgentId[];
  /** sessions.json 에 미리 둘 내용. */
  sessionsFile?: Record<string, unknown>;
  /** 운영처럼 API 키 모드만 받는다(--env prod). */
  requireApiKey?: boolean;
  /** Agent 환경에 더할 값(예: 시험용 가짜 ANTHROPIC_API_KEY). */
  env?: Record<string, string>;
}

export const WRITE_TOOLS = new Set(["create_documents", "update_documents", "kanban_apply_changes"]);

export function startServe(options: WorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "agent-serve-"));
  const argsLog = join(dir, "args.jsonl");
  const codexArgsLog = join(dir, "codex-args.jsonl");
  const logPath = join(dir, "agent.log");
  const sessionsPath = join(dir, "sessions.json");
  if (options.sessionsFile) writeFileSync(sessionsPath, JSON.stringify(options.sessionsFile));
  const server = new FakeServer();
  const stop = new AbortController();
  const log = new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`);
  const shared = { spawnImpl: fakeSpawn, cwd: dir,
    env: { ...process.env, ANTHROPIC_API_KEY: "", FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_CODEX_ARGS_LOG: codexArgsLog, ...options.env },
    log, writeTools: WRITE_TOOLS, requireApiKey: options.requireApiKey === true };
  const all: AgentAdapter[] = [
    claudeCodeAdapter({ ...shared, args: ({ resumeSessionId }) => (resumeSessionId ? ["--resume", resumeSessionId] : []) }),
    codexAdapter({ ...shared, appServerArgs: ["app-server"], clientVersion: "0.0.0" }),
  ];
  const installed = options.installed ?? ["claude-code"];
  const adapters = new Map(all.filter((a) => installed.includes(a.id)).map((a) => [a.id, a] as const));
  const sessions = new AgentSessionMap(sessionsPath);
  const done = sessions.load().then(() => runAgentServe({
    http: server,
    log,
    sessions,
    adapters,
    agents: installed.map((id) => ({ id, ready: true })),
    hostName: "test-host",
    cliVersion: "0.0.0",
    print: () => {},
    signal: stop.signal,
    turnTimeoutMs: options.turnTimeoutMs,
  }));
  return { server, stop, done, argsLog, codexArgsLog, logPath, sessionsPath };
}

export async function until<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const jsonLines = (path: string): unknown[] =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown) : [];

export const spawned = (w: World): string[][] => jsonLines(w.argsLog) as string[][];
export const codexSpawned = (w: World): string[][] => jsonLines(w.codexArgsLog) as string[][];
export const logRecords = (w: World): Array<Record<string, unknown>> => jsonLines(w.logPath) as Array<Record<string, unknown>>;

export async function finish(w: World): Promise<ServeResult> {
  w.stop.abort();
  return await w.done;
}
