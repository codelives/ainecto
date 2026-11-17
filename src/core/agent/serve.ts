import type { DaemonLog } from "../term/daemonLog";
import { sleep } from "../async/sleep";
import { DEFAULT_AGENT, isAgentId, type AgentAdapter, type AgentId, type AgentSession, type TurnOutcome } from "./agents";
import { AgentCallError, type AgentHttp } from "./http";
import { AGENT_TURN_TIMEOUT_MS, nextRetryDelay } from "./limits";
import type { AgentLogRecord } from "./log";
import { agentPromptText, type AgentTurnContext } from "./prompt";
import { clip, replyForOutcome, stoppedReply, type AgentReply } from "./reply";
import type { AgentSessionMap } from "./sessions";
import type { AgentRunLog } from "./runs";
import { claimTodo, closeTodo, keepLease, resumeTodo, runTodo, TODO_KINDS, todosIn, type AgentTodo, type ClaimedTodo, type LeaseKeeper,
  type TodoOutcome } from "./todoRun";
import { toolsAs, type AgentIdentity, type AgentTools } from "./tools";

export interface AgentOffer {
  turnUuid: string;
  conversationUuid: string;
  text: string;
  /** 이 요청을 받을 Agent — 서버가 밝히지 않으면 {@link DEFAULT_AGENT}. 모르는 id 는 그대로 두고 «이 PC 에 없음»으로 답한다. */
  agent: string;
  /** 서버가 아는 맥락(대화의 프로젝트·열린 문서). */
  context?: AgentTurnContext;
}

export interface ServeDeps {
  http: AgentHttp;
  log: DaemonLog<AgentLogRecord>;
  sessions: AgentSessionMap;
  /** 이 PC 에 설치된 Agent 의 어댑터. */
  adapters: ReadonlyMap<AgentId, AgentAdapter>;
  /** open 에 알릴 Agent(설치된 것 · ready = 로그인 확인 · auth = 과금 주체). */
  agents: ReadonlyArray<{ id: AgentId; ready: boolean; auth?: string }>;
  hostName: string;
  /** open 에 알리는 판({@code CLI_VERSION_LABEL} — 로컬 빌드면 «-dev+<빌드>»). */
  cliVersion: string;
  /** open 에 알리는 빌드 식별(커밋 짧은 SHA) — 없으면 싣지 않는다. */
  cliBuild?: string;
  print(line: string): void;
  /** Ctrl+C 등 — 끊으면 link 를 닫고 끝낸다. */
  signal: AbortSignal;
  turnTimeoutMs?: number;
  /**
   * 에이전트 할 일(자동 실행된 칸반 카드 — KAN-1113)도 받는다. ★받는 신원은 서버가 open 응답에 종류마다 준다(agents[].agentUuid·name).
   * {@code agentName} = 폴더의 {@code .ainecto/agent.local}(선택) — 있으면 할 일을 돌리는 한 종류({@link folderKind})의 신원 이름으로
   * open 에 싣는다. 없으면 신원 이름 = 종류 id(서버가 정한다).
   */
  todos?: { tools: AgentTools; agentName?: string; runs?: AgentRunLog };
}

export interface ServeResult {
  exitCode: number;
  reason: string;
}

/**
 * open 에 알리는 이 CLI 의 기능 — 서버 {@code PcFeature} 의 id 와 같은 글(선 위의 계약). stop = poll 의 {@code stops} 를 읽고 STOPPED 로 답한다.
 * todos = 에이전트 할 일(자동 실행 카드)을 가져간다 — 할 일을 받는 serve 만 싣는다({@link pcFeatures}). ★서버는 이것을 알린 연결만 자동 실행의
 * «켜짐»으로 본다(옛 CLI 는 Chat 만 되고 할 일을 안 가져간다 — KAN-1113 Edwin #1890).
 */
export const PC_FEATURES = ["stop", "todos"] as const;
type PcFeature = (typeof PC_FEATURES)[number];

/** 이 serve 가 open 에 알릴 기능 — 할 일을 받지 않으면 todos 를 싣지 않는다(순수 함수). */
export function pcFeatures(takesTodos: boolean): PcFeature[] {
  return PC_FEATURES.filter((f) => f !== "todos" || takesTodos);
}

interface ServerLimits {
  pollHoldSeconds: number;
  textMaxCharacters: number;
  documentsMax: number;
}

