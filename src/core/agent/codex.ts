import type { DaemonLog } from "../term/daemonLog";
import { agentReplySchema, AINECTO_CODEX_MCP_SERVER, type AgentAdapter, type AgentSession, type TurnOutcome } from "./agents";
import { AgentChild, detectByVersion, withDeadline, type AgentSpawn, type ChildExit } from "./child";
import {
  CODEX,
  codexAuthFromAccount,
  codexInitializeParams,
  codexOtherMcpServersOff,
  codexServerRequestAnswer,
  codexThreadResumeParams,
  codexThreadStartParams,
  codexTurnResult,
  codexTurnStartParams,
} from "./codexArgs";
import { TurnFactsCollector } from "./documents";
import { AGENT_CALL_TIMEOUT_MS, AGENT_STOP_WAIT_MS } from "./limits";
import type { AgentLogRecord } from "./log";

export interface CodexDeps {
  spawnImpl: AgentSpawn;
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: DaemonLog<AgentLogRecord>;
  /** 서버 tools/list 에서 readOnlyHint 가 아닌 도구 이름. */
  writeTools: ReadonlySet<string>;
  /** 대화용 app-server 인자({@code codexAppServerArgs}) — 브리지를 붙일 이름 붙은 에이전트(없으면 이름 없는 연결)로 만든다. */
  appServerArgs(agentName: string | undefined): string[];
  /** initialize 의 clientInfo.version. */
  clientVersion: string;
}

/**
 * Codex 어댑터 — {@code codex app-server}(JSON-RPC, 줄 하나 = 메시지 하나). 인증은 {@code account/read}(모델 호출 0).
 * 짧은 확인의 기한은 B1(짧은 호출 하나의 기한)을 같이 쓴다.
 */
export function codexAdapter(deps: CodexDeps): AgentAdapter {
  return {
    id: "codex",
    displayName: "Codex",
    detect: () => detectByVersion(deps.spawnImpl, CODEX, { cwd: deps.cwd, env: deps.env, timeoutMs: AGENT_CALL_TIMEOUT_MS }),
    async authStatus() {
      const server = startAppServer(deps, ["app-server"], {});
      try {
        const read = (async () => {
          await server.rpc.request("initialize", codexInitializeParams(deps.clientVersion));
          server.rpc.notify("initialized");
          return await server.rpc.request("account/read", { refreshToken: false });
        })();
        const result = await withDeadline<Record<string, unknown> | Error>(read.catch(toError), AGENT_CALL_TIMEOUT_MS,
          new Error("account/read timed out"));
        return result instanceof Error ? { ready: false, detail: result.message } : codexAuthFromAccount(result);
      } finally {
        await server.child.stop();
      }
    },
    open: ({ conversationUuid, resumeRef, textMaxCharacters, documentsMax, agentName }) =>
      new CodexSession(conversationUuid, resumeRef, agentReplySchema(textMaxCharacters, documentsMax), agentName, deps),
  };
}

/** config/read 실패 = 사용자 Codex 설정이 깨졌다(예: 같은 MCP 항목에 url·command — KAN-1617). 메시지는 Codex 원문 그대로. */
class CodexConfigError extends Error {}

interface Waiting {
  method: string;
  started: number;
  resolve(result: Record<string, unknown>): void;
  reject(error: Error): void;
}

/**
 * ★app-server JSON-RPC 의 한 입구. 요청마다 {@code agent_rpc} 1줄 + {@code agent_rpc_response} 1줄(같은 pid·id) — 응답이 오든,
 * 오류가 오든, 프로세스가 끝나든 응답 줄은 반드시 남는다. Codex 가 묻는 것(승인 등)은 묻지 않고 거절하고 남긴다.
 */
class CodexRpc {
  private nextId = 0;
  private readonly waiting = new Map<number, Waiting>();

