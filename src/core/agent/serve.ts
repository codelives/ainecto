import type { DaemonLog } from "../term/daemonLog";
import { ClaudeAgentProcess, type ClaudeSpawn, type TurnOutcome } from "./claudeProcess";
import { AgentCallError, type AgentHttp } from "./http";
import { AGENT_TURN_TIMEOUT_MS, nextRetryDelay } from "./limits";
import type { AgentLogRecord } from "./log";
import { agentPromptText, type AgentTurnContext } from "./prompt";
import { replyForOutcome, type AgentReply } from "./reply";
import type { AgentSessionMap } from "./sessions";

export interface AgentOffer {
  turnUuid: string;
  conversationUuid: string;
  text: string;
  /** 서버가 아는 맥락(대화의 프로젝트·열린 문서). */
  context?: AgentTurnContext;
}

export interface ServeDeps {
  http: AgentHttp;
  log: DaemonLog<AgentLogRecord>;
  sessions: AgentSessionMap;
  /** 서버 tools/list 에서 readOnlyHint 가 아닌 도구 이름. */
  writeTools: ReadonlySet<string>;
  /** K5 고정 인자 — 글 상한(서버 값)과 이어 붙일 세션으로 만든다. */
  claudeArgs(input: { textMaxCharacters: number; resumeSessionId?: string }): string[];
  spawnImpl: ClaudeSpawn;
  cwd: string;
  env: NodeJS.ProcessEnv;
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
 * ★Claude 프로세스는 동시에 하나 — 같은 대화면 그 프로세스 stdin 한 줄, 다른 대화면 앞 프로세스를 내리고 {@code --resume}.
 * ★받은 turnUuid 는 다시 넣지 않는다(서버가 답 올 때까지 같은 요청을 다시 준다 — K4).
 */
export async function runAgentServe(deps: ServeDeps): Promise<ServeResult> {
  const opened = await deps.http.call("open", { hostName: deps.hostName, cliVersion: deps.cliVersion });
  const linkId = String(opened.linkId);
  deps.http.useLinkToken(String(opened.linkToken));
  const limits = serverLimits(opened.limits);
  deps.print(`Connected to AiNecto as ${deps.hostName}. Requests to «My agent» in AiNecto Chat now run in Claude Code on this machine. Press Ctrl+C to stop.`);

  const stopController = new AbortController();
  let stopReason: string | undefined;
  let exitCode = 0;
  let wakeWorker: (() => void) | undefined;
  let current: ClaudeAgentProcess | undefined;
  const received = new Set<string>();
  const queue: AgentOffer[] = [];

  const stop = (reason: string, code: number, message?: string) => {
    if (stopReason) return;
    stopReason = reason;
    exitCode = code;
    if (message) deps.print(message);
    stopController.abort();
    wakeWorker?.();
    void current?.stop();
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
          deps.log.write({ event: "offer", turnUuid: offer.turnUuid, conversationUuid: offer.conversationUuid, duplicate });
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

  const runTurn = async (offer: AgentOffer): Promise<AgentReply> => {
    if (current && (current.conversationUuid !== offer.conversationUuid || !current.alive)) {
      await current.stop();
      current = undefined;
    }
    if (!current) {
      const resumeSessionId = deps.sessions.get(offer.conversationUuid);
      current = new ClaudeAgentProcess(offer.conversationUuid, resumeSessionId !== undefined,
        deps.claudeArgs({ textMaxCharacters: limits.textMaxCharacters, resumeSessionId }),
        { cwd: deps.cwd, env: deps.env, spawnImpl: deps.spawnImpl, writeTools: deps.writeTools, log: deps.log });
    }
    const proc = current;
    const started = Date.now();
    deps.log.write({ event: "agent_request", turnUuid: offer.turnUuid, conversationUuid: offer.conversationUuid, pid: proc.pid, textLength: offer.text.length });
    let outcome: TurnOutcome | undefined;
    let reply: AgentReply | undefined;
    let failure: string | undefined;
    try {
      outcome = await proc.runTurn(agentPromptText(offer.text, offer.context), deps.turnTimeoutMs ?? AGENT_TURN_TIMEOUT_MS);
      if (outcome.kind === "timeout") {
        await proc.stop();
      }
      if (outcome.kind !== "result") {
        current = current === proc ? undefined : current;
        // 이어 붙인 세션으로 떴다가 끝났다 — 다음 요청은 새 세션으로(같은 실패를 되풀이하지 않게).
        if (proc.resumed) await deps.sessions.forget(offer.conversationUuid);
      } else if (proc.sessionId) {
        await deps.sessions.set(offer.conversationUuid, proc.sessionId);
      }
      reply = replyForOutcome(outcome, limits);
      return reply;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      reply = { status: "FAILED", errorCode: "AGENT_INTERNAL", reply: `The PC agent failed: ${failure}`.slice(0, limits.textMaxCharacters), documentUuids: [] };
      return reply;
    } finally {
      const result = outcome?.kind === "result" ? outcome.result : undefined;
      deps.log.write({
        event: "agent_response",
        turnUuid: offer.turnUuid,
        ms: Date.now() - started,
        outcome: outcome?.kind ?? `error: ${failure ?? "unknown"}`,
        status: reply?.status ?? "FAILED",
        errorCode: reply?.errorCode,
        subtype: result?.subtype,
        sessionId: proc.sessionId,
        documents: reply?.documentUuids.length ?? 0,
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
  await current?.stop();
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
