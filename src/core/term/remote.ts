import { StringDecoder } from "node:string_decoder";
import type { TokenProvider } from "../auth/oauth";
import { sleep } from "../async/sleep";
import { createPcHttp, PcCallError, type PcHttp } from "../http/pcHttp";
import { openTermClient, termRequest, type TermClient } from "./client";
import { DaemonLog } from "./daemonLog";
import { TermError } from "./errors";
import type { TermPaths } from "./paths";
import { appliedSize, listedSessions, type TermRequestBody } from "./protocol";
import { CALL_TIMEOUT_MS, retryWait } from "./remoteLimits";
import { sessionsKey, wireSessions, type WireSession } from "./remoteSessions";
import { RemoteViewer, type ViewerLink } from "./remoteViewer";
import { shellLineCommand } from "./session";

/**
 * 원격 터미널 다리 — 이 PC 의 term 세션 «전부»를 AiNecto 웹에 잇는다(KAN-738 next.10, 계획 multi-session-plan.md 11절).
 * PC 하나에 다리 하나(`ainecto pc run` 안에서 Agent 와 함께). 출처 = 사용자 web-cmux 의 폴링 방식.
 *
 * <pre>
 * 열기      open {pcId, hostName, cliVersion, remoteEnabled, sessions[]} — 자기 pc 세션은 목록에서 뺀다. PC 설정이 끔이면 remoteEnabled=false
 * 목록      데몬 watch-sessions 이벤트 · poll 이 돌아올 때마다 ls 를 견줘 바뀐 때만 sessions 로 통째 올린다(옛 데몬은 poll 때만)
 * 보기      poll 의 watching 에 든 세션만 화면을 흘린다(세션마다 {@link RemoteViewer})
 * 명령      input·key·resize 는 세션 이름으로 데몬에 · create·kill·label 은 데몬에서 해 보고 answer(requestId, ok|code)
 * 원격 상태  poll 의 remote — off-by-web(웹 «원격 터미널 끊기»)·off-by-pc 면 화면·명령을 멈추고 poll 만 잇는다(웹 PC 줄에 이유가 보인다)
 * 끝        멈춤 신호 → close · 같은 PC 의 다른 다리가 열면(CLOSED REPLACED) 그대로 끝 · 401/403·그 밖 4xx → 사유와 함께 1
 * 다시      네트워크·5xx·기한 초과 → C12 부터 두 배씩 C13 까지 · poll 404 REMOTE_NOT_FOUND(api 재시작) → 같은 PC 로 다시 open
 * </pre>
 */

export type RemoteOp = "open" | "sessions" | "poll" | "frame" | "answer" | "close";
export type RemoteHttp = PcHttp<RemoteOp>;
export type RemoteState = "on" | "off-by-pc" | "off-by-web";

/** 서버가 이 링크를 모른다(api 재시작) — 다시 열기의 유일한 계기. */
const REMOTE_NOT_FOUND = "REMOTE_NOT_FOUND";

/**
 * `remote.log` 레코드. ★서버 호출은 {@code remote_call} 1줄 + {@code remote_call_response} 1줄(같은 callId — 공용 입구가 finally 에서 쓴다).
 * 웹 명령은 {@code remote_command} 1줄 + 결과 {@code remote_command_result} 1줄(CRUD 는 requestId 로 잇는다).
 * ★남기지 않는 것: 화면 글자·입력 바이트·명령 줄·토큰(길이·수만).
 */
export type RemoteLogRecord =
  | { event: "remote_start"; pid: number; version: string; endpoint: string; host: string; pcId: string; remote: string }
  | { event: "remote_opened"; linkId: string; sessions: number; remote: string; pollHoldSeconds: number; frameMaxBytes: number }
  | { event: "remote_call"; callId: string; op: string; bytes: number }
  | { event: "remote_call_response"; callId: string; op: string; ok: boolean; status?: number; code?: string; error?: string; ms: number;
      state?: string; reason?: string; remote?: string; commands?: number; version?: number }
  /** 서버가 링크를 잊어(api 재시작) 같은 PC 로 다시 열었다. */
  | { event: "remote_reopened"; reason: string; previousLinkId: string; linkId: string }
  /** 원격 상태가 바뀌었다(웹 끊기 등). */
  | { event: "remote_state"; remote: string }
  /** 웹이 보는 세션이 바뀌었다. */
  | { event: "remote_watching"; sessions: string[] }
  | { event: "remote_command"; type: string; session?: string; requestId?: string; bytes?: number }
  | { event: "remote_command_result"; type: string; session?: string; requestId?: string; ok: boolean; code?: string }
  /** 서버 frame 상한에 맞추려고 위 줄을 덜어 낸 수가 바뀌었다. */
  | { event: "remote_frame_trimmed"; session: string; dropped: number }
  /** 데몬 요청 실패 — 삼키지 않는다. */
  | { event: "remote_daemon_error"; op: string; session?: string; code: string; message: string }
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

