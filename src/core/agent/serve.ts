import type { DaemonLog } from "../term/daemonLog";
import { DEFAULT_AGENT, isAgentId, type AgentAdapter, type AgentId, type AgentSession, type TurnOutcome } from "./agents";
import { AgentCallError, type AgentHttp } from "./http";
import { AGENT_TURN_TIMEOUT_MS, nextRetryDelay } from "./limits";
import type { AgentLogRecord } from "./log";
import { agentPromptText, type AgentTurnContext } from "./prompt";
import { clip, replyForOutcome, type AgentReply } from "./reply";
import type { AgentSessionMap } from "./sessions";

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
  /** open 에 알릴 Agent(설치된 것 · ready = 로그인 확인). */
  agents: ReadonlyArray<{ id: AgentId; ready: boolean }>;
  hostName: string;
  cliVersion: string;
  print(line: string): void;
  /** Ctrl+C 등 — 끊으면 link 를 닫고 끝낸다. */
  signal: AbortSignal;
  turnTimeoutMs?: number;
}

export interface ServeResult {
  exitCode: number;
  reason: string;
}

interface ServerLimits {
  pollHoldSeconds: number;
  textMaxCharacters: number;
  documentsMax: number;
}

/**
 * `ainecto agent serve` 본체(KAN-1075 설계 v3 1절). link 하나를 열고 poll 을 계속 돌린다(긴 요청 중에도 — «PC 켜짐» 유지).
 * ★요청은 {@code offer.agent} 의 어댑터로 간다. 세션은 Agent 마다 동시에 하나 — 같은 대화면 그 세션에 한 차례,
 * 다른 대화면 그 Agent 의 앞 세션을 내리고 (대화, Agent) 의 세션 값으로 재개한다. 다른 Agent 의 세션은 그대로 둔다.
 * ★받은 turnUuid 는 다시 넣지 않는다(서버가 답 올 때까지 같은 요청을 다시 준다 — K4).
 */
export async function runAgentServe(deps: ServeDeps): Promise<ServeResult> {
  const opened = await deps.http.call("open", { hostName: deps.hostName, cliVersion: deps.cliVersion, agents: deps.agents });
  const linkId = String(opened.linkId);
  deps.http.useLinkToken(String(opened.linkToken));
  const limits = serverLimits(opened.limits);
  const names = deps.agents.map((a) => deps.adapters.get(a.id)?.displayName ?? a.id).join(" / ");
  deps.print(`Connected to AiNecto as ${deps.hostName}. Requests to «My agent» in AiNecto Chat now run in ${names} on this machine. Press Ctrl+C to stop.`);

  const stopController = new AbortController();
  let stopReason: string | undefined;
  let exitCode = 0;
  let wakeWorker: (() => void) | undefined;
  const live = new Map<AgentId, AgentSession>();
  const received = new Set<string>();
  const queue: AgentOffer[] = [];

  const stop = (reason: string, code: number, message?: string) => {
    if (stopReason) return;
    stopReason = reason;
    exitCode = code;
    if (message) deps.print(message);
    stopController.abort();
    wakeWorker?.();
    for (const session of live.values()) void session.close();
  };
  const onUserStop = () => stop("signal", 0, "Stopping…");
  if (deps.signal.aborted) onUserStop();
  deps.signal.addEventListener("abort", onUserStop, { once: true });

  /** 서버가 더는 이 link 를 모른다 · 로그인이 막혔다 — 다시 하지 않는다. */
  const stopOnFatal = (error: AgentCallError) => {
    if (error.code === "LINK_NOT_FOUND") {
      stop("link_not_found", 1, "This connection ended (the server restarted, or the link was closed). Run `ainecto agent serve` again.");
    } else if (error.status === 401 || error.status === 403) {
      stop("auth", 1, `AiNecto refused the CLI sign-in (${error.code ?? error.status}). Run \`ainecto auth login\` and start again.`);
    }
  };

  const pollLoop = (async () => {
    let delay: number | undefined;
    while (!stopReason) {
      try {
        const res = await deps.http.call("poll", { linkId }, { holdMs: limits.pollHoldSeconds * 1000, signal: stopController.signal });
        delay = undefined;
        if (res.state === "CLOSED") {
          stop("replaced", 1, "Another PC connected as your agent, so this one stopped.");
          return;
        }
        for (const offer of offersIn(res)) {
          const duplicate = received.has(offer.turnUuid);
          deps.log.write({ event: "offer", turnUuid: offer.turnUuid, conversationUuid: offer.conversationUuid, agent: offer.agent, duplicate });
          if (duplicate) continue;
          received.add(offer.turnUuid);
          queue.push(offer);
          wakeWorker?.();
        }
      } catch (error) {
        if (stopReason) return;
        if (error instanceof AgentCallError && !error.retryable) {
          stopOnFatal(error);
          if (stopReason) return;
        }
        delay = nextRetryDelay(delay);
        await sleep(delay, stopController.signal);
      }
    }
  })();

  /** 그 Agent 의 이 대화 세션 — 다른 대화의 세션이거나 끝났으면 내리고 새로(재개 값이 있으면 재개). */
  const sessionFor = async (adapter: AgentAdapter, conversationUuid: string): Promise<AgentSession> => {
    const existing = live.get(adapter.id);
    if (existing && existing.conversationUuid === conversationUuid && existing.alive) return existing;
    if (existing) {
      live.delete(adapter.id);
      await existing.close();
    }
    const session = adapter.open({ conversationUuid, resumeRef: deps.sessions.get(conversationUuid, adapter.id),
      textMaxCharacters: limits.textMaxCharacters });
    live.set(adapter.id, session);
    return session;
  };

  const runTurn = async (offer: AgentOffer): Promise<AgentReply> => {
    const started = Date.now();
    const adapter = isAgentId(offer.agent) ? deps.adapters.get(offer.agent) : undefined;
    let session: AgentSession | undefined;
    let outcome: TurnOutcome | undefined;
    let reply: AgentReply | undefined;
    let failure: string | undefined;
    try {
      try {
        session = adapter ? await sessionFor(adapter, offer.conversationUuid) : undefined;
      } finally {
        deps.log.write({ event: "agent_request", turnUuid: offer.turnUuid, agent: offer.agent, conversationUuid: offer.conversationUuid,
          pid: session?.pid ?? -1, textLength: offer.text.length });
      }
      if (!adapter || !session) {
        failure = "agent not installed";
        reply = { status: "FAILED", errorCode: "AGENT_NOT_INSTALLED", documentUuids: [],
          reply: clip(`이 PC 에는 «${offer.agent}» 가 설치되어 있지 않아요.`, limits.textMaxCharacters) };
        return reply;
      }
      outcome = await session.send(agentPromptText(offer.text, offer.context), deps.turnTimeoutMs ?? AGENT_TURN_TIMEOUT_MS);
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
      reply = replyForOutcome(outcome, limits, adapter.displayName);
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

  const worker = (async () => {
    while (!stopReason) {
      const offer = queue.shift();
      if (!offer) {
        await new Promise<void>((resolve) => {
          wakeWorker = resolve;
        });
        wakeWorker = undefined;
        continue;
      }
      const reply = await runTurn(offer);
      if (!stopReason) await sendReply(offer, reply);
    }
  })();

  await Promise.allSettled([pollLoop, worker]);
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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
