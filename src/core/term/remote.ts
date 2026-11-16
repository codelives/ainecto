import { StringDecoder } from "node:string_decoder";
import type { TokenProvider } from "../auth/oauth";
import { sleep } from "../async/sleep";
import { createPcHttp, PcCallError, type PcHttp } from "../http/pcHttp";
import { openTermClient } from "./client";
import { DaemonLog } from "./daemonLog";
import { noSession, TermError } from "./errors";
import type { TermPaths } from "./paths";
import { listedSessions, readLines } from "./protocol";
import { frameBudget, screenFrame } from "./remoteFrame";
import { CALL_TIMEOUT_MS, FRAME_MIN_INTERVAL_MS, FRAME_SCROLLBACK_LINES, retryWait } from "./remoteLimits";

/**
 * `ainecto term remote <세션>` — 이 PC 의 term 세션 하나를 AiNecto 웹에서 보고(평문 화면) 입력하게 잇는 PC 쪽 다리(KAN-738).
 * 출처 = 사용자 web-cmux 의 폴링 방식. 1차는 색·커서 없는 평문이다 — attach 하지 않고 데몬 watch·read·send 만 쓴다.
 *
 * <pre>
 * 입력     poll(서버가 C1 동안 붙잡음) → input 명령의 바이트 그대로 → 데몬 send(paste 아님 — Esc·Ctrl·방향키 시퀀스 그대로)
 * 화면     데몬 watch 의 «바뀜» → C9 간격 이상으로 read(스크롤백 C10 + 화면 줄) → 평문 hash 가 바뀐 때만 frame. 한 번에 하나, 밀린 것은 최신 하나로
 * 끝       poll CLOSED·404 → 그대로 끝(0, close 안 보냄 · 다시 open 안 함) · 세션 끝·멈춤 신호 → close 보내고 끝
 * 다시     네트워크·5xx·기한 초과 → 같은 remoteId 로 C12 부터 두 배씩 C13 까지(흔들림 0~C12) · 그 밖 4xx → 사유와 함께 1
 * </pre>
 */

export type RemoteOp = "open" | "poll" | "frame" | "close";
export type RemoteHttp = PcHttp<RemoteOp>;

/**
 * `remote.log` 레코드. ★서버 호출은 {@code remote_call} 1줄 + {@code remote_call_response} 1줄(같은 callId — 공용 입구가 finally 에서 쓴다).
 * ★남기지 않는 것: 화면 글자·입력 바이트·토큰(길이·수만).
 */
export type RemoteLogRecord =
  | { event: "remote_start"; pid: number; version: string; endpoint: string; host: string; session: string }
  | { event: "remote_opened"; remoteId: string; cols: number; rows: number; pollHoldSeconds: number; frameMaxBytes: number }
  | { event: "remote_call"; callId: string; op: string; bytes: number }
  | { event: "remote_call_response"; callId: string; op: string; ok: boolean; status?: number; code?: string; error?: string; ms: number;
      state?: string; reason?: string; commands?: number; version?: number }
  /** 서버 frame 상한에 맞추려고 위 줄을 덜어 낸 수가 바뀌었다. */
  | { event: "remote_frame_trimmed"; dropped: number }
  /** 데몬 요청(send·read) 실패 — 삼키지 않는다. */
  | { event: "remote_daemon_error"; op: string; code: string; message: string }
  | { event: "remote_stop"; pid: number; reason: string; exitCode?: number };

export function openRemoteLog(paths: TermPaths): DaemonLog<RemoteLogRecord> {
  const log = new DaemonLog<RemoteLogRecord>(paths.remoteLog, paths.previousRemoteLog);
  log.enableRotation();
  return log;
}

/** 원격 터미널 서버 입구({@code /mcp/term/pc/<op>}) — 공용 한 입구 위에 이름만 얹는다. poll 기한 = 서버 C1 + C8. */
export function createRemoteHttp(input: {
  endpoint: string;
  tokenProvider: TokenProvider;
  log: DaemonLog<RemoteLogRecord>;
  fetchImpl?: typeof fetch;
}): RemoteHttp {
  return createPcHttp<RemoteOp, RemoteLogRecord>({
    endpoint: input.endpoint,
    path: "term/pc",
    tokenProvider: input.tokenProvider,
    timeoutMs: CALL_TIMEOUT_MS,
    sessionHeader: "X-Remote-Token",
    fetchImpl: input.fetchImpl,
    logging: {
      log: input.log,
      request: ({ callId, op, bytes }) => ({ event: "remote_call", callId, op, bytes }),
      response: ({ callId, op, ms }, outcome) => ({
        event: "remote_call_response",
        callId,
        op,
        ...(outcome.ok ? { ok: true, status: outcome.status, ...answerSummary(outcome.body) } : outcome),
        ms,
      }),
    },
  });
}