/** 작업 줄 한 칸 — Chat 요청 또는 가져간 할 일. 둘 다 같은 실행기({@code runTurn})로 돈다. */
type Job =
  | { kind: "chat"; offer: AgentOffer }
  /** 가져간 서버 할 일(임대 있음) 또는 다시 켜서 잇는 카드(RESUME — 임대 없음). */
  | { kind: "todo"; todo: AgentTodo; identity: ServeIdentity; claimed?: ClaimedTodo; lease?: LeaseKeeper };

/** 서버가 그 종류에 이어 준 신원(open 응답 agents[]) — 할 일을 받는 단위. */
export interface ServeIdentity extends AgentIdentity {
  agentUuid: string;
}

/** Agent 한 차례 — 멈춤 표의 열쇠는 Chat 이면 turnUuid, 할 일이면 {@link todoKey}. */
interface TurnJob {
  key: string;
  turnUuid?: string;
  todoId?: string;
  conversationUuid: string;
  agent: string;
  text: string;
  context?: AgentTurnContext;
  /** ★누구로 부르나 — 할 일 차례는 이 serve 의 이름 붙은 에이전트, Chat 차례는 없음(이름 없는 연결 — 지금과 같다). */
  agentName?: string;
}

const todoKey = (todoId: string) => `todo:${todoId}`;

/** 할 일 complete 의 한 줄(사람이 알림함에서 본다) — 끝난 모양마다 고정 글. */
const TODO_NOTES: Readonly<Record<TodoOutcome, string>> = {
  review_requested: "Worked the card and asked for review.",
  decision_requested: "Asked for a decision on the card.",
  not_runnable: "The card is no longer in progress.",
  agent_failed: "The agent run failed; see the auto-run conversation.",
  stopped: "Stopped.",
};

/** 연결됨 표시 — serve 가 open 성공 뒤 찍는 줄의 앞머리. ★`ainecto start` 가 pc 세션 화면에서 이것을 기다린다(한 곳). */
export const SERVE_CONNECTED_PREFIX = "Connected to AiNecto as ";
/**
 * Agent 없음 — 이 PC 에 Claude Code·Codex 가 둘 다 없어 Agent 부분을 시작하지 않았다(원격이 허용이면 다리만 돈다). ★한 곳 —
 * pc 화면·`ainecto status`·start 의 출력이 이 문장을 쓴다.
 */
export const AGENT_MISSING_LINE = "Agent: no Claude Code or Codex on this PC — install one, then `ainecto` again.";
/** 다시 붙음 표시 — 서버가 link 를 잊어 다시 열었을 때. `ainecto stop` 은 이것도 «준비됨»으로 본다. */
export const SERVE_RECONNECTED_LINE = "AiNecto lost this connection (it may have restarted); connected again.";

/**
 * `ainecto agent serve` 본체(KAN-1075 설계 v3 1절). link 하나를 열고 poll 을 계속 돌린다(긴 요청 중에도 — «PC 켜짐» 유지).
 * ★요청은 {@code offer.agent} 의 어댑터로 간다. 세션은 Agent 마다 동시에 하나 — 같은 대화면 그 세션에 한 차례,
 * 다른 대화면 그 Agent 의 앞 세션을 내리고 (대화, Agent) 의 세션 값으로 재개한다. 다른 Agent 의 세션은 그대로 둔다.
 * ★받은 turnUuid 는 다시 넣지 않는다(서버가 답 올 때까지 같은 요청을 다시 준다 — K4).
 */
