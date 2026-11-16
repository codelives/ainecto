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
import { AgentRunLog } from "../../src/core/agent/runs";
import { AgentSessionMap } from "../../src/core/agent/sessions";
import type { AgentTools } from "../../src/core/agent/tools";
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

  /** open 이 돌려줄 agents[](계약 5-1) — "auto" 면 받은 agents 마다 신원(u-<종류>, 이름 = 받은 name 또는 종류 id), 없으면 옛 서버(칸 없음). */
  openAgents: "auto" | unknown[] | undefined;
  /** open 을 이 오류로 거절한다(이름 규칙 위반 등). */
  openError: AgentCallError | undefined;
  /** agents[].name 을 모르는 서버(400 INVALID). */
  rejectNames = false;
  /** features 의 todos 를 모르는 서버(400 INVALID — KAN-1113 Edwin #1890 이전 서버). */
  rejectTodos = false;
  /** open 의 cliBuild 를 모르는 서버(KAN-1113 #1890 D 전). */
  rejectBuild = false;

  /** @param oldServer 옛 서버 — open 본문이 닫혀 있어 features 를 400 INVALID 로 거절한다. */
  constructor(private readonly oldServer = false, private readonly pollHoldSeconds = 20) {}

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
      if (this.openError) throw this.openError;
      if (this.rejectBuild && body.cliBuild !== undefined) throw new AgentCallError("Invalid request body.", "open", 400, "INVALID");
      if (this.oldServer && body.features !== undefined) throw new AgentCallError("Invalid request body.", "open", 400, "INVALID");
      const sent = (Array.isArray(body.agents) ? body.agents : []) as Array<Record<string, unknown>>;
      if (this.rejectNames && sent.some((a) => a.name !== undefined)) throw new AgentCallError("Invalid request body.", "open", 400, "INVALID");
      if (this.rejectTodos && Array.isArray(body.features) && body.features.includes("todos")) {
        throw new AgentCallError("Invalid request body.", "open", 400, "INVALID");
      }
      const agents = this.openAgents === "auto"
        ? sent.map((a) => a.ready ? { id: a.id, ready: true, agentUuid: `u-${String(a.id)}`, name: a.name ?? a.id, error: null }
          : { id: a.id, ready: false, agentUuid: null, name: null, error: null })
        : this.openAgents;
      return { linkId: "11111111-1111-4111-8111-111111111111", linkToken: "tok",
        limits: { pollHoldSeconds: this.pollHoldSeconds, textMaxCharacters: 10_000, documentsMax: 50 }, ...(agents ? { agents } : {}) };
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
  /** serve 가 사람에게 쓴 줄(시작 줄 등). */
  printed: string[];
  /** 이 PC 가 돌던 카드(runs.json) — 할 일을 받을 때만 쓴다. */
  runsPath: string;
}

export interface WorldOptions {
  turnTimeoutMs?: number;
  /** 설치된 Agent(기본 Claude Code 만 — 단계 2 와 같은 PC). */
  installed?: AgentId[];
  /** sessions.json 에 미리 둘 내용. */
  sessionsFile?: Record<string, unknown>;
  /** Agent 환경에 더할 값(예: 시험용 가짜 ANTHROPIC_API_KEY). */
  env?: Record<string, string>;
  /** 옛 서버(open 의 features 를 모른다). */
  oldServer?: boolean;
  /** open 이 주는 poll 붙잡는 시간(초) — 할 일 줄의 주기도 이것. 기본 20. */
  pollHoldSeconds?: number;
  /** 에이전트 할 일도 받는다(가짜 MCP 도구 레이어 · 이 serve 의 에이전트 이름). */
  todos?: { tools: AgentTools; agentName?: string };
  /** runs.json 에 미리 둘 글(그대로 쓴다 — 깨진 파일 시험). */
  runsFile?: string;
  /** open 응답 agents[] — 기본: 할 일을 받으면 "auto"(종류마다 신원), 아니면 없음(옛 서버). */
  openAgents?: "auto" | unknown[] | null;
  /** open 거절. */
  openError?: AgentCallError;
  /** agents[].name 을 모르는 서버. */
  rejectNames?: boolean;
  /** features 의 todos 를 모르는 서버. */
  rejectTodos?: boolean;
  /** open 에 실을 빌드 식별(없으면 싣지 않는다). */
  cliBuild?: string;
  /** cliBuild 를 모르는 서버. */
  rejectBuild?: boolean;
}

export const WRITE_TOOLS = new Set(["create_documents", "update_documents", "kanban_apply_changes"]);

export function startServe(options: WorldOptions = {}): World {
  const dir = mkdtempSync(join(tmpdir(), "agent-serve-"));
  const argsLog = join(dir, "args.jsonl");
  const codexArgsLog = join(dir, "codex-args.jsonl");
  const logPath = join(dir, "agent.log");
  const sessionsPath = join(dir, "sessions.json");
  const runsPath = join(dir, "runs.json");
  if (options.runsFile !== undefined) writeFileSync(runsPath, options.runsFile);
  if (options.sessionsFile) writeFileSync(sessionsPath, JSON.stringify(options.sessionsFile));
  const server = new FakeServer(options.oldServer, options.pollHoldSeconds);
  server.openAgents = options.openAgents === null ? undefined : options.openAgents ?? (options.todos ? "auto" : undefined);
  server.openError = options.openError;
  server.rejectNames = options.rejectNames ?? false;
  server.rejectTodos = options.rejectTodos ?? false;
  server.rejectBuild = options.rejectBuild ?? false;
  const stop = new AbortController();
  const log = new DaemonLog<AgentLogRecord>(logPath, `${logPath}.1`);
  const shared = { spawnImpl: fakeSpawn, cwd: dir,
    env: { ...process.env, ANTHROPIC_API_KEY: "", FAKE_CLAUDE_ARGS_LOG: argsLog, FAKE_CODEX_ARGS_LOG: codexArgsLog, ...options.env },
    log, writeTools: WRITE_TOOLS };
  const all: AgentAdapter[] = [
    // 가짜 Agent 가 받은 인자 = 브리지 이름(할 일 차례만) + 재개 값 — 시험이 «누구로 붙었나»를 본다.
    claudeCodeAdapter({ ...shared, args: ({ resumeSessionId, agentName }) =>
      [...(agentName ? ["--agent", agentName] : []), ...(resumeSessionId ? ["--resume", resumeSessionId] : [])] }),
    codexAdapter({ ...shared, appServerArgs: (agentName) => ["app-server", ...(agentName ? ["--agent", agentName] : [])], clientVersion: "0.0.0" }),
  ];
  const installed = options.installed ?? ["claude-code"];
  const adapters = new Map(all.filter((a) => installed.includes(a.id)).map((a) => [a.id, a] as const));
  const sessions = new AgentSessionMap(sessionsPath);
  const printed: string[] = [];
  const done = sessions.load().then(() => runAgentServe({
    http: server,
    log,
    sessions,
    adapters,
    agents: installed.map((id) => ({ id, ready: true })),
    hostName: "test-host",
    cliVersion: "0.0.0",
    ...(options.cliBuild ? { cliBuild: options.cliBuild } : {}),
    print: (line) => printed.push(line),
    signal: stop.signal,
    turnTimeoutMs: options.turnTimeoutMs,
    todos: options.todos ? { ...options.todos, runs: new AgentRunLog(runsPath, log) } : undefined,
  }));
  return { server, stop, done, argsLog, codexArgsLog, logPath, sessionsPath, printed, runsPath };
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