  constructor(private readonly io: {
    /** 끝난 프로세스면 false. */
    write(message: unknown): boolean;
    pid(): number;
    log: DaemonLog<AgentLogRecord>;
    notification(method: string, params: Record<string, unknown>): void;
  }) {}

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.nextId += 1;
    const id = this.nextId;
    this.io.log.write({ event: "agent_rpc", pid: this.io.pid(), agent: "codex", id, method });
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { method, started: Date.now(), resolve, reject });
      if (!this.io.write({ id, method, params })) this.settle(id, new Error("codex is not running"));
    });
  }

  notify(method: string): void {
    this.io.write({ method });
  }

  onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.io.log.write({ event: "bad_line", pid: this.io.pid(), agent: "codex", length: line.length });
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    const params = message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>) : {};
    if (message.id !== undefined && method) {
      const answer = codexServerRequestAnswer(method);
      this.io.log.write({ event: "agent_server_request", pid: this.io.pid(), agent: "codex", method,
        answer: "result" in answer ? JSON.stringify(answer.result) : `error ${answer.error.code}` });
      this.io.write({ id: message.id, ...answer });
      return;
    }
    if (typeof message.id === "number") {
      const error = message.error as { message?: unknown } | undefined;
      if (error) {
        this.settle(message.id, new Error(typeof error.message === "string" ? error.message : JSON.stringify(error)));
      } else {
        this.settle(message.id, undefined,
          message.result && typeof message.result === "object" ? (message.result as Record<string, unknown>) : {});
      }
      return;
    }
    if (method) this.io.notification(method, params);
  }

  /** 프로세스가 끝났다 — 기다리던 요청 전부에 응답 줄을 남기고 거절한다. */
  failAll(reason: string): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, new Error(reason));
  }

  private settle(id: number, error: Error | undefined, result?: Record<string, unknown>): void {
    const waiting = this.waiting.get(id);
    if (!waiting) return;
    this.waiting.delete(id);
    this.io.log.write({ event: "agent_rpc_response", pid: this.io.pid(), agent: "codex", id, method: waiting.method,
      ok: error === undefined, ...(error ? { error: error.message } : {}), ms: Date.now() - waiting.started });
    if (error) waiting.reject(error);
    else waiting.resolve(result ?? {});
  }
}

/** app-server 하나를 띄우고 그 위의 RPC 를 잇는다. */
function startAppServer(
  deps: CodexDeps,
  args: string[],
  hooks: { notification?(method: string, params: Record<string, unknown>): void; exit?(exit: ChildExit): void },
): { child: AgentChild; rpc: CodexRpc } {
  const holder: { child?: AgentChild } = {};
  const rpc = new CodexRpc({
    write: (message) => holder.child?.writeLine(message) ?? false,
    pid: () => holder.child?.pid ?? -1,
    log: deps.log,
    notification: (method, params) => hooks.notification?.(method, params),
  });
  const child = new AgentChild(deps.spawnImpl, CODEX, args, { cwd: deps.cwd, env: deps.env }, {
    line: (line) => rpc.onLine(line),
    exit: (exit) => {
      rpc.failAll(`codex exited (code ${exit.code ?? "-"}${exit.signal ? `, ${exit.signal}` : ""})${exit.stderrTail ? `: ${exit.stderrTail}` : ""}`);
      hooks.exit?.(exit);
    },
    killed: (result) => deps.log.write({ event: "process_kill", pid: holder.child?.pid ?? -1, agent: CODEX, ...result }),
  });
  holder.child = child;
  return { child, rpc };
}

interface ActiveTurn {
  resolve(outcome: TurnOutcome): void;
  facts: TurnFactsCollector;
  id?: string;
  lastMessage?: string;
}

/**
 * ★대화 하나에 붙은 Codex app-server 하나 — initialize → thread/start(또는 thread/resume) → 차례마다 turn/start(outputSchema).
 * AiNecto 도구({@code mcpToolCall}, 서버 ainecto) 결과를 모으고(쓰기 도구는 문서·카드까지), 마지막 답 글({@code agentMessage})을 schema 값으로 읽는다.
 */
class CodexSession implements AgentSession {
  readonly agent = "codex" as const;
  readonly resumed: boolean;
  sessionRef: string | undefined;
  private readonly child: AgentChild;
  private readonly rpc: CodexRpc;
  /** 준비(initialize·thread) — 실패하면 그 오류. */
  private readonly started: Promise<Error | undefined>;
  private turn: ActiveTurn | undefined;
  /** 끝나지 않은 차례 — 기한을 넘긴 뒤에도 interrupt 할 수 있게 따로 둔다. */
  private runningTurnId: string | undefined;
  /** 준비가 끝났다(thread id 를 받음). */
  private ready = false;
  /** ★준비 중 멈춤(코드 리뷰 C2 P0-2) — 준비가 끝나지 않은 자식은 내리고, 기다리던 쪽(confirmedRef·send)을 바로 풀어 준다. */
  private stoppedBeforeStart = false;
  private releaseStop: () => void = () => {};
  private readonly stopRequested = new Promise<"stop">((resolve) => {
    this.releaseStop = () => resolve("stop");
  });
  /** 준비 끝 또는 준비 중 멈춤 — ★생성 때 한 번만 만든다(차례마다 race 를 걸어 쌓지 않는다 · 코드 리뷰 C2 r2 P2-2). */
  private readonly preparedOrStopped: Promise<Error | undefined | "stop">;