export async function runAgentServe(deps: ServeDeps): Promise<ServeResult> {
  const folderName = deps.todos?.agentName;
  const nameRefused = (error: unknown): boolean => error instanceof AgentCallError && error.status === 400 && error.code === "AGENT_NAME_INVALID";
  const nameRefusedMessage = (error: unknown) => `AiNecto did not accept the agent name «${folderName ?? ""}» in this folder's .ainecto/agent.local `
    + `(${error instanceof Error ? error.message : String(error)}). `
    + "Set a valid name with `ainecto init --agent NAME` (or delete .ainecto/agent.local), then run `ainecto start` again.";
  let opened: Record<string, unknown>;
  try {
    opened = await openLink(deps, openAgentsBody(deps.agents, folderName));
  } catch (error) {
    if (nameRefused(error)) {
      deps.print(nameRefusedMessage(error));
      return { exitCode: 1, reason: "agent_name_invalid" };
    }
    throw error;
  }
  /** ★바뀔 수 있다 — 서버가 link 를 잊으면(api 재시작) 다시 열어 새 linkId 로 잇는다({@link reopen}). */
  let linkId = String(opened.linkId);
  deps.http.useLinkToken(String(opened.linkToken));
  const limits = serverLimits(opened.limits);
  const displayName = (id: AgentId) => deps.adapters.get(id)?.displayName ?? id;
  const names = deps.agents.map((a) => displayName(a.id)).join(" / ");
  deps.print(`${SERVE_CONNECTED_PREFIX}${deps.hostName}. Requests to «My agent» in AiNecto Chat now run in ${names} on this machine. Press Ctrl+C to stop.`);
  // ★할 일 신원 = open 응답의 종류별 신원(이 PC 에 어댑터가 있는 것만). 신원이 없는 종류(준비 안 됨·AGENT_LIMIT)는 받지 않는다.
  const { identities, refused } = identitiesIn(opened.agents, deps.adapters);
  for (const r of refused) {
    deps.print(`${displayName(r.agent)}: AiNecto refused its agent identity (${r.error}), so auto-run cards for ${displayName(r.agent)} are not taken here.`
      + (r.error === "AGENT_LIMIT" ? " Archive an agent you no longer use in AiNecto, then run `ainecto start` again." : ""));
  }
  const todos = deps.todos && identities.length > 0 ? { tools: deps.todos.tools, runs: deps.todos.runs, identities } : undefined;
  if (todos) {
    deps.print(`Auto-run cards handed to ${identities.map((i) => `${displayName(i.agent)} (${i.name})`).join(" and ")} run here.`);
  } else if (deps.todos && refused.length === 0) {
    deps.print("Auto-run cards are not taken here: AiNecto did not give this connection an agent identity (update the server, or sign in to Claude Code or Codex).");
  }

  const stopController = new AbortController();
  let stopReason: string | undefined;
  let exitCode = 0;
  let wakeWorker: (() => void) | undefined;
  const live = new Map<AgentId, AgentSession>();
  const received = new Set<string>();
  const queue: Job[] = [];
  /** 멈출 차례(열쇠 = {@link TurnJob.key}) — 웹 «중단»(turnUuid) · 임대를 잃은 할 일. 진행 중이면 멈추고, 시작 전이면 돌리지 않는다. */
  const stopping = new Set<string>();
  /** 지금 Agent 에 들어간 차례(없으면 undefined) — 멈춤 지시가 이것을 멈춘다. */
  let current: { key: string; session: AgentSession } | undefined;
  /** ★로컬 잠금 — 지금 돌고 있거나 줄에 선 할 일의 카드(카드마다 하나 · serve 에 한 번에 하나). */
  let todoInFlight: string | undefined;
  let wakeTodos: (() => void) | undefined;

  const requestStop = (key: string) => {
    if (stopping.has(key)) return;
    stopping.add(key);
    const running = current?.key === key;
    deps.log.write({ event: "stop_request", turnUuid: key, running, queued: queue.some((j) => jobKey(j) === key) });
    if (running) void current?.session.interrupt();
  };

  const stop = (reason: string, code: number, message?: string) => {
    if (stopReason) return;
    stopReason = reason;
    exitCode = code;
    if (message) deps.print(message);
    stopController.abort();
    wakeWorker?.();
    wakeTodos?.();
    for (const session of live.values()) void session.close();
  };
  const onUserStop = () => stop("signal", 0, "Stopping…");
  if (deps.signal.aborted) onUserStop();
  deps.signal.addEventListener("abort", onUserStop, { once: true });

  /**
   * 로그인이 막혔다 — 다시 하지 않는다. ★LINK_NOT_FOUND(서버가 link 를 잊음 — api 재시작)는 여기서 멈추지 않는다: poll 이 {@link reopen} 한다.
   * 다른 호출(reply 등)은 그 답만 버린다 — 서버가 재시작으로 그 차례도 잊었다.
   */
  const stopOnFatal = (error: AgentCallError) => {
    if (error.status === 401 || error.status === 403) {
      stop("auth", 1, `AiNecto refused the CLI sign-in (${error.code ?? error.status}). Run \`ainecto auth login\` and start again.`);
    }
  };

  /**
   * 다시 열기 — 같은 프로세스에서 open 을 다시 해 새 linkId·link 토큰으로 잇는다(term remote 의 REMOTE_NOT_FOUND 와 같은 원리, 사용자 «자동해줘»).
   * 연속 시도는 B2(nextRetryDelay — 첫 시도는 바로). ★open 이 성공해도 그 link 의 poll 이 한 번 성공하기 전까지는 간격을 이어 센다 —
   * 열자마자 또 잊히는 고리도 간격이 벌어진다. 거절(4xx)이면 끝: 로그인(401/403)·이름 거절·그 밖.
   */
  let reopenDelay: number | undefined;
  let reopenAttempts = 0;
  const reopen = async (): Promise<void> => {
    const previousLinkId = linkId;
    while (!stopReason) {
      if (reopenAttempts > 0) {
        reopenDelay = nextRetryDelay(reopenDelay);
        await sleep(reopenDelay, stopController.signal);
        if (stopReason) return;
      }
      reopenAttempts += 1;
      let again: Record<string, unknown>;
      try {
        again = await openLink(deps, openAgentsBody(deps.agents, folderName));
      } catch (error) {
        if (stopReason) return;
        if (error instanceof AgentCallError && !error.retryable) {
          if (nameRefused(error)) {
            stop("agent_name_invalid", 1, nameRefusedMessage(error));
          } else if (error.status === 401 || error.status === 403) {
            stopOnFatal(error);
          } else {
            stop("reopen_refused", 1, `AiNecto refused to reconnect this PC (${error.code ?? error.status}): ${error.message}`);
          }
          return;
        }
        continue;
      }
      linkId = String(again.linkId);
      deps.http.useLinkToken(String(again.linkToken));
      deps.log.write({ event: "agent_reopened", reason: "LINK_NOT_FOUND", previousLinkId, linkId, attempts: reopenAttempts });
      deps.print(SERVE_RECONNECTED_LINE);
      return;
    }
  };

  const pollLoop = (async () => {
    let delay: number | undefined;
    while (!stopReason) {
      try {
        const res = await deps.http.call("poll", { linkId }, { holdMs: limits.pollHoldSeconds * 1000, signal: stopController.signal });
        delay = undefined;
        reopenDelay = undefined;
        reopenAttempts = 0;
        if (res.state === "CLOSED") {
          stop("replaced", 1, "Another PC connected as your agent, so this one stopped.");
          return;
        }
        for (const offer of offersIn(res)) {
          const duplicate = received.has(offer.turnUuid);
          deps.log.write({ event: "offer", turnUuid: offer.turnUuid, conversationUuid: offer.conversationUuid, agent: offer.agent, duplicate });
          if (duplicate) continue;
          received.add(offer.turnUuid);
          queue.push({ kind: "chat", offer });
          wakeWorker?.();
        }
        for (const turnUuid of stopsIn(res)) requestStop(turnUuid);
      } catch (error) {
        if (stopReason) return;
        if (error instanceof AgentCallError && error.code === "LINK_NOT_FOUND") {
          await reopen();
          continue;
        }
        if (error instanceof AgentCallError && !error.retryable) {
          stopOnFatal(error);
          if (stopReason) return;
        }
        delay = nextRetryDelay(delay);
        await sleep(delay, stopController.signal);
      }
    }
  })();

  /**
   * 그 Agent 의 이 대화 세션 — 다른 대화·다른 연결 이름의 세션이거나 끝났으면 내리고 새로(재개 값이 있으면 재개 — 이름이 바뀌어도
   * 같은 대화의 맥락은 잇는다).
   */
  const sessionFor = async (adapter: AgentAdapter, conversationUuid: string, agentName: string | undefined): Promise<AgentSession> => {
    const existing = live.get(adapter.id);
    if (existing && existing.conversationUuid === conversationUuid && existing.agentName === agentName && existing.alive) return existing;
    if (existing) {
      live.delete(adapter.id);
      await existing.close();
    }
    const session = adapter.open({ conversationUuid, resumeRef: deps.sessions.get(conversationUuid, adapter.id),
      textMaxCharacters: limits.textMaxCharacters, ...(agentName ? { agentName } : {}) });
    live.set(adapter.id, session);
    return session;
  };

  const runTurn = async (offer: TurnJob): Promise<AgentReply> => {
    const started = Date.now();
    const adapter = isAgentId(offer.agent) ? deps.adapters.get(offer.agent) : undefined;
    let session: AgentSession | undefined;
    let outcome: TurnOutcome | undefined;
    let reply: AgentReply | undefined;
    let failure: string | undefined;
    try {
      try {
        session = adapter ? await sessionFor(adapter, offer.conversationUuid, offer.agentName) : undefined;
      } finally {
        deps.log.write({ event: "agent_request", turnUuid: offer.turnUuid, todoId: offer.todoId, agent: offer.agent,
          conversationUuid: offer.conversationUuid, pid: session?.pid ?? -1, textLength: offer.text.length });
      }
      if (stopping.has(offer.key)) {
        reply = stoppedReply(undefined, limits);   // 시작 전에 멈춤 — 돌리지 않는다
        return reply;
      }
      if (!adapter || !session) {
        failure = "agent not installed";
        reply = { status: "FAILED", errorCode: "AGENT_NOT_INSTALLED", documentUuids: [],
          reply: clip(`이 PC 에는 «${offer.agent}» 가 설치되어 있지 않아요.`, limits.textMaxCharacters) };
        return reply;
      }
      current = { key: offer.key, session };
      try {
        outcome = await session.send(agentPromptText(offer.text, offer.context), deps.turnTimeoutMs ?? AGENT_TURN_TIMEOUT_MS);
      } finally {
        current = undefined;
      }
      if (outcome.kind === "timeout") {
        // 그 차례를 먼저 멈추고(더 쓰지 않게) 프로세스를 내린다 — 다음 요청은 새 프로세스.
        await session.interrupt();
        await session.close();
      }
      if (outcome.kind !== "result") {
        if (live.get(adapter.id) === session) live.delete(adapter.id);
        // 이어 붙인 세션으로 떴다가 끝났다 — 다음 요청은 새 세션으로(같은 실패를 되풀이하지 않게).
        if (session.resumed) await deps.sessions.forget(offer.conversationUuid, adapter.id);
      } else if (session.sessionRef) {
        await deps.sessions.set(offer.conversationUuid, adapter.id, session.sessionRef);
      }
      // 멈춘 차례 — 세션은 살아 있고(재개 값도 위에서 저장) 다음 요청은 같은 세션으로 «이어서» 간다.
      reply = stopping.has(offer.key) ? stoppedReply(outcome, limits) : replyForOutcome(outcome, limits, adapter.displayName);
      return reply;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      reply = { status: "FAILED", errorCode: "AGENT_INTERNAL", reply: clip(`The PC agent failed: ${failure}`, limits.textMaxCharacters), documentUuids: [] };
      return reply;
    } finally {
      const result = outcome?.kind === "result" ? outcome.result : undefined;
      deps.log.write({
        event: "agent_response",
        turnUuid: offer.turnUuid,
        todoId: offer.todoId,
        agent: offer.agent,
        ms: Date.now() - started,
        outcome: outcome?.kind ?? `error: ${failure ?? "unknown"}`,
        status: reply?.status ?? "FAILED",
        errorCode: reply?.errorCode,
        subtype: result?.subtype,
        sessionId: session?.sessionRef,
        documents: reply?.documentUuids.length ?? 0,
        createdDocuments: reply?.createdDocumentUuids?.length ?? 0,
        cards: reply?.cardUuids?.length ?? 0,
        numTurns: result?.numTurns,
        costUsd: result?.costUsd,
      });
    }
  };

  const sendReply = async (offer: AgentOffer, reply: AgentReply) => {
    let delay: number | undefined;
    for (;;) {
      try {
        await deps.http.call("reply", {
          linkId,
          turnUuid: offer.turnUuid,
          conversationUuid: offer.conversationUuid,
          status: reply.status,
          reply: reply.reply,
          documentUuids: reply.documentUuids,
          ...(reply.createdDocumentUuids ? { createdDocumentUuids: reply.createdDocumentUuids } : {}),
          ...(reply.cardUuids ? { cardUuids: reply.cardUuids } : {}),
          ...(reply.errorCode ? { errorCode: reply.errorCode } : {}),
        }, { turnUuid: offer.turnUuid, signal: stopController.signal });
        return;
      } catch (error) {
        if (stopReason) return;
        if (error instanceof AgentCallError && !error.retryable) {
          stopOnFatal(error);   // 그 밖의 4xx(남의 대화·없는 turn)는 이 답만 버린다 — 이유는 응답 줄에 있다
          return;
        }
        delay = nextRetryDelay(delay);
        await sleep(delay, stopController.signal);
      }
    }
  };

  /** 할 일 한 건 — 같은 실행기(runTurn) · ★그 할 일 신원의 종류 어댑터 · 브리지 이름 = 그 신원. 끝나면 잠금을 풀고 할 일 줄을 깨운다. */
  const runTodoJob = async (job: Extract<Job, { kind: "todo" }>) => {
    const t = todos!;
    const { claimed, identity } = job;
    const runs = t.runs;
    let outcome: TodoOutcome | undefined;
    try {
      outcome = await runTodo({
        tools: toolsAs(t.tools, identity),
        ...(runs ? { runs: { started: (cardUuid, workId) => runs.started(cardUuid, workId, identity.agent),
          finished: (cardUuid) => runs.finished(cardUuid) } } : {}),
        log: deps.log,
        textMaxCharacters: limits.textMaxCharacters,
        signal: stopController.signal,
        runAgent: ({ todoId, conversationUuid, text }) =>
          runTurn({ key: todoKey(todoId), todoId, conversationUuid, agent: identity.agent, text, agentName: identity.name }),
      }, job.todo);
    } catch {
      // 이유는 todo_run_result 줄에 — 임대(또는 runs.json 줄)는 그대로 두어 다시 가져간다.
    } finally {
      job.lease?.stop();
    }
    if (claimed && (stopReason || outcome === "stopped")) {
      await closeTodo(toolsAs(t.tools, identity), deps.log, claimed, "release");
    } else if (claimed && outcome !== undefined && claimed.todo.kind === "DECISION_ANSWERED") {
      // 카드 배정 할 일은 수락이 닫았다 — 답을 받은 할 일은 다 돌았으니 닫는다.
      await closeTodo(toolsAs(t.tools, identity), deps.log, claimed, "complete", TODO_NOTES[outcome]);
    }
    todoInFlight = undefined;
    wakeTodos?.();
  };

  const worker = (async () => {
    while (!stopReason) {
      const job = queue.shift();
      if (!job) {
        await new Promise<void>((resolve) => {
          wakeWorker = resolve;
        });
        wakeWorker = undefined;
        continue;
      }
      if (job.kind === "todo") {
        await runTodoJob(job);
        continue;
      }
      const reply = await runTurn({ key: job.offer.turnUuid, ...job.offer });
      if (!stopReason) await sendReply(job.offer, reply);
    }
  })();

  /**
   * 그 신원의 열린 할 일에서 하나를 가져간다(한 번에 하나) — 남이 쥔 것은 건너뛰고 다음 것. 가져갔으면 true. 도구 실패는 던진다(다음 주기에 다시).
   * 목록·임대·그 뒤 모든 호출이 그 신원으로 간다({@code agent: <agentUuid>}).
   */
  const takeTodo = async (identity: ServeIdentity): Promise<boolean> => {
    const tools = toolsAs(todos!.tools, identity);
    let after: string | undefined;
    do {
      const page = todosIn(await tools.call("list_agent_todos",
        { state: ["OPEN"], kinds: [...TODO_KINDS], agent: identity.agentUuid, ...(after ? { after } : {}) }));
      for (const todo of page.items) {
        if (stopReason) return false;
        const claimed = await claimTodo(tools, deps.log, todo);
        if (!claimed) continue;
        todoInFlight = todo.cardUuid;
        const lease = keepLease(tools, deps.log, claimed, () => requestStop(todoKey(todo.todoId)));
        queue.push({ kind: "todo", todo, identity, claimed, lease });
        wakeWorker?.();
        return true;
      }
      after = page.next;
    } while (after && !stopReason);
    return false;
  };

  /** 할 일 줄 — ★주기는 Chat poll 과 같은 값(서버가 준 pollHoldSeconds). 한 건이 끝나면 바로 다음 것을 본다. */
  const todoLoop = (async () => {
    if (!todos) return;
    // 이 PC 가 돌다 끊긴 카드(runs.json) 먼저 — 그 카드를 돌던 종류의 신원으로. 잇는지는 runTodo 가 서버의 지금 카드로 판정한다.
    // 그 종류의 신원이 지금 없으면(그 Agent 를 못 씀) 줄을 그대로 두고 건너뛴다.
    let resumes: Array<{ todo: AgentTodo; identity: ServeIdentity }> = [];
    try {
      resumes = todos.runs ? (await todos.runs.load()).flatMap((entry) => {
        const identity = todos.identities.find((i) => i.agent === (entry.agent ?? todos.identities[0]?.agent));
        return identity ? [{ todo: resumeTodo(entry), identity }] : [];
      }) : [];
    } catch {
      // 비운 파일을 못 썼다 — 이어 가기만 못 할 뿐(이유는 runs_load 줄).
    }
    /** 다음에 먼저 볼 신원 — 종류 둘이 번갈아 기회를 얻게. */
    let turn = 0;
    while (!stopReason) {
      if (!todoInFlight) {
        const resume = resumes.shift();
        if (resume) {
          todoInFlight = resume.todo.cardUuid;
          queue.push({ kind: "todo", todo: resume.todo, identity: resume.identity });
          wakeWorker?.();
        } else {
          for (let i = 0; i < todos.identities.length && !stopReason; i += 1) {
            const identity = todos.identities[(turn + i) % todos.identities.length]!;
            try {
              if (await takeTodo(identity)) {
                turn = (turn + i + 1) % todos.identities.length;
                break;
              }
            } catch {
              // 이유는 도구 응답 줄에 — 다음 신원·다음 주기에 다시.
            }
          }
        }
      }
      if (stopReason) return;
      await new Promise<void>((resolve) => {
        wakeTodos = resolve;
        void sleep(limits.pollHoldSeconds * 1000, stopController.signal).then(resolve);
      });
      wakeTodos = undefined;
    }
  })();

  await Promise.allSettled([pollLoop, worker, todoLoop]);
  // 돌지 못하고 줄에 남은 할 일 — 놓아서 다음에 켜면 바로 가져가게.
  for (const job of queue.splice(0)) {
    if (job.kind !== "todo" || !job.claimed) continue;
    job.lease?.stop();
    await closeTodo(toolsAs(todos!.tools, job.identity), deps.log, job.claimed, "release");
  }
  deps.signal.removeEventListener("abort", onUserStop);
  await Promise.all([...live.values()].map((session) => session.close()));
  if (stopReason === "signal") {
    try {
      await deps.http.call("close", { linkId });
    } catch {
      // 닫기 실패 — 서버는 A2 뒤 «PC 꺼짐»으로 본다. 이유는 응답 줄에 있다.
    }
  }
  return { exitCode, reason: stopReason ?? "unknown" };
}

