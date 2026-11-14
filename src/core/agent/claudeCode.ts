import type { DaemonLog } from "../term/daemonLog";
import type { AgentAdapter, AgentAuthStatus, AgentSession, TurnOutcome } from "./agents";
import { AgentChild, detectByVersion, runToEnd, withDeadline, type AgentSpawn, type ChildExit } from "./child";
import { AINECTO_TOOL_PREFIX } from "./claudeArgs";
import { WriteFactsCollector } from "./documents";
import { AGENT_CALL_TIMEOUT_MS } from "./limits";
import type { AgentLogRecord } from "./log";

const CLAUDE = "claude";

export interface ClaudeCodeDeps {
  spawnImpl: AgentSpawn;
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: DaemonLog<AgentLogRecord>;
  /** 서버 tools/list 에서 readOnlyHint 가 아닌 도구 이름. */
  writeTools: ReadonlySet<string>;
  /** 운영이면 true — API 키로 돌 때만 받는다({@link requiresApiKey}). */
  requireApiKey: boolean;
  /** K5 고정 인자 — 글 상한(서버 값)과 이어 붙일 세션으로 만든다({@code claudeAgentArgs}). */
  args(input: { textMaxCharacters: number; resumeSessionId?: string }): string[];
}

/**
 * Claude Code 어댑터 — {@code claude -p --input-format stream-json} 상주(K5 인자). 인증은 {@code claude auth status --json}(모델 호출 0).
 * 짧은 확인 명령의 기한은 B1(짧은 호출 하나의 기한)을 같이 쓴다.
 */
export function claudeCodeAdapter(deps: ClaudeCodeDeps): AgentAdapter {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    detect: () => detectByVersion(deps.spawnImpl, CLAUDE, { cwd: deps.cwd, env: deps.env, timeoutMs: AGENT_CALL_TIMEOUT_MS }),
    async authStatus() {
      const run = await runToEnd(deps.spawnImpl, CLAUDE, ["auth", "status", "--json"],
        { cwd: deps.cwd, env: deps.env, timeoutMs: AGENT_CALL_TIMEOUT_MS });
      if (run.spawnError || run.timedOut) {
        return { ready: false, detail: run.spawnError ?? "timed out" };
      }
      return claudeAuthFromJson(run.stdout, run.code, run.stderrTail, hasApiKeyVariable(deps.env));
    },
    open: ({ conversationUuid, resumeRef, textMaxCharacters }) =>
      new ClaudeCodeSession(conversationUuid, resumeRef, deps.args({ textMaxCharacters, resumeSessionId: resumeRef }), deps),
  };
}

/** 키 변수가 있는가 — ★값은 읽지 않는다(있는지만). 실측: {@code claude -p} 는 이 변수가 있으면 그 키로 돈다(init {@code apiKeySource}). */
function hasApiKeyVariable(env: NodeJS.ProcessEnv): boolean {
  return (env.ANTHROPIC_API_KEY ?? "") !== "";
}

/**
 * {@code claude auth status --json} 출력 + 키 변수 유무 → 준비 여부(순수 함수). 로그인 안 됨이면 종료 코드가 0 이 아닐 수 있어 출력부터 본다.
 * ★실측(11-14): auth status 는 키 변수를 보이지 않는다(저장된 claude.ai 로그인만) — 그래서 키 변수가 있으면 API 키 모드로 본다.
 */
export function claudeAuthFromJson(stdout: string, code: number | null, stderrTail: string, apiKeyVariable: boolean): AgentAuthStatus {
  let parsed: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(stdout);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // 아래에서 이유를 싣는다.
  }
  if (apiKeyVariable) return { ready: true, mode: "apiKey", method: "ANTHROPIC_API_KEY" };
  if (!parsed) {
    return { ready: false, detail: `unreadable auth status (exit ${code ?? "-"})${stderrTail ? `: ${stderrTail}` : ""}` };
  }
  const ready = parsed.loggedIn === true;
  return {
    ready,
    ...(ready ? { mode: "subscription" as const } : {}),
    method: typeof parsed.authMethod === "string" ? parsed.authMethod : undefined,
    plan: typeof parsed.subscriptionType === "string" ? parsed.subscriptionType : undefined,
  };
}

interface Pending {
  resolve(outcome: TurnOutcome): void;
  facts: WriteFactsCollector;
}