  constructor(
    readonly conversationUuid: string,
    resumeRef: string | undefined,
    private readonly replySchema: Record<string, unknown>,
    readonly agentName: string | undefined,
    private readonly deps: CodexDeps,
  ) {
    this.resumed = resumeRef !== undefined;
    const server = startAppServer(deps, deps.appServerArgs(agentName), {
      notification: (method, params) => this.onNotification(method, params),
      exit: (exit) => this.onExit(exit),
    });
    this.child = server.child;
    this.rpc = server.rpc;
    deps.log.write({ event: "process_start", pid: this.child.pid, agent: this.agent, conversationUuid, resume: this.resumed });
    this.started = this.start(resumeRef).then(() => {
      this.ready = true;
      return undefined;
    }, toError);
    this.preparedOrStopped = Promise.race([this.started, this.stopRequested]);
  }

  /** 준비(initialize → thread/resume·start)가 끝난 뒤 그 응답의 thread id — 준비가 실패했거나 준비 중 멈췄으면 undefined. ★turn/start 보다 먼저 온다. */
  async confirmedRef(): Promise<string | undefined> {
    const settled = await this.preparedOrStopped;
    return settled === undefined && !this.stoppedBeforeStart ? this.sessionRef : undefined;
  }

  get pid(): number {
    return this.child.pid;
  }

  /** ★준비 중 멈춘 세션은 자식이 아직 정리 중이어도 끝난 것으로 본다 — 다음 차례가 그 자식을 다시 쓰지 않는다(코드 리뷰 C2 r2 P0-1). */
  get alive(): boolean {
    return !this.stoppedBeforeStart && this.child.alive;
  }

  async send(text: string, timeoutMs: number): Promise<TurnOutcome> {
    const work = (async (): Promise<TurnOutcome> => {
      const failed = await this.preparedOrStopped;
      if (failed === "stop" || this.stoppedBeforeStart) {
        // 준비 중(또는 turn/start 전)에 멈춤 — 입력을 넣지 않는다. 재개 값은 지킨다(«끝남»이 아니다).
        return { kind: "result", facts: new TurnFactsCollector().snapshot(), result: { subtype: "interrupted_before_start", isError: true } };
      }
      if (failed) {
        // 준비가 안 되는 세션(없는 thread · 로그인 풀림 …)은 내린다 — 부른 쪽은 «끝남»으로 보고 재개 값을 버린다.
        await this.child.stop();
        const exit = this.child.exit;
        return { kind: "exited", code: exit?.code ?? null, signal: exit?.signal ?? null,
          stderrTail: [failed.message, exit?.stderrTail].filter(Boolean).join("\n"),
          ...(failed instanceof CodexConfigError ? { configError: failed.message } : {}) };
      }
      const exit = this.child.exit;
      if (exit || !this.sessionRef) return { kind: "exited", code: exit?.code ?? null, signal: exit?.signal ?? null, stderrTail: exit?.stderrTail ?? "" };
      const turn: ActiveTurn = { resolve: () => {}, facts: new TurnFactsCollector() };
      const outcome = new Promise<TurnOutcome>((resolve) => {
        turn.resolve = resolve;
      });
      this.turn = turn;
      try {
        const started = await this.rpc.request("turn/start",
          codexTurnStartParams(this.sessionRef, text, this.replySchema));
        const id = (started.turn as { id?: unknown } | undefined)?.id;
        if (typeof id === "string") {
          turn.id = id;
          this.runningTurnId = id;
        }
      } catch (error) {
        // 프로세스가 끝났으면 exit 이 «exited» 로 답한다. 살아 있는데 거절됐으면 그 차례만 실패다.
        if (this.child.alive) {
          this.finishTurn(turn, { kind: "result", facts: turn.facts.snapshot(),
            result: { subtype: "turn_start_failed", isError: true, resultText: toError(error).message } });
        }
      }
      return await outcome;
    })();
    try {
      return await withDeadline<TurnOutcome>(work, timeoutMs, { kind: "timeout" });
    } finally {
      this.turn = undefined;
    }
  }