function jobKey(job: Job): string {
  return job.kind === "chat" ? job.offer.turnUuid : todoKey(job.todo.todoId);
}

function serverLimits(value: unknown): ServerLimits {
  const v = (value ?? {}) as Record<string, unknown>;
  const num = (key: string) => {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`The server did not send limits.${key}; update the CLI or the server.`);
    }
    return n;
  };
  return { pollHoldSeconds: num("pollHoldSeconds"), textMaxCharacters: num("textMaxCharacters"), documentsMax: num("documentsMax") };
}

/**
 * link 를 연다 — 이 CLI 의 기능(features)을 알린다. ★옛 서버는 open 본문이 닫혀 있어 features 를 400 INVALID 로 거절한다 → 그때만
 * features 없이 한 번 더 연다(옛 서버는 멈춤 지시를 보내지 않는다).
 */
async function openLink(deps: ServeDeps, agents: ReadonlyArray<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const base = { hostName: deps.hostName, cliVersion: deps.cliVersion };
  const named = agents.some((a) => a.name !== undefined);
  const unnamed = agents.map(({ name: _name, ...rest }) => rest);
  const features = pcFeatures(deps.todos !== undefined);
  const older = features.filter((f) => f !== "todos");
  // 옛 서버는 open 본문이 닫혀 있다 — 모르는 칸(features 의 todos · agents[].name · features)은 400 INVALID. 새 칸부터 하나씩 덜어 다시 연다.
  // todos 를 모르는 서버는 할 일 신원은 주더라도 자동 실행 대상을 가리지 않는다 — 그때도 할 일은 받는다(그 서버가 예전처럼 맡긴다).
  // cliBuild(KAN-1113 #1890 D)를 모르는 서버는 그 칸만 빼고 다시 연다 — 아래 단계는 모두 cliBuild 없이.
  const attempts: Array<{ body: Record<string, unknown>; dropped?: string }> = [
    ...(deps.cliBuild ? [{ body: { ...base, cliBuild: deps.cliBuild, agents, features } }] : []),
    { body: { ...base, agents, features }, ...(deps.cliBuild ? { dropped: "cliBuild" } : {}) },
    ...(older.length < features.length ? [{ body: { ...base, agents, features: older }, dropped: "features.todos" }] : []),
    ...(named ? [{ body: { ...base, agents: unnamed, features: older }, dropped: "agents.name" }] : []),
    { body: { ...base, agents: unnamed }, dropped: "features" },
  ];
  for (let i = 0; ; i += 1) {
    const attempt = attempts[i]!;
    if (attempt.dropped) deps.log.write({ event: "open_without_features", features: [attempt.dropped] });
    try {
      return await deps.http.call("open", attempt.body);
    } catch (error) {
      const old = error instanceof AgentCallError && error.status === 400 && error.code === "INVALID";
      if (!old || i === attempts.length - 1) throw error;
    }
  }
}