export interface RemoteDeps {
  paths: TermPaths;
  session: string;
  http: RemoteHttp;
  log: DaemonLog<RemoteLogRecord>;
  hostName: string;
  /** open 에 알리는 판({@code CLI_VERSION_LABEL}). */
  cliVersion: string;
  /** Ctrl+C 등 — 끊으면 close 를 보내고 끝낸다. */
  signal: AbortSignal;
  print(line: string): void;
}

export interface RemoteResult {
  exitCode: number;
  reason: string;
}

interface RemoteEnd extends RemoteResult {
  /** 서버에 close 를 보낼지 — 서버가 이미 닫았으면(CLOSED·404) 보내지 않는다. */
  close: boolean;
}

export async function runRemote(deps: RemoteDeps): Promise<RemoteResult> {
  const name = deps.session;
  const client = await openTermClient(deps.paths, { start: false });
  if (!client) {
    throw noSession(name);
  }
  let ending: RemoteEnd | undefined;
  const stopper = new AbortController();
  let dirty = true;
  let wakeFrame: (() => void) | undefined;
  const nudge = (): void => {
    const wake = wakeFrame;
    wakeFrame = undefined;
    wake?.();
  };
  const end = (outcome: RemoteEnd): void => {
    if (ending) return;
    ending = outcome;
    stopper.abort();
    nudge();
  };
  /** 데몬 요청 실패 — 한 줄 남기고 끝낸다(세션이 없어졌으면 정상 끝). */
  const daemonFailed = (op: string, error: unknown): void => {
    const code = error instanceof TermError ? error.code : "UNKNOWN";
    const message = error instanceof Error ? error.message : String(error);
    deps.log.write({ event: "remote_daemon_error", op, code, message });
    end(code === "TERM_NO_SESSION"
      ? { exitCode: 0, reason: `Session ${name} ended.`, close: true }
      : { exitCode: 1, reason: `The term daemon failed ${op} (${code}): ${message}`, close: true });
  };
  const onUserStop = (): void => end({ exitCode: 0, reason: "Stopped.", close: true });
  if (deps.signal.aborted) onUserStop();
  deps.signal.addEventListener("abort", onUserStop, { once: true });
  client.onEvent((event) => {
    if (event.event === "changed") {
      dirty = true;
      nudge();
    } else if (event.event === "exit") {
      end({ exitCode: 0, reason: `Session ${name} exited (${event.signal ? `signal ${event.signal}` : `code ${event.exitCode}`}).`, close: true });
    }
  });
  client.onClose(() => end({ exitCode: 1, reason: "Lost the connection to the term daemon.", close: true }));

  let remoteId: string | undefined;
  try {
    // watch 가 먼저 — 없는 세션이면 데몬이 TERM_NO_SESSION 으로 답하고, 서버는 부르지 않는다.
    await client.request({ op: "watch", name });
    const listed = listedSessions(await client.request({ op: "ls" })).find((session) => session.name === name);
    if (!listed) {
      throw noSession(name);
    }
    const { cols, rows } = listed;
    if (ending) {
      return { exitCode: ending.exitCode, reason: ending.reason };
    }
    const opened = await deps.http.call("open", { session: name, hostName: deps.hostName, cliVersion: deps.cliVersion, cols, rows });
    const limits = serverLimits(opened.limits);
    if (typeof opened.remoteId !== "string" || typeof opened.remoteToken !== "string" || !limits) {
      throw new TermError("TERM_REMOTE_BAD_RESPONSE", "AiNecto answered open without remoteId, remoteToken or limits.");
    }
    const id = opened.remoteId;
    remoteId = id;
    deps.http.useSessionToken(opened.remoteToken);
    deps.log.write({ event: "remote_opened", remoteId: id, cols, rows, ...limits });
    deps.print(`Sharing ${name} (${cols}x${rows}) on AiNecto from ${deps.hostName}. Open the remote terminal in AiNecto to watch and type. Press Ctrl+C to stop.`);

    /** 다시 하지 않을 서버 거절 — 404 는 서버가 이미 이 연결을 모른다(정상 끝), 그 밖은 사유와 함께 1. */
    const refused = (error: unknown): RemoteEnd => {
      if (error instanceof PcCallError && error.status === 404) {
        return { exitCode: 0, reason: `AiNecto no longer has this remote terminal open (${error.code ?? "404"}).`, close: false };
      }
      const what = error instanceof PcCallError
        ? `${error.op}: ${error.status ?? "-"} ${error.code ?? ""} ${error.message}`.replace(/\s+/g, " ")
        : error instanceof Error ? error.message : String(error);
      return { exitCode: 1, reason: `AiNecto refused the remote terminal (${what}).`, close: true };
    };

    const decoder = new StringDecoder("utf8");
    const pollLoop = async (): Promise<void> => {
      let attempt = 0;
      while (!ending) {
        let answer: Record<string, unknown>;
        try {
          answer = await deps.http.call("poll", { remoteId: id }, { holdMs: limits.pollHoldSeconds * 1000, signal: stopper.signal });
        } catch (error) {
          if (ending) return;
          if (!(error instanceof PcCallError) || !error.retryable) {
            end(refused(error));
            return;
          }
          await sleep(retryWait(attempt, Math.random()), stopper.signal);
          attempt += 1;
          continue;
        }
        attempt = 0;
        if (answer.state === "CLOSED") {
          end({ exitCode: 0, reason: `AiNecto closed this remote terminal (${typeof answer.reason === "string" ? answer.reason : "CLOSED"}).`, close: false });
          return;
        }
        for (const d of inputsIn(answer)) {
          // 여러 바이트 글자가 poll 경계에서 갈려도 잇는다 — 바이트는 그대로, 글자로 바꾸는 곳만 한 곳.
          const text = decoder.write(Buffer.from(d, "base64"));
          if (text === "") continue;
          try {
            await client.request({ op: "send", name, text, paste: false });
          } catch (error) {
            daemonFailed("send", error);
            return;
          }
        }
      }
    };

    const frameLoop = async (): Promise<void> => {
      const budget = frameBudget(limits.frameMaxBytes, { remoteId: id, cols, rows });
      let sentHash: string | undefined;
      let lastRead = 0;
      let dropped = 0;
      let attempt = 0;
      while (!ending) {
        if (!dirty) {
          await new Promise<void>((resolve) => {
            wakeFrame = resolve;
          });
          continue;
        }
        const gap = lastRead + FRAME_MIN_INTERVAL_MS - Date.now();
        if (gap > 0) {
          await sleep(gap, stopper.signal);
          continue;
        }
        dirty = false;
        lastRead = Date.now();
        let lines: string[];
        try {
          lines = readLines(await client.request({ op: "read", name, scrollback: true, lines: FRAME_SCROLLBACK_LINES + rows }));
        } catch (error) {
          daemonFailed("read", error);
          return;
        }
        const frame = screenFrame(lines, budget);
        if (frame.dropped !== dropped) {
          dropped = frame.dropped;
          deps.log.write({ event: "remote_frame_trimmed", dropped });
        }
        if (frame.hash === sentHash) continue;
        try {
          await deps.http.call("frame", { remoteId: id, cols, rows, d: frame.d }, { signal: stopper.signal });
          sentHash = frame.hash;
          attempt = 0;
        } catch (error) {
          if (ending) return;
          if (!(error instanceof PcCallError) || !error.retryable) {
            end(refused(error));
            return;
          }
          await sleep(retryWait(attempt, Math.random()), stopper.signal);
          attempt += 1;
          dirty = true;   // 기다린 사이 바뀐 것까지 — 다시 읽어 최신 한 장을 보낸다.
        }
      }
    };

    await Promise.all([pollLoop(), frameLoop()]);
    const outcome = ending ?? { exitCode: 1, reason: "The remote terminal stopped.", close: true };
    if (outcome.close) {
      try {
        await deps.http.call("close", { remoteId: id });
      } catch (error) {
        // 응답 줄은 공용 입구가 남겼다 — 사람에게도 알린다(웹은 PC 연결 끊김으로 곧 보인다).
        deps.print(`Could not tell AiNecto that sharing stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { exitCode: outcome.exitCode, reason: outcome.reason };
  } finally {
    // open 을 못 마쳤는데 끝나는 길(던짐)이면 남은 루프가 없다 — 멈춤만 알린다.
    if (!remoteId) stopper.abort();
    deps.signal.removeEventListener("abort", onUserStop);
    client.close();
  }
}

/** 응답 줄에 셀 것 — 상태·사유·명령 수·화면 판(본문·토큰은 남기지 않는다). 순수 함수. */
function answerSummary(body: Record<string, unknown>): { state?: string; reason?: string; commands?: number; version?: number } {
  return {
    ...(typeof body.state === "string" ? { state: body.state } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(Array.isArray(body.commands) ? { commands: body.commands.length } : {}),
    ...(typeof body.version === "number" ? { version: body.version } : {}),
  };
}

/** open 응답 limits — 서버 값(C1·C3). 모양이 틀리면 undefined. */
function serverLimits(value: unknown): { pollHoldSeconds: number; frameMaxBytes: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pollHoldSeconds = "pollHoldSeconds" in value ? value.pollHoldSeconds : undefined;
  const frameMaxBytes = "frameMaxBytes" in value ? value.frameMaxBytes : undefined;
  return typeof pollHoldSeconds === "number" && pollHoldSeconds >= 0 && typeof frameMaxBytes === "number" && frameMaxBytes > 0
    ? { pollHoldSeconds, frameMaxBytes }
    : undefined;
}

/** poll 의 input 명령 — base64 바이트 그대로. */
function inputsIn(answer: Record<string, unknown>): string[] {
  if (!Array.isArray(answer.commands)) return [];
  return answer.commands.flatMap((command: unknown) =>
    command && typeof command === "object" && "type" in command && command.type === "input" && "d" in command && typeof command.d === "string"
      ? [command.d]
      : []);
}