/**
 * ★대화 하나에 붙은 Claude Code 프로세스 하나. 한 차례 = stdin 한 줄 → {@code result} 하나.
 * 쓰기 도구 결과의 문서·카드를 모은다(도구 이름은 tool_use id 로 잇는다).
 */
class ClaudeCodeSession implements AgentSession {
  readonly agent = "claude-code" as const;
  readonly resumed: boolean;
  sessionRef: string | undefined;
  private readonly child: AgentChild;
  private readonly toolNames = new Map<string, string>();
  private pending: Pending | undefined;
  private interrupts = 0;

  constructor(readonly conversationUuid: string, resumeRef: string | undefined, args: string[], private readonly deps: ClaudeCodeDeps) {
    this.resumed = resumeRef !== undefined;
    this.child = new AgentChild(deps.spawnImpl, CLAUDE, args, { cwd: deps.cwd, env: deps.env }, {
      line: (line) => this.onLine(line),
      exit: (exit) => this.onExit(exit),
    });
    deps.log.write({ event: "process_start", pid: this.child.pid, agent: this.agent, conversationUuid, resume: this.resumed });
  }

  get pid(): number {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.child.alive;
  }

  async send(text: string, timeoutMs: number): Promise<TurnOutcome> {
    const exit = this.child.exit;
    if (exit) return { kind: "exited", ...exit };
    const outcome = new Promise<TurnOutcome>((resolve) => {
      this.pending = { resolve, facts: new WriteFactsCollector() };
    });
    this.child.writeLine({ type: "user", message: { role: "user", content: text } });
    try {
      return await withDeadline<TurnOutcome>(outcome, timeoutMs, { kind: "timeout" });
    } finally {
      this.pending = undefined;
    }
  }

  /** 실측: {@code control_request interrupt} → 13ms 뒤 그 차례가 끝나고 같은 프로세스가 이어진다(증적 three-agents ⑦). */
  async interrupt(): Promise<void> {
    this.interrupts += 1;
    this.child.writeLine({ type: "control_request", request_id: `interrupt-${this.interrupts}`, request: { subtype: "interrupt" } });
  }

  async close(): Promise<void> {
    await this.child.stop();
  }

  private onExit(exit: ChildExit): void {
    this.deps.log.write({ event: "process_exit", pid: this.child.pid, agent: this.agent, conversationUuid: this.conversationUuid,
      code: exit.code, signal: exit.signal });
    this.finish({ kind: "exited", ...exit });
  }

  private finish(outcome: TurnOutcome): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(outcome);
  }

  private onLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.deps.log.write({ event: "bad_line", pid: this.child.pid, agent: this.agent, length: line.length });
      return;
    }
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      this.sessionRef = event.session_id;
      // 운영: 이 차례가 API 키로 돌지 않으면(구독 로그인) 그 자리에서 멈추고 프로세스를 내린다.
      const source = typeof event.apiKeySource === "string" ? event.apiKeySource : "none";
      this.deps.log.write({ event: "agent_auth_source", pid: this.child.pid, agent: this.agent, apiKeySource: source });
      if (this.deps.requireApiKey && source !== "ANTHROPIC_API_KEY") {
        this.deps.log.write({ event: "agent_auth_blocked", pid: this.child.pid, agent: this.agent, apiKeySource: source });
        this.finish({ kind: "authNotAllowed", detail: `apiKeySource ${source}` });
        void this.child.stop();
      }
      return;
    }
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (event.type === "assistant" && Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
          this.toolNames.set(part.id, part.name);
        }
      }
      return;
    }
    if (event.type === "user" && Array.isArray(content) && this.pending) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
        const name = this.toolNames.get(part.tool_use_id);
        if (!name?.startsWith(AINECTO_TOOL_PREFIX) || !this.deps.writeTools.has(name.slice(AINECTO_TOOL_PREFIX.length))) continue;
        this.pending.facts.add(part.content);
      }
      return;
    }
    if (event.type === "result") {
      if (typeof event.session_id === "string") this.sessionRef = event.session_id;
      this.finish({
        kind: "result",
        facts: this.pending?.facts.snapshot() ?? { documents: [], createdDocuments: [], cards: [] },
        result: {
          subtype: typeof event.subtype === "string" ? event.subtype : undefined,
          isError: event.is_error === true,
          structuredOutput: event.structured_output,
          resultText: typeof event.result === "string" ? event.result : undefined,
          numTurns: typeof event.num_turns === "number" ? event.num_turns : undefined,
          costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : undefined,
        },
      });
    }
  }
}