/** 폴더 이름(agent.local)을 붙일 한 종류 — 준비된 서버 기본 Agent, 없으면 처음 준비된 것(순수 함수). */
export function folderKind(agents: ReadonlyArray<{ id: AgentId; ready: boolean }>): AgentId | undefined {
  return agents.find((a) => a.ready && a.id === DEFAULT_AGENT)?.id ?? agents.find((a) => a.ready)?.id;
}

/** open 의 agents[] — 폴더 이름은 {@link folderKind} 한 종류에만(계약 5-1). 순수 함수. */
export function openAgentsBody(agents: ReadonlyArray<{ id: AgentId; ready: boolean; auth?: string }>,
  folderName: string | undefined): Array<Record<string, unknown>> {
  const kind = folderName ? folderKind(agents) : undefined;
  return agents.map((a) => ({ id: a.id, ready: a.ready, ...(a.auth ? { auth: a.auth } : {}), ...(a.id === kind ? { name: folderName } : {}) }));
}

/**
 * open 응답 agents[] → 할 일을 받을 신원(agentUuid·name 이 있고 이 PC 에 어댑터가 있는 종류) · 신원을 못 받은 종류의 이유(순수 함수).
 * 옛 서버는 이 칸이 없다 → 신원 0.
 */
export function identitiesIn(value: unknown, adapters: ReadonlyMap<AgentId, unknown>): {
  identities: ServeIdentity[];
  refused: Array<{ agent: AgentId; error: string }>;
} {
  const identities: ServeIdentity[] = [];
  const refused: Array<{ agent: AgentId; error: string }> = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const a = (raw ?? {}) as Record<string, unknown>;
    if (!isAgentId(a.id) || !adapters.has(a.id)) continue;
    if (typeof a.agentUuid === "string" && typeof a.name === "string") {
      identities.push({ agent: a.id, agentUuid: a.agentUuid, name: a.name });
    } else if (typeof a.error === "string") {
      refused.push({ agent: a.id, error: a.error });
    }
  }
  return { identities, refused };
}

/** poll 의 멈출 turn — 옛 서버는 이 칸이 없다. */
function stopsIn(res: Record<string, unknown>): string[] {
  return Array.isArray(res.stops) ? res.stops.filter((t): t is string => typeof t === "string") : [];
}

function offersIn(res: Record<string, unknown>): AgentOffer[] {
  if (!Array.isArray(res.offers)) return [];
  return res.offers.flatMap((o) => {
    const offer = o as Record<string, unknown>;
    return typeof offer.turnUuid === "string" && typeof offer.conversationUuid === "string" && typeof offer.text === "string"
      ? [{
        turnUuid: offer.turnUuid,
        conversationUuid: offer.conversationUuid,
        text: offer.text,
        agent: offer.agent === undefined || offer.agent === null ? DEFAULT_AGENT : String(offer.agent),
        context: offer.context && typeof offer.context === "object" ? (offer.context as AgentTurnContext) : undefined,
      }]
      : [];
  });
}