export interface BridgeDeps {
  paths: TermPaths;
  http: RemoteHttp;
  log: DaemonLog<RemoteLogRecord>;
  /** 이 PC — `~/.ainecto/pc.json` 의 pcId. */
  pcId: string;
  hostName: string;
  /** open 에 알리는 판({@code CLI_VERSION_LABEL}). */
  cliVersion: string;
  /** 이 계정이 이 PC 에서 웹 터미널을 허용했나(pc.json) — 끔이면 remoteEnabled=false 로 열고 명령을 받지 않는다. */
  remoteEnabled: boolean;
  /** 목록에서 뺄 세션 — 이 다리를 돌리는 pc 세션. */
  exclude: readonly string[];
  /** 웹이 만드는 세션의 환경·기본 폴더(로컬 `term new` 와 같은 규칙: 다리 프로세스의 환경, 폴더가 없으면 홈). */
  sessionEnv: Record<string, string>;
  home: string;
  /** 끊으면 close 를 보내고 끝낸다. */
  signal: AbortSignal;
  print(line: string): void;
}

export interface RemoteResult {
  exitCode: number;
  reason: string;
}

interface Link extends ViewerLink {
  pollHoldSeconds: number;
}

interface RemoteEnd extends RemoteResult {
  /** 서버에 close 를 보낼지 — 서버가 이미 끝냈으면(REPLACED·잊음) 보내지 않는다. */
  close: boolean;
}

