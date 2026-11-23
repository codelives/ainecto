import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DaemonLog } from "../term/daemonLog";
import type { AgentAdapter, AgentAuthStatus, AgentSession, TurnOutcome } from "./agents";
import { AGY, ANTIGRAVITY_MCP_SERVER, VERIFIED_AGY_VERSION, antigravityAgentArgs, antigravitySettings } from "./antigravityArgs";
import { antigravityMcpPolicy, writeWorkspaceMcpConfig, type McpPolicy } from "./antigravityPolicy";
import { AgentChild, detectByVersion, runToEnd, withDeadline, type AgentSpawn, type ChildExit } from "./child";
import { TurnFactsCollector } from "./documents";
import { AGENT_CALL_TIMEOUT_MS, AGENT_STOP_WAIT_MS } from "./limits";
import type { AgentLogRecord } from "./log";

export interface AntigravityDeps {
  spawnImpl: AgentSpawn;
  env: NodeJS.ProcessEnv;
  home: string;
  log: DaemonLog<AgentLogRecord>;
  /** 서버 tools/list 에서 readOnlyHint 가 아닌 도구 이름. */
  writeTools: ReadonlySet<string>;
  /** 서버 tools/list 의 공개 도구 이름 전부 — 이 밖의 이름은 TurnFacts 에 싣지 않는다. */
  toolNames: ReadonlySet<string>;
  /** 세션 폴더(연결 이름마다 하나 · 저장소 밖 앱 데이터 아래 · 우리 파일만 둔다). */
  workDir(agentName: string | undefined): string;
  /** 작업 폴더 {@code .agents/mcp_config.json} 내용(브리지 하나). */
  mcpConfig(agentName: string | undefined): Record<string, unknown>;
  schema(textMaxCharacters: number, documentsMax: number): Record<string, unknown>;
}

/**
 * Antigravity 어댑터 — 설계 `_workspace/design/windows-pc/ecobit/antigravity-pc-agent.md` r3(reviewer03 GO 11-23).
 * 한 차례 = {@code agy -p} 프로세스 하나(stdin 한 줄 → 닫기 → result). 논리 세션은 {@code conversation_id} 로 잇는다.
 * 인증은 {@code agy models} 의 끝 코드(모델 호출 0).
 */
export function antigravityAdapter(deps: AntigravityDeps): AgentAdapter {
  return {
    id: "antigravity",
    displayName: "Antigravity",
    async detect() {
      const detected = await detectByVersion(deps.spawnImpl, AGY, { cwd: deps.home, env: deps.env, timeoutMs: AGENT_CALL_TIMEOUT_MS });
      if (detected.installed && detected.version !== VERIFIED_AGY_VERSION) {
        deps.log.write({ event: "agent_version_unverified", agent: "antigravity", version: detected.version ?? "-", verified: VERIFIED_AGY_VERSION });
      }
      return detected;
    },
    async authStatus() {
      const run = await runToEnd(deps.spawnImpl, AGY, ["models"], { cwd: deps.home, env: deps.env, timeoutMs: AGENT_CALL_TIMEOUT_MS });
      if (run.spawnError || run.timedOut) return { ready: false, detail: run.spawnError ?? "timed out" };
      return antigravityAuth(run.code, deps.env, await modelProvider(deps.home));
    },
    open: ({ conversationUuid, resumeRef, textMaxCharacters, documentsMax, agentName }) =>
      new AntigravitySession(conversationUuid, resumeRef, agentName, deps.schema(textMaxCharacters, documentsMax), deps),
  };
}

/**
 * {@code agy models} 끝 코드 + 인증 변수 → 준비 여부(순수 함수 · 값은 읽지 않고 있는지만). 실측: 로그인됨 = 0 · 로그인 없음 = 1(«Please sign in»).
 * 과금 주체: {@code GEMINI_API_KEY} + 설정 {@code modelProvider: "gemini"} = 그 키 · {@code AGY_ADC_AUTH=true} = 그 Google Cloud 프로젝트 · 그 밖 = Google 계정 요금제.
 */
export function antigravityAuth(code: number | null, env: NodeJS.ProcessEnv, provider: string | undefined): AgentAuthStatus {
  if (code !== 0) return { ready: false, detail: "sign in — run `agy` once" };
  if ((env.GEMINI_API_KEY ?? "") !== "" && provider === "gemini") return { ready: true, mode: "apiKey", method: "gemini-api-key" };
  if (env.AGY_ADC_AUTH === "true") return { ready: true, mode: "apiKey", method: "google-cloud-adc" };
  return { ready: true, mode: "subscription", method: "google-account" };
}