  /** 실측: {@code turn/interrupt} → 12ms 뒤 {@code interrupted}, 같은 thread 가 이어진다(증적 three-agents ⑦). B6 안에 답이 없으면 그대로 둔다. */
  async interrupt(): Promise<void> {
    if (!this.ready && this.child.alive) {
      // 준비가 끝나지 않았다 — 멈출 turn 이 없다. 그 자식을 내리고 기다리던 쪽을 푼다(다음 요청은 새 프로세스).
      this.stoppedBeforeStart = true;
      this.releaseStop();
      await this.child.stop();
      return;
    }
    const turnId = this.runningTurnId;
    if (!turnId || !this.sessionRef || !this.child.alive) return;
    await withDeadline(this.rpc.request("turn/interrupt", { threadId: this.sessionRef, turnId }).then(() => undefined, () => undefined),
      AGENT_STOP_WAIT_MS, undefined);
  }

  async close(): Promise<void> {
    await this.child.stop();
  }

  private async start(resumeRef: string | undefined): Promise<void> {
    await this.rpc.request("initialize", codexInitializeParams(this.deps.clientVersion));
    this.rpc.notify("initialized");
    // 사용자 설정의 다른 MCP 서버(컴퓨터 조작 등)는 이 대화에서 끈다 — 이름은 이 프로세스가 읽은 설정에서.
    const read = await this.rpc.request("config/read", { cwd: this.deps.cwd }).catch((error: unknown) => {
      throw new CodexConfigError(toError(error).message);
    });
    const off = codexOtherMcpServersOff(read.config);
    this.deps.log.write({ event: "agent_mcp_servers_off", pid: this.child.pid, agent: this.agent, names: off.names });
    const method = resumeRef ? "thread/resume" : "thread/start";
    const result = await this.rpc.request(method,
      resumeRef ? codexThreadResumeParams(resumeRef, this.deps.cwd, off.config) : codexThreadStartParams(this.deps.cwd, off.config));
    const id = (result.thread as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string") throw new Error(`${method} returned no thread id`);
    this.sessionRef = id;
  }

  private onExit(exit: ChildExit): void {
    this.deps.log.write({ event: "process_exit", pid: this.child.pid, agent: this.agent, conversationUuid: this.conversationUuid,
      code: exit.code, signal: exit.signal });
    this.runningTurnId = undefined;
    if (this.turn) this.finishTurn(this.turn, { kind: "exited", ...exit });
  }

  private finishTurn(turn: ActiveTurn, outcome: TurnOutcome): void {
    if (this.turn === turn) this.turn = undefined;
    turn.resolve(outcome);
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === "mcpServer/startupStatus/updated") {
      if (typeof params.name === "string" && typeof params.status === "string" && params.status !== "starting") {
        this.deps.log.write({ event: "agent_mcp_server", pid: this.child.pid, agent: this.agent, name: params.name, status: params.status,
          ...(typeof params.error === "string" ? { error: params.error } : {}) });
      }
      return;
    }
    if (params.threadId !== this.sessionRef) return;
    const turn = this.turn;
    if (method === "turn/completed") {
      const completed = params.turn && typeof params.turn === "object" ? (params.turn as Record<string, unknown>) : {};
      if (completed.id === this.runningTurnId) this.runningTurnId = undefined;
      if (!turn || (turn.id !== undefined && completed.id !== turn.id)) return;
      this.finishTurn(turn, { kind: "result", facts: turn.facts.snapshot(), result: codexTurnResult(completed, turn.lastMessage) });
      return;
    }
    if (method !== "item/completed" || !turn) return;
    const item = params.item && typeof params.item === "object" ? (params.item as Record<string, unknown>) : {};
    if (item.type === "agentMessage" && typeof item.text === "string") {
      turn.lastMessage = item.text;
    } else if (item.type === "mcpToolCall" && item.server === AINECTO_CODEX_MCP_SERVER && typeof item.tool === "string"
        && item.status !== "failed") {   // 실패한 도구는 싣지 않는다(KAN-1229 ⑧)
      turn.facts.add((item.result as { content?: unknown } | null | undefined)?.content, this.deps.writeTools.has(item.tool));
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