export async function runRemoteBridge(deps: BridgeDeps): Promise<RemoteResult> {
  let ending: RemoteEnd | undefined;
  const stopper = new AbortController();
  const viewers = new Map<string, RemoteViewer>();
  const end = (outcome: RemoteEnd): void => {
    if (ending) return;
    ending = outcome;
    stopper.abort();
    for (const viewer of viewers.values()) viewer.stop();
    viewers.clear();
  };
  const onUserStop = (): void => end({ exitCode: 0, reason: "Stopped.", close: true });
  if (deps.signal.aborted) onUserStop();
  deps.signal.addEventListener("abort", onUserStop, { once: true });

  const control = new DaemonControl(deps.paths);
  let listWatch: TermClient | undefined;
  try {
    const first = await currentSessions(deps);
    if (ending) return { exitCode: ending.exitCode, reason: ending.reason };
    let link = await openLink(deps, 1, deps.remoteEnabled, deps.remoteEnabled ? first : [], undefined);
    let remote = startState(deps.remoteEnabled);
    /** 서버에 마지막으로 올린 목록 — 바뀐 때만 올린다. */
    let uploaded = deps.remoteEnabled ? sessionsKey(first) : undefined;
    deps.log.write({ event: "remote_opened", linkId: link.linkId, sessions: deps.remoteEnabled ? first.length : 0, remote,
      pollHoldSeconds: link.pollHoldSeconds, frameMaxBytes: link.frameMaxBytes });
    deps.print(deps.remoteEnabled
      ? `Remote terminal: on — ${first.length} session(s) from ${deps.hostName} are listed in AiNecto on the web.`
      : "Remote terminal: off on this PC (`ainecto remote on` allows it).");

    /** 목록 올리기 — 한 줄로 세운다(겹쳐 올리지 않게). 원격이 꺼졌으면 올리지 않는다. */
    let syncing: Promise<void> = Promise.resolve();
    const syncList = (): Promise<void> => {
      syncing = syncing.then(async () => {
        if (ending || remote !== "on") return;
        let sessions: WireSession[];
        try {
          sessions = await currentSessions(deps);
        } catch (error) {
          daemonFailed(deps, "ls", undefined, error);
          return;
        }
        const key = sessionsKey(sessions);
        if (key === uploaded) return;
        try {
          await deps.http.call("sessions", { linkId: link.linkId, sessions }, { signal: stopper.signal });
          uploaded = key;
          for (const viewer of viewers.values()) viewer.refresh();
        } catch {
          // 응답 줄은 공용 입구가 남겼다 — 다음 poll 이 돌아올 때 다시 견준다(uploaded 그대로).
        }
      });
      return syncing;
    };

    // 목록 변화 알림 — 따로 연 연결(옛 데몬은 모르는 op 에 연결을 끊는다: 한 줄 남기고 poll 때 견주기로만).
    listWatch = await openTermClient(deps.paths, { start: false });
    if (listWatch) {
      listWatch.onEvent((event) => {
        if (event.event === "sessions") void syncList();
      });
      try {
        await listWatch.request({ op: "watch-sessions" });
      } catch (error) {
        daemonFailed(deps, "watch-sessions", undefined, error);
      }
    }

    const viewerFor = (name: string, size: { cols: number; rows: number }): RemoteViewer => {
      const viewer = new RemoteViewer({
        paths: deps.paths, session: name, http: deps.http, log: deps.log, link: () => link, size,
        onGone: () => {
          viewers.delete(name);
          void syncList();
        },
        onRefused: (error) => end(refused(error)),
        onUnknownSession: () => {
          uploaded = undefined;   // 서버 목록이 이 세션을 모른다 — 다시 올린다
          void syncList();
        },
      });
      void viewer.run();
      return viewer;
    };
    /** 웹이 보는 세션에 맞춰 화면 루프를 켜고 끈다. */
    const setWatching = async (names: readonly string[]): Promise<void> => {
      const wanted = remote === "on" ? names : [];
      let changed = false;
      for (const [name, viewer] of viewers) {
        if (!wanted.includes(name)) {
          viewer.stop();
          viewers.delete(name);
          changed = true;
        }
      }
      const missing = wanted.filter((name) => !viewers.has(name));
      if (missing.length > 0) {
        const sizes = new Map((await currentSessions(deps).catch(() => [])).map((s) => [s.name, { cols: s.cols, rows: s.rows }]));
        for (const name of missing) {
          const size = sizes.get(name);
          if (size) {
            viewers.set(name, viewerFor(name, size));
            changed = true;
          }
        }
      }
      if (changed) deps.log.write({ event: "remote_watching", sessions: [...viewers.keys()] });
    };
    const applyRemote = (next: RemoteState): void => {
      if (next === remote) return;
      remote = next;
      deps.log.write({ event: "remote_state", remote });
      if (remote === "on") {
        uploaded = undefined;
        void syncList();
        deps.print("Remote terminal: on.");
      } else {
        for (const viewer of viewers.values()) viewer.stop();
        viewers.clear();
        deps.print(remote === "off-by-web"
          ? "Remote terminal: turned off from the web. Run `ainecto` (or `ainecto remote on`) on this PC to turn it back on."
          : "Remote terminal: off on this PC (`ainecto remote on` allows it).");
      }
    };

    const commands = new CommandRunner(deps, control, viewers, () => remote);
    let reopens = 0;
    let attempt = 0;
    while (!ending) {
      let answer: Record<string, unknown>;
      try {
        answer = await deps.http.call("poll", { linkId: link.linkId }, { holdMs: link.pollHoldSeconds * 1000, signal: stopper.signal });
      } catch (error) {
        if (ending) break;
        if (forgotten(error)) {
          // api 재시작 — 같은 PC 로 다시 연다. 연속 다시 열기는 C12 부터 두 배씩(열자마자 또 잊히는 고리도 벌어진다).
          if (reopens > 0) await sleep(retryWait(reopens - 1, Math.random()), stopper.signal);
          if (ending) break;
          reopens += 1;
          const previous = link;
          try {
            // 웹에서 끈 원격은 이 프로세스가 사는 동안 꺼진 채다(R2) — 서버가 잊었어도 다시 켜서 열지 않는다.
            const enabled = deps.remoteEnabled && remote !== "off-by-web";
            const sessions = enabled ? await currentSessions(deps) : [];
            link = await openLink(deps, previous.generation + 1, enabled, sessions, stopper.signal);
            if (enabled) remote = "on";
            uploaded = enabled ? sessionsKey(sessions) : undefined;
          } catch (reopenError) {
            if (ending) break;
            if (reopenError instanceof PcCallError && reopenError.retryable) continue;
            end(refused(reopenError));
            break;
          }
          deps.log.write({ event: "remote_reopened", reason: REMOTE_NOT_FOUND, previousLinkId: previous.linkId, linkId: link.linkId });
          deps.print("AiNecto lost the remote terminal (it may have restarted); opened it again.");
          for (const viewer of viewers.values()) viewer.refresh();
          continue;
        }
        if (!(error instanceof PcCallError) || !error.retryable) {
          end(refused(error));
          break;
        }
        await sleep(retryWait(attempt, Math.random()), stopper.signal);
        attempt += 1;
        continue;
      }
      attempt = 0;
      reopens = 0;
      if (answer.state === "CLOSED") {
        end({ exitCode: 0, reason: `Another remote terminal bridge on this PC took over (${typeof answer.reason === "string" ? answer.reason : "CLOSED"}).`,
          close: false });
        break;
      }
      const state = remoteStateOf(answer.remote);
      if (state) applyRemote(state);
      await setWatching(watchingOf(answer));
      await commands.run(remoteCommands(answer), { linkId: () => link.linkId, syncList, stopSignal: stopper.signal });
      await syncList();
    }

    const outcome = ending ?? { exitCode: 1, reason: "The remote terminal stopped.", close: true };
    await syncing;
    if (outcome.close) {
      try {
        await deps.http.call("close", { linkId: link.linkId });
      } catch (error) {
        // 응답 줄은 공용 입구가 남겼다 — 사람에게도 알린다(웹은 PC 연결 끊김으로 곧 보인다).
        deps.print(`Could not tell AiNecto that the remote terminal stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { exitCode: outcome.exitCode, reason: outcome.reason };
  } finally {
    stopper.abort();
    for (const viewer of viewers.values()) viewer.stop();
    deps.signal.removeEventListener("abort", onUserStop);
    listWatch?.close();
    control.close();
  }
}

/** 시작 때 원격 상태 — PC 설정 그대로(웹 끊기는 poll 로 온다). */
function startState(remoteEnabled: boolean): RemoteState {
  return remoteEnabled ? "on" : "off-by-pc";
}

/** open 한 번 — 처음과 다시 열기가 같은 길. 새 토큰을 싣는다. */
async function openLink(deps: BridgeDeps, generation: number, remoteEnabled: boolean, sessions: WireSession[],
  signal: AbortSignal | undefined): Promise<Link> {
  const opened = await deps.http.call("open", {
    pcId: deps.pcId, hostName: deps.hostName, cliVersion: deps.cliVersion, remoteEnabled, sessions,
  }, signal ? { signal } : undefined);
  const limits = serverLimits(opened.limits);
  if (typeof opened.linkId !== "string" || typeof opened.linkToken !== "string" || !limits) {
    throw new TermError("TERM_REMOTE_BAD_RESPONSE", "AiNecto answered open without linkId, linkToken or limits.");
  }
  deps.http.useSessionToken(opened.linkToken);
  return { linkId: opened.linkId, generation, ...limits };
}

/** 지금 데몬의 세션 목록(자기 pc 세션 뺌). 데몬이 없으면 빈 목록. */
async function currentSessions(deps: BridgeDeps): Promise<WireSession[]> {
  const result = await termRequest(deps.paths, { op: "ls" }, { start: false });
  return wireSessions(listedSessions(result.daemon ? result.data : undefined), deps.exclude);
}

/** 다시 하지 않을 서버 거절 — 사유와 함께 1. */
function refused(error: unknown): RemoteEnd {
  const what = error instanceof PcCallError
    ? `${error.op}: ${error.status ?? "-"} ${error.code ?? ""} ${error.message}`.replace(/\s+/g, " ")
    : error instanceof Error ? error.message : String(error);
  return { exitCode: 1, reason: `AiNecto refused the remote terminal (${what}).`, close: true };
}

function forgotten(error: unknown): boolean {
  return error instanceof PcCallError && error.status === 404 && error.code === REMOTE_NOT_FOUND;
}

function daemonFailed(deps: BridgeDeps, op: string, session: string | undefined, error: unknown): void {
  deps.log.write({ event: "remote_daemon_error", op, ...(session ? { session } : {}),
    code: error instanceof TermError ? error.code : "UNKNOWN", message: error instanceof Error ? error.message : String(error) });
}

/**
 * 데몬 연결 하나를 이어 쓴다(입력·키·만들기·끝내기 — 모든 데몬이 아는 op). 끊기면 다음 요청 때 다시 연다.
 * 옛 데몬이 모를 수 있는 op(set-size·label)는 {@link termRequest} 로 따로 연 연결에 — 모르면 그 연결만 끊긴다.
 */
class DaemonControl {
  private client: TermClient | undefined;

  constructor(private readonly paths: TermPaths) {}

  async request(body: TermRequestBody): Promise<unknown> {
    if (!this.client) {
      const client = await openTermClient(this.paths, { start: false });
      if (!client) throw new TermError("TERM_DAEMON_GONE", "No term daemon is running.");
      client.onClose(() => {
        if (this.client === client) this.client = undefined;
      });
      this.client = client;
    }
    return await this.client.request(body);
  }

  close(): void {
    this.client?.close();
    this.client = undefined;
  }
}

/** poll 명령을 데몬으로 — 받은 순서 그대로. 결과는 명령 1줄 + 결과 1줄. CRUD 는 answer 로 서버에 돌려준다. */
class CommandRunner {
  /** 여러 바이트 글자가 poll 경계에서 갈려도 잇는다 — 세션마다(바이트는 그대로, 글자로 바꾸는 곳만 한 곳). */
  private readonly decoders = new Map<string, StringDecoder>();

  constructor(
    private readonly deps: BridgeDeps,
    private readonly control: DaemonControl,
    private readonly viewers: Map<string, RemoteViewer>,
    private readonly remote: () => RemoteState,
  ) {}

  async run(commands: readonly RemoteCommand[], ctx: { linkId: () => string; syncList: () => Promise<void>; stopSignal: AbortSignal }): Promise<void> {
    let listChanged = false;
    for (const command of commands) {
      const session = "session" in command ? command.session : command.type === "create" ? command.name : undefined;
      const requestId = "requestId" in command ? command.requestId : undefined;
      this.deps.log.write({ event: "remote_command", type: command.type, ...(session ? { session } : {}),
        ...(requestId ? { requestId } : {}), ...(command.type === "input" ? { bytes: Buffer.byteLength(command.d, "base64") } : {}) });
      let failure: { code: string; message: string } | undefined;
      if (this.remote() !== "on") {
        // ★이중 거절 — 서버가 먼저 막지만 PC 도 원격이 꺼졌으면 하지 않는다.
        failure = { code: "REMOTE_OFF", message: "Terminals from the web are turned off on this PC." };
      } else if (session !== undefined && this.deps.exclude.includes(session)) {
        failure = { code: "TERM_NO_SESSION", message: `No session named "${session}".` };
      } else {
        try {
          listChanged = (await this.apply(command)) || listChanged;
        } catch (error) {
          failure = { code: error instanceof TermError ? error.code : "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
          daemonFailed(this.deps, command.type, session, error);
        }
      }
      this.deps.log.write({ event: "remote_command_result", type: command.type, ...(session ? { session } : {}),
        ...(requestId ? { requestId } : {}), ok: failure === undefined, ...(failure ? { code: failure.code } : {}) });
      if (requestId) {
        try {
          await this.deps.http.call("answer", { linkId: ctx.linkId(), requestId, ok: failure === undefined, ...(failure ?? {}) },
            { signal: ctx.stopSignal });
        } catch {
          // 응답 줄은 공용 입구가 남겼다 — 서버는 기한(C1)이면 PC_NO_ANSWER 로 끝낸다.
        }
      }
    }
    if (listChanged) await ctx.syncList();
  }

  /** 명령 하나를 데몬에 — 목록이 바뀌었으면 true. */
  private async apply(command: RemoteCommand): Promise<boolean> {
    switch (command.type) {
      case "input": {
        let decoder = this.decoders.get(command.session);
        if (!decoder) {
          decoder = new StringDecoder("utf8");
          this.decoders.set(command.session, decoder);
        }
        const text = decoder.write(Buffer.from(command.d, "base64"));
        if (text !== "") await this.control.request({ op: "send", name: command.session, text, paste: false });
        return false;
      }
      case "key":
        // 이름 목록·바이트(커서키 모드)는 데몬 keys.ts 가 안다 — 모르는 이름이면 TERM_UNKNOWN_KEY 로 한 줄 남고 무시된다.
        await this.control.request({ op: "key", name: command.session, key: command.key });
        return false;
      case "resize": {
        const result = await termRequest(this.deps.paths, { op: "set-size", name: command.session, cols: command.cols, rows: command.rows },
          { start: false });
        const applied = result.daemon ? appliedSize(result.data) : undefined;
        if (!applied) throw new TermError("TERM_BAD_RESPONSE", "The term daemon answered set-size without cols and rows.");
        this.viewers.get(command.session)?.setSize(applied);
        return true;
      }
      case "create":
        await this.control.request({
          op: "new",
          name: command.name,
          cwd: command.cwd ?? this.deps.home,
          command: command.command === undefined ? null : shellLineCommand(command.command, this.deps.sessionEnv),
          env: this.deps.sessionEnv,
        });
        return true;
      case "kill":
        await this.control.request({ op: "kill", name: command.session });
        this.decoders.delete(command.session);
        return true;
      case "label": {
        const result = await termRequest(this.deps.paths, { op: "label", name: command.session, label: command.label }, { start: false });
        if (!result.daemon) throw new TermError("TERM_DAEMON_GONE", "No term daemon is running.");
        return true;
      }
    }
  }
}

/** 응답 줄에 셀 것 — 상태·사유·원격 상태·명령 수·화면 판(본문·토큰은 남기지 않는다). 순수 함수. */
function answerSummary(body: Record<string, unknown>): { state?: string; reason?: string; remote?: string; commands?: number; version?: number } {
  return {
    ...(typeof body.state === "string" ? { state: body.state } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    ...(typeof body.remote === "string" ? { remote: body.remote } : {}),
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

/** poll 의 remote — 모르는 값이면 undefined(지금 상태 그대로). 순수 함수. */
export function remoteStateOf(value: unknown): RemoteState | undefined {
  return value === "on" || value === "off-by-pc" || value === "off-by-web" ? value : undefined;
}

/** poll 의 watching — 글 이름만. 순수 함수. */
export function watchingOf(answer: Record<string, unknown>): string[] {
  return Array.isArray(answer.watching) ? answer.watching.filter((name): name is string => typeof name === "string" && name !== "") : [];
}

export type RemoteCommand =
  | { type: "input"; session: string; d: string }
  | { type: "key"; session: string; key: string }
  | { type: "resize"; session: string; cols: number; rows: number }
  | { type: "create"; requestId: string; name: string; cwd?: string; command?: string }
  | { type: "kill"; requestId: string; session: string }
  | { type: "label"; requestId: string; session: string; label: string };

/** poll 의 명령 — 서버가 준 순서 그대로. 모르는 것·모양이 틀린 것은 뺀다. 순수 함수. */
export function remoteCommands(answer: Record<string, unknown>): RemoteCommand[] {
  if (!Array.isArray(answer.commands)) return [];
  return answer.commands.flatMap((raw: unknown): RemoteCommand[] => {
    if (!raw || typeof raw !== "object") return [];
    const c = new Map<string, unknown>(Object.entries(raw));
    const session = text(c.get("session"));
    const requestId = text(c.get("requestId"));
    switch (c.get("type")) {
      case "input": {
        const d = c.get("d");
        return session && typeof d === "string" ? [{ type: "input", session, d }] : [];
      }
      case "key": {
        const key = text(c.get("key"));
        return session && key ? [{ type: "key", session, key }] : [];
      }
      case "resize": {
        const cols = c.get("cols");
        const rows = c.get("rows");
        return session && isSize(cols) && isSize(rows) ? [{ type: "resize", session, cols, rows }] : [];
      }
      case "create": {
        const name = text(c.get("name"));
        const cwd = text(c.get("cwd"));
        const command = c.get("command");
        if (!requestId || !name) return [];
        return [{ type: "create", requestId, name, ...(cwd ? { cwd } : {}), ...(typeof command === "string" ? { command } : {}) }];
      }
      case "kill":
        return requestId && session ? [{ type: "kill", requestId, session }] : [];
      case "label": {
        const label = text(c.get("label"));
        return requestId && session && label ? [{ type: "label", requestId, session, label }] : [];
      }
      default:
        return [];
    }
  });
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