async function modelProvider(home: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(home, ".gemini", "antigravity-cli", "settings.json"), "utf8"));
    const provider = (value as { modelProvider?: unknown } | null)?.modelProvider;
    return typeof provider === "string" ? provider : undefined;
  } catch {
    return undefined;   // 없거나 못 읽으면 기본(Google 계정)
  }
}

interface Turn {
  generation: number;
  resolve(outcome: TurnOutcome): void;
  facts: TurnFactsCollector;
  /** 이미 센 step_index — 같은 단계는 한 번만. */
  counted: Set<number>;
  /** 브리지 밖 서버에서 DONE 된 도구(사후 대조). */
  foreign: Array<{ server: string; tool: string }>;
  /** 사용자 멈춤 · close · 기한 — 이 차례는 더 시작하지 않는다(사전 점검 중이어도). */
  interrupted: boolean;
  /** 결과를 한 번 냈다 — 그 뒤 줄·exit 은 이 차례를 바꾸지 않는다. */
  done: boolean;
  /** 이 차례의 agy -p(사전 점검이 끝나 띄웠을 때만). */
  child?: AgentChild;
}

/**
 * ★논리 세션 하나 · 차례마다 프로세스 하나(r2). {@code alive} = close 전. {@code sessionRef} 는 init 의 conversation_id 를 받는 즉시.
 * ★차례의 수명 = 사전 점검(앞 프로세스 정리 · 설정 쓰기 · 이름 모으기)부터 그 프로세스 종료까지(구현 리뷰 1차 P0-1·P0-2):
 *   멈춤·close·기한은 사전 점검 중이어도 그 차례를 끝내고 agy -p 를 띄우지 않는다. 결과를 낸 뒤에도 그 프로세스는 {@link children} 이 쥐고 있고,
 *   다음 차례는 앞 프로세스가 끝났는지(B6 기다린 뒤 강제로) 확인한 뒤에만 띄운다. 사용자 멈춤은 result(isError · interrupted) — 성공으로 위장하지 않는다.
 */
class AntigravitySession implements AgentSession {
  readonly agent = "antigravity" as const;
  readonly resumed: boolean;
  sessionRef: string | undefined;
  private closed = false;
  private generation = 0;
  private lastPid = -1;
  private turn: Turn | undefined;
  /** 아직 끝나지 않은 차례 프로세스 전부(세대 무관) — 끝날 때(exit) 빠진다. */
  private readonly children = new Set<AgentChild>();
  private readonly cwd: string;

  constructor(readonly conversationUuid: string, resumeRef: string | undefined, readonly agentName: string | undefined,
    private readonly schema: Record<string, unknown>, private readonly deps: AntigravityDeps) {
    this.resumed = resumeRef !== undefined;
    this.sessionRef = resumeRef;
    this.cwd = deps.workDir(agentName);
  }

  get pid(): number {
    return this.lastPid;
  }

  get alive(): boolean {
    return !this.closed;
  }

  async send(text: string, timeoutMs: number): Promise<TurnOutcome> {
    if (this.closed) return { kind: "exited", code: null, signal: null, stderrTail: "session closed" };
    let resolve!: (outcome: TurnOutcome) => void;
    const outcome = new Promise<TurnOutcome>((r) => { resolve = r; });
    const turn: Turn = { generation: ++this.generation, resolve, facts: new TurnFactsCollector(), counted: new Set(), foreign: [],
      interrupted: false, done: false };
    this.turn = turn;   // ★첫 await 전에 — 사전 점검 중의 멈춤도 이 차례에 걸린다
    void this.run(turn, text).catch((error: unknown) => this.finish(turn, { kind: "exited", code: null, signal: null,
      stderrTail: error instanceof Error ? error.message : String(error) }));
    try {
      return await withDeadline<TurnOutcome>(outcome, timeoutMs, { kind: "timeout" });
    } finally {
      // 기한을 넘겼으면 이 차례는 끝 — 사전 점검이 늦게 끝나도 띄우지 않는다(떠 있는 프로세스는 serve 의 close 가 끈다).
      if (!turn.done) {
        turn.interrupted = true;
        turn.done = true;
      }
      if (this.turn === turn) this.turn = undefined;
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.done) return;
    turn.interrupted = true;
    if (turn.child?.alive) {
      await turn.child.forceStop();   // 그 exit 이 interrupted 로 끝낸다
    } else {
      this.finishInterrupted(turn);   // 사전 점검 중 — 띄우지 않고 바로 끝
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const turn = this.turn;
    if (turn) turn.interrupted = true;
    await Promise.all([...this.children].map(async (child) => await child.forceStop()));
    if (turn) this.finishInterrupted(turn);
  }

  /** 한 차례 — 앞 프로세스 정리 → 사전 점검 → 띄우기. await 마다 멈춤을 다시 본다. */
  private async run(turn: Turn, text: string): Promise<void> {
    if (!(await this.settlePrevious())) {
      this.finish(turn, { kind: "exited", code: null, signal: null, stderrTail: "the previous Antigravity process did not stop" });
      return;
    }
    if (this.stopped(turn)) return this.finishInterrupted(turn);
    let policy: McpPolicy;
    try {
      await mkdir(this.cwd, { recursive: true, mode: 0o700 });
      await writeWorkspaceMcpConfig(this.cwd, this.deps.mcpConfig(this.agentName));
      policy = await antigravityMcpPolicy({ cwd: this.cwd, home: this.deps.home, pluginList: () => this.pluginList() });
    } catch (error) {
      policy = { ok: false, reason: `could not prepare the work folder: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (this.stopped(turn)) return this.finishInterrupted(turn);
    if (!policy.ok) {
      this.deps.log.write({ event: "agent_policy_unverified", agent: this.agent, conversationUuid: this.conversationUuid,
        reason: policy.reason, ...(policy.path ? { path: policy.path } : {}) });
      this.finish(turn, { kind: "refused", errorCode: "AGENT_POLICY_UNVERIFIED", reason: policy.reason });
      return;
    }
    const args = antigravityAgentArgs({ schema: this.schema, settings: antigravitySettings(policy.deny), conversationId: this.sessionRef });
    const child: AgentChild = new AgentChild(this.deps.spawnImpl, AGY, args, { cwd: this.cwd, env: this.deps.env }, {
      line: (line) => this.onLine(turn, child, line),
      exit: (exit) => this.onExit(turn, child, exit),
      killed: (result) => this.deps.log.write({ event: "process_kill", pid: child.pid, agent: this.agent, ...result }),
    });
    this.children.add(child);
    turn.child = child;
    this.lastPid = child.pid;
    this.deps.log.write({ event: "process_start", pid: child.pid, agent: this.agent, conversationUuid: this.conversationUuid,
      resume: this.sessionRef !== undefined });
    child.writeLine({ event: "user", message: { content: text } });
    child.endInput();
  }

  /** 앞 차례 프로세스가 모두 끝났는가 — 안 끝났으면 B6 기다리고, 그래도면 강제로 끈다. 끝내 못 끄면 false(새 차례를 띄우지 않는다). */
  private async settlePrevious(): Promise<boolean> {
    for (const child of [...this.children]) {
      if (await child.waitForExit(AGENT_STOP_WAIT_MS)) continue;
      await child.forceStop();
    }
    return [...this.children].every((child) => !child.alive);
  }

  private stopped(turn: Turn): boolean {
    return turn.interrupted || turn.done || this.closed;
  }

  private async pluginList(): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }> {
    // 기한 B1 을 넘기면 runToEnd 가 끈다 — 이 사이 멈춤이 오면 차례는 바로 끝나고, 이 결과는 버려진다(run 이 멈춤을 다시 본다).
    const run = await runToEnd(this.deps.spawnImpl, AGY, ["plugin", "list", "--json"],
      { cwd: this.cwd, env: this.deps.env, timeoutMs: AGENT_CALL_TIMEOUT_MS });
    if (run.spawnError || run.timedOut || run.code !== 0) {
      return { ok: false, detail: run.spawnError ?? (run.timedOut ? "timed out" : `exit ${run.code}`) };
    }
    return { ok: true, stdout: run.stdout };
  }

  /** 결과는 한 번만 — 그 뒤 줄·exit·멈춤은 이 차례를 바꾸지 않는다. */
  private finish(turn: Turn, outcome: TurnOutcome): void {
    if (turn.done) return;
    turn.done = true;
    if (this.turn === turn) this.turn = undefined;
    turn.resolve(outcome);
  }

  private finishInterrupted(turn: Turn): void {
    this.finish(turn, { kind: "result", facts: turn.facts.snapshot(), result: { isError: true, subtype: "interrupted" } });
  }

  /** 프로세스 종료 — 소유를 놓고(로그는 그 세대 pid), 결과가 아직이면 마지막 줄까지 읽힌 뒤에 정한다(exit 이 result 줄보다 먼저 올 수 있다). */
  private onExit(turn: Turn, child: AgentChild, exit: ChildExit): void {
    this.children.delete(child);
    this.deps.log.write({ event: "process_exit", pid: child.pid, agent: this.agent, conversationUuid: this.conversationUuid,
      code: exit.code, signal: exit.signal });
    void child.waitForOutput(AGENT_STOP_WAIT_MS).then(() => {
      if (turn.interrupted) this.finishInterrupted(turn);
      else this.finish(turn, { kind: "exited", ...exit });
    });
  }

  private onLine(turn: Turn, child: AgentChild, line: string): void {
    if (turn.done) return;   // 끝난 차례(앞 세대 포함)의 늦은 줄은 버린다
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) throw new Error("not an object");
      event = value;
    } catch {
      this.deps.log.write({ event: "bad_line", pid: child.pid, agent: this.agent, length: line.length });
      return;
    }
    if (event.event === "init") {
      if (typeof event.conversation_id === "string") this.sessionRef = event.conversation_id;
      return;
    }
    if (event.event === "step_update" && isObject(event.step_update)) {
      this.onStep(turn, event.step_update);
      return;
    }
    if (event.event === "result" && isObject(event.result)) {
      this.onResult(turn, child, event.result);
    }
  }

  /** TurnFacts(r2 좁힘): tool · DONE · call_mcp_tool · 브리지 · 공개 도구 이름 · 오류 없는 글 결과 · 같은 단계 한 번. */
  private onStep(turn: Turn, step: Record<string, unknown>): void {
    if (step.step_type !== "tool" || step.state !== "DONE" || !isObject(step.tool_info)) return;
    const tool = step.tool_info;
    if (tool.name !== "call_mcp_tool" || !isObject(tool.parameters)) return;
    const server = typeof tool.parameters.ServerName === "string" ? tool.parameters.ServerName : "";
    const name = typeof tool.parameters.ToolName === "string" ? tool.parameters.ToolName : "";
    if (server !== ANTIGRAVITY_MCP_SERVER) {
      turn.foreign.push({ server, tool: name });
      return;
    }
    if (typeof step.step_index !== "number" || turn.counted.has(step.step_index)) return;
    if (tool.error !== undefined || typeof tool.output !== "string" || !this.deps.toolNames.has(name)) return;
    turn.counted.add(step.step_index);
    turn.facts.add(agyContentParts(tool.output), this.deps.writeTools.has(name));
  }

  private onResult(turn: Turn, child: AgentChild, result: Record<string, unknown>): void {
    if (typeof result.conversation_id === "string") this.sessionRef = result.conversation_id;
    const usage = isObject(result.usage) ? result.usage : undefined;
    this.deps.log.write({ event: "agent_usage", pid: child.pid, agent: this.agent, conversationUuid: this.conversationUuid,
      ...(typeof usage?.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
      ...(typeof usage?.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}) });
    if (turn.interrupted) return this.finishInterrupted(turn);   // 멈춤과 결과가 겹치면 멈춤(웹은 이미 «중단»을 보냈다)
    const facts = turn.facts.snapshot();
    if (turn.foreign.length > 0) {
      for (const { server, tool } of turn.foreign) {
        this.deps.log.write({ event: "agent_policy_violation", pid: child.pid, agent: this.agent, conversationUuid: this.conversationUuid,
          server, tool });
      }
      this.finish(turn, { kind: "result", facts, result: { isError: true, subtype: "policy_violation" } });
      return;
    }
    const status = typeof result.status === "string" ? result.status : undefined;
    this.finish(turn, {
      kind: "result",
      facts,
      result: {
        subtype: status,
        isError: status !== "SUCCESS",
        structuredOutput: result.structured_output,
        resultText: typeof result.response === "string" ? result.response : undefined,
        numTurns: typeof result.num_turns === "number" ? result.num_turns : undefined,
      },
    });
  }
}

/**
 * agy 의 {@code output} = MCP content 의 글 조각을 줄바꿈으로 이은 글 하나(실측 1.5.14 — create_documents = JSON 한 줄 + 📄 줄 + 알림 줄).
 * 통째로 JSON 이면 그대로, 아니면 줄마다 한 조각으로 되돌린다(그래야 JSON 조각의 created·카드가 읽힌다 — 게이트 ① 에서 잡음).
 */
export function agyContentParts(output: string): Array<{ type: "text"; text: string }> {
  try {
    JSON.parse(output);
    return [{ type: "text", text: output }];
  } catch {
    return output.split("\n").map((text) => ({ type: "text" as const, text }));
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
