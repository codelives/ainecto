import { StringDecoder } from "node:string_decoder";
import type { TokenProvider } from "../auth/oauth";
import { sleep } from "../async/sleep";
import { createPcHttp, PcCallError, type PcHttp } from "../http/pcHttp";
import { loadPcKeys } from "../pc/pcKeys";
import { openTermClient, termRequest, type TermClient } from "./client";
import { DaemonLog } from "./daemonLog";
import { transcriptUserId } from "./e2e";
import { TermError } from "./errors";
import { isUuid, webSessionFolder, type TermPaths } from "./paths";
import { appliedSize, listedSessions, sessionInstance, type TermRequestBody } from "./protocol";
import {
  answerCodeOf,
  ChannelBook,
  ChannelSealError,
  wireCommand,
  type ChannelBrowser,
  type ChannelCommand,
  type CloseReason,
  type HelloTrust,
  type WireCommand,
} from "./remoteChannel";
import { CALL_TIMEOUT_MS, retryWait } from "./remoteLimits";
import { sessionsKey, wireSessions, type WireSession } from "./remoteSessions";
import { RemoteViewer, type ViewerLink } from "./remoteViewer";
import { shellLineCommand } from "../os/launch";
import { ensurePrivateDir } from "../fs/privateFiles";
import { existsSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { cliTagsOf, type CliTags } from "../pc/pcUpgrade";
import type { PcNotifier } from "../pc/pcNotify";
import { DeviceManager } from "../pc/pcDevices";
import type { PairTransport } from "../pc/pcPairing";

/**
 * 원격 터미널 다리 — 이 PC 의 term 세션 «전부»를 AiNecto 웹에 잇는다(KAN-738 next.10, 계획 multi-session-plan.md 11절).
 * PC 하나에 다리 하나(`ainecto pc run` 안에서 Agent 와 함께). 출처 = 사용자 web-cmux 의 폴링 방식.
 * ★화면·입력·명령은 종단 간 암호(설계 terminal-e2e §14 · A1~A7) — 서버는 채널 손잡이·암호문·메타만 본다. 평문 경로는 없다.
 *
 * <pre>
 * 열기      open {pcId, hostName, cliVersion, remoteEnabled, sessions[], e2e: 1} — 자기 pc 세션은 목록에서 뺀다. PC 설정이 끔이면 remoteEnabled=false
 * 목록      데몬 watch-sessions 이벤트 · poll 이 돌아올 때마다 ls 를 견줘 바뀐 때만 sessions 로 통째 올린다(메타 — 암호 아님 §2)
 * 채널      poll 의 hello → 고정 핀으로 검증 → welcome(또는 refuse PAIRING_REQUIRED) · cmd confirm(n=0) 복호 뒤에만 활성(remoteChannel.ts)
 * 보기      poll 의 가장 최근 watch {channels:[{channelId, session}]} — 활성 채널의 그 세션만 채널 키로 봉인한 화면을 흘린다
 * 명령      cmd 를 받은 순서 그대로 복호·대조 → 데몬(인스턴스 검사는 데몬이 적용하는 자리에서 §14-6 4) · CRUD 는 봉인 answer(requestId)
 *           input·key·resize 가 거절되면 실행 확인 지점을 올리지 않고 그 채널을 닫는다(A6) · 결번·되감기·복호 실패도 닫는다
 * 원격 상태  poll 의 remote — off-by-web·off-by-pc 면 채널을 모두 닫고(REMOTE_OFF) poll 만 잇는다(웹 PC 줄에 이유가 보인다)
 * 끝        멈춤 신호 → close · 같은 PC 의 다른 다리가 열면(CLOSED REPLACED) 그대로 끝 · 401/403·그 밖 4xx → 사유와 함께 1
 * 다시      네트워크·5xx·기한 초과 → C12 부터 두 배씩 C13 까지 · poll 404 REMOTE_NOT_FOUND(api 재시작) → 같은 PC 로 다시 open(채널은 새 hello)
 * </pre>
 */

export type RemoteOp = "open" | "sessions" | "poll" | "frame" | "answer" | "close" | "welcome" | "channel/close";
export type RemoteHttp = PcHttp<RemoteOp>;
export type RemoteState = "on" | "off-by-pc" | "off-by-web";

/** 다리가 pc 세션 화면에 남기는 원격 상태 줄의 머리 — `ainecto`(start)가 «웹에서 꺼짐»을 이 줄로 알아본다. */
export const REMOTE_STATE_PREFIX = "Remote terminal: ";
/** 웹 «원격 터미널 끊기» 뒤의 줄 — 이 프로세스가 사는 동안 꺼진 채라, start 가 보면 pc 를 다시 띄워 켠다. */
export const REMOTE_OFF_BY_WEB_LINE = `${REMOTE_STATE_PREFIX}turned off from the web.`;

/** 서버가 이 링크를 모른다(api 재시작) — 다시 열기의 유일한 계기. */
const REMOTE_NOT_FOUND = "REMOTE_NOT_FOUND";

/** open 본문의 E2E 판(§14-5) — 서버는 이것이 없으면 CLI_TOO_OLD 로 거절한다. */
const E2E_VERSION = 1;

/**
 * `remote.log` 레코드. ★서버 호출은 {@code remote_call} 1줄 + {@code remote_call_response} 1줄(같은 callId — 공용 입구가 finally 에서 쓴다).
 * 웹 명령은 {@code remote_command} 1줄 + 결과 {@code remote_command_result} 1줄(CRUD 는 requestId 로 잇는다).
 * ★남기지 않는 것: 화면 글자·입력 바이트·명령 줄·폴더·암호문·공개키·난수·토큰·데몬 오류 원문(§11-5 — 코드·길이·수만).
 */
export type RemoteLogRecord =
  | { event: "remote_start"; pid: number; version: string; endpoint: string; host: string; pcId: string; remote: string }
  | { event: "remote_opened"; linkId: string; sessions: number; remote: string; pollHoldSeconds: number; frameMaxBytes: number }
  | { event: "remote_call"; callId: string; op: string; bytes: number }
  | { event: "remote_call_response"; callId: string; op: string; ok: boolean; status?: number; code?: string; error?: string; ms: number;
      state?: string; reason?: string; remote?: string; commands?: number; version?: number }
  /** 서버가 링크를 잊어(api 재시작) 같은 PC 로 다시 열었다. */
  | { event: "remote_reopened"; reason: string; previousLinkId: string; linkId: string; channelsDropped: number }
  /** 원격 상태가 바뀌었다(웹 끊기 등). */
  | { event: "remote_state"; remote: string }
  /** 웹이 보는 (채널, 세션)이 바뀌었다. */
  | { event: "remote_watching"; watching: Array<{ channelId: string; session: string }> }
  /** hello 하나의 판정 — welcome·refused(PAIRING_REQUIRED)·closed(사유)·ignored(아는 channelId). */
  | { event: "remote_hello"; channelId: string; result: "welcome" | "refused" | "closed" | "ignored"; browserKeyId?: string; reason?: string }
  /** 채널이 활성됐다(confirm 복호) 또는 닫혔다(by = pc 면 PC 가 닫고 서버에 알림 · web 이면 웹이 닫음 · local 이면 다리 안에서만). */
  | { event: "remote_channel"; channelId: string; state: "active" | "closed"; by?: "pc" | "web" | "local"; reason?: string; browserKeyId?: string }
  /** 같은 번호·같은 암호문 재도착(확인만) · 모르는 채널의 명령(실행 안 함). */
  | { event: "remote_command_skipped"; channelId: string; n: number; why: "duplicate" | "unknown-channel" | "malformed" }
  | { event: "remote_command"; type: string; channelId: string; n: number; session?: string; opId?: string; requestId?: string; bytes?: number }
  | { event: "remote_command_result"; type: string; channelId: string; n: number; session?: string; requestId?: string; ok: boolean; code?: string;
      executedThrough?: number }
  /** 서버 frame 상한에 맞추려고 위 줄을 덜어 낸 수가 바뀌었다. */
  | { event: "remote_frame_trimmed"; channelId: string; session: string; dropped: number }
  /** 데몬 요청 실패 — 삼키지 않는다. 웹 명령의 실패는 코드만(§11-5), 화면 루프의 실패는 사유까지(내용이 아니다). */
  | { event: "remote_daemon_error"; op: string; session?: string; code: string; message?: string }
  /** hello 를 검증할 신뢰(pc-keys.json)를 못 읽었다 — 그 hello 는 PAIRING_REQUIRED. */
  | { event: "remote_trust_error"; code: string }
  /** 꼬리표를 실은 만들기인데 데몬 응답(info)에 project 가 없다(옛 데몬이 칸을 버림 등) — 세션은 꼬리표 없이 돈다. */
  | { event: "remote_create_project_dropped"; opId: string; session: string }
  /** 거절된 웹 만들기에서 방금 만든 세션 폴더를 지우지 못했다(비어 있지 않음 등) — 폴더는 남고 원래 거절은 그대로. */
  | { event: "remote_session_folder_kept"; opId: string; code: string }
  /** 보던 세션이 데몬에서 이미 끝났다(웹에서 끝낸 직후의 읽기 등) — 오류가 아니다. */
  | { event: "remote_session_ended"; op: string; session: string; code: string }
  | { event: "remote_stop"; pid: number; reason: string; exitCode?: number }
  /** PC 알림 한 건(pcNotify) — 종류·브라우저 키 id·묶인 수·도구. 글 내용은 남기지 않는다. */
  | { event: "pc_notify"; kind: string; browserKeyId: string; more: number; tool: string }
  /** 그 알림의 결과 — 실패는 이유 코드만(도구 stderr 원문 없음 · §11-7). */
  | { event: "pc_notify_result"; kind: string; ok: boolean; tool: string; reason?: string }
  /** 새 기기 허용·기기 관리(approve-new-device) — 단계 하나. 키·숫자·T 는 남기지 않는다(keyId 는 지문이라 남긴다). */
  | { event: "pc_device"; step: string; requestId?: string; keyId?: string; result?: string; reason?: string };

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

/** hello 를 검증할 곳 — 다리는 hello 마다 이 파일을 다시 읽는다(§6: `pair` 가 끝나도 다리를 다시 띄우지 않는다). */
export interface BridgeTrust {
  /** `~/.ainecto/pc-keys.json`. */
  keysPath: string;
  /** 그 파일의 계정 열쇠(`서버#userId` — pcSettings.accountKey). */
  accountKey: string;
  /** 대화 기록의 userId(UUID — 소문자로 바꿔 넣는다). */
  userId: string;
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
  /** 이 계정이 이 PC 에서 웹 터미널을 허용했나(pc.json) — 끔이면 remoteEnabled=false 로 열고 채널을 받지 않는다. */
  remoteEnabled: boolean;
  /** E2E 신뢰 — 계정을 모르면 undefined(모든 hello 가 PAIRING_REQUIRED). */
  trust: BridgeTrust | undefined;
  /** PC 알림(§4-6 · §11-7) — 새 채널 확인·셸 생성·첫 명령 시작. 다리가 끝날 때 모아 둔 것을 내보낸다. */
  notifier: PcNotifier;
  /** 목록에서 뺄 세션 — 이 다리를 돌리는 pc 세션. */
  exclude: readonly string[];
  /** 웹이 만드는 세션의 환경(로컬 `term new` 와 같은 규칙: 다리 프로세스의 환경). */
  sessionEnv: Record<string, string>;
  /** 앱 홈 — 웹이 폴더를 비우고 만들면 그 아래 세션 폴더({@link webSessionFolder}, 0700)를 만들어 그 안에서 시작한다 — 끝내도 남긴다. */
  appHome: string;
  /** 새 기기 허용 요청의 등록 중계(pcPairRelay — requestId 로 연다). 없으면 pair-request 를 받지 않는다(시험·옛 조립). */
  pairRelay?: (requestId: string) => PairTransport;
  /** 끊으면 close 를 보내고 끝낸다. */
  signal: AbortSignal;
  print(line: string): void;
  /**
   * 서버 poll 응답(OPEN)마다 — 서버가 내려 준 npm 꼬리표(cli 칸, 모르면 undefined)와 웹이 지금 보는 세션 수.
   * pc 연결의 자동 업그레이드가 «목표·한가»를 여기서 본다(KAN-738 next.10). 다리는 이 칸을 해석하지 않고 넘기기만 한다.
   */
  onAnswer?: (answer: { tags: CliTags | undefined; watching: number }) => void;
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

interface Watch {
  channelId: string;
  session: string;
}

const viewerKey = (watch: Watch): string => `${watch.channelId}\u0000${watch.session}`;

export async function runRemoteBridge(deps: BridgeDeps): Promise<RemoteResult> {
  let ending: RemoteEnd | undefined;
  const stopper = new AbortController();
  /** (채널, 세션)마다 화면 루프 하나. */
  const viewers = new Map<string, { watch: Watch; viewer: RemoteViewer }>();
  const book = new ChannelBook(deps.pcId);
  let devices: DeviceManager | undefined;
  const end = (outcome: RemoteEnd): void => {
    if (ending) return;
    ending = outcome;
    devices?.stop();
    stopper.abort();
    for (const { viewer } of viewers.values()) viewer.stop();
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
    let link: Link;
    try {
      link = await openLink(deps, 1, deps.remoteEnabled, deps.remoteEnabled ? first : [], undefined);
    } catch (error) {
      return { exitCode: 1, reason: refused(error).reason };
    }
    let remote = startState(deps.remoteEnabled);
    /** 서버에 마지막으로 올린 목록 — 바뀐 때만 올린다. */
    let uploaded = deps.remoteEnabled ? sessionsKey(first) : undefined;
    /** 서버가 마지막으로 알려 준 보기 목록(A1 — 가장 최근 watch 가 전체). 활성 채널만 화면을 받는다. */
    let watchList: Watch[] = [];
    deps.log.write({ event: "remote_opened", linkId: link.linkId, sessions: deps.remoteEnabled ? first.length : 0, remote,
      pollHoldSeconds: link.pollHoldSeconds, frameMaxBytes: link.frameMaxBytes });
    deps.print(deps.remoteEnabled
      ? `${REMOTE_STATE_PREFIX}on — ${first.length} session(s) from ${deps.hostName} are listed in AiNecto on the web.`
      : `${REMOTE_STATE_PREFIX}off on this PC (\`ainecto remote on\` allows it).`);

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
          for (const { viewer } of viewers.values()) viewer.refresh();
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

    /** 그 채널의 화면 루프를 모두 멈춘다. */
    const stopViewers = (channelId: string): void => {
      for (const [key, { watch, viewer }] of viewers) {
        if (watch.channelId !== channelId) continue;
        viewer.stop();
        viewers.delete(key);
      }
    };
    /** 그 채널의 화면을 다시 보낸다(실행 확인 지점이 올랐다). */
    const refreshChannel = (channelId: string): void => {
      for (const { watch, viewer } of viewers.values()) {
        if (watch.channelId === channelId) viewer.refresh();
      }
    };
    /** PC 가 채널을 닫는다 — 장부에서 지우고 화면을 멈추고 서버에 사유(A7 허용 목록)를 알린다. */
    const closeChannel = async (channelId: string, reason: CloseReason, browser?: ChannelBrowser): Promise<void> => {
      book.drop(channelId);
      stopViewers(channelId);
      commands.forgetChannel(channelId);
      deps.log.write({ event: "remote_channel", channelId, state: "closed", by: "pc", reason, ...(browser ? { browserKeyId: browser.keyId } : {}) });
      try {
        await deps.http.call("channel/close", { linkId: link.linkId, channelId, reason }, { signal: stopper.signal });
      } catch {
        // 응답 줄은 공용 입구가 남겼다 — 서버는 링크와 같은 수명으로 채널을 버린다.
      }
    };
    /** 채널을 모두 닫는다(원격 끔). */
    const closeAllChannels = async (reason: CloseReason): Promise<void> => {
      for (const channelId of book.dropAll()) {
        stopViewers(channelId);
        commands.forgetChannel(channelId);
        deps.log.write({ event: "remote_channel", channelId, state: "closed", by: "pc", reason });
        try {
          await deps.http.call("channel/close", { linkId: link.linkId, channelId, reason }, { signal: stopper.signal });
        } catch {
          // 응답 줄은 공용 입구가 남겼다.
        }
      }
    };

    const viewerFor = (watch: Watch, size: { cols: number; rows: number }): RemoteViewer => {
      const key = viewerKey(watch);
      const viewer = new RemoteViewer({
        paths: deps.paths, session: watch.session, channelId: watch.channelId, http: deps.http, log: deps.log, link: () => link, size,
        seal: (body) => book.seal(watch.channelId, { kind: "frame", session: watch.session }, { ...body }),
        executedThrough: () => book.executedThrough(watch.channelId),
        onGone: () => {
          if (viewers.get(key)?.viewer === viewer) viewers.delete(key);
          void syncList();
        },
        onRefused: (error) => end(refused(error)),
        onUnknownSession: () => {
          uploaded = undefined;   // 서버 목록이 이 세션을 모른다 — 다시 올린다
          void syncList();
        },
        onChannelEnded: (reason) => {
          if (viewers.get(key)?.viewer === viewer) viewers.delete(key);
          if (reason !== "CHANNEL_GONE") void closeChannel(watch.channelId, reason);
        },
      });
      void viewer.run();
      return viewer;
    };
    /** 보기 목록에 맞춰 화면 루프를 켜고 끈다 — 활성 채널만. */
    const applyWatching = async (): Promise<void> => {
      const wanted = remote === "on" ? watchList.filter((watch) => book.isActive(watch.channelId)) : [];
      const wantedKeys = new Set(wanted.map(viewerKey));
      let changed = false;
      for (const [key, { viewer }] of viewers) {
        if (!wantedKeys.has(key)) {
          viewer.stop();
          viewers.delete(key);
          changed = true;
        }
      }
      const missing = wanted.filter((watch) => !viewers.has(viewerKey(watch)));
      if (missing.length > 0) {
        const sizes = new Map((await currentSessions(deps).catch(() => [])).map((s) => [s.name, { cols: s.cols, rows: s.rows }]));
        for (const watch of missing) {
          const size = sizes.get(watch.session);
          if (size && !viewers.has(viewerKey(watch))) {
            viewers.set(viewerKey(watch), { watch, viewer: viewerFor(watch, size) });
            changed = true;
          }
        }
      }
      if (changed) deps.log.write({ event: "remote_watching", watching: [...viewers.values()].map(({ watch }) => watch) });
    };
    const applyRemote = async (next: RemoteState): Promise<void> => {
      if (next === remote) return;
      remote = next;
      deps.log.write({ event: "remote_state", remote });
      if (remote === "on") {
        uploaded = undefined;
        void syncList();
        deps.print(`${REMOTE_STATE_PREFIX}on.`);
      } else {
        devices?.stop();
        await closeAllChannels("REMOTE_OFF");
        deps.print(remote === "off-by-web"
          ? `${REMOTE_OFF_BY_WEB_LINE} Run \`ainecto\` (or \`ainecto remote on\`) on this PC to turn it back on.`
          : `${REMOTE_STATE_PREFIX}off on this PC (\`ainecto remote on\` allows it).`);
      }
    };

    /** hello 하나 — 원격이 꺼졌으면 REMOTE_OFF, 아니면 장부가 판정하고 그대로 서버에 답한다. */
    const onHello = async (channelId: string, hello: unknown): Promise<void> => {
      if (remote !== "on") {
        deps.log.write({ event: "remote_hello", channelId, result: "closed", reason: "REMOTE_OFF" });
        await closeChannel(channelId, "REMOTE_OFF");
        return;
      }
      const outcome = await book.hello(channelId, hello, await loadTrust(deps));
      switch (outcome.type) {
        case "ignored":
          deps.log.write({ event: "remote_hello", channelId, result: "ignored" });
          return;
        case "close":
          deps.log.write({ event: "remote_hello", channelId, result: "closed", reason: outcome.reason });
          await closeChannel(channelId, outcome.reason);
          return;
        case "refuse":
          deps.log.write({ event: "remote_hello", channelId, result: "refused", reason: "PAIRING_REQUIRED" });
          try {
            await deps.http.call("welcome", { linkId: link.linkId, channelId, refuse: "PAIRING_REQUIRED" }, { signal: stopper.signal });
          } catch {
            // 응답 줄은 공용 입구가 남겼다 — 웹은 welcome 을 못 받아 다시 연다.
          }
          return;
        case "welcome":
          deps.log.write({ event: "remote_hello", channelId, result: "welcome", browserKeyId: outcome.browser.keyId });
          try {
            await deps.http.call("welcome", { linkId: link.linkId, channelId, welcome: outcome.welcome }, { signal: stopper.signal });
          } catch {
            // 응답 줄은 공용 입구가 남겼다 — 받지 못한 welcome 의 후보는 버린다(웹이 새 hello 로 다시 연다).
            book.drop(channelId);
            deps.log.write({ event: "remote_channel", channelId, state: "closed", by: "local", reason: "welcome-not-delivered" });
          }
          return;
      }
    };

    /** 그 브라우저 키의 채널을 모두 닫는다(기기 지우기 — 연결 중·활성 · 화면 구독·대기 명령까지). */
    const closeKey = async (keyId: string): Promise<void> => {
      for (const channelId of book.dropBrowser(keyId)) {
        stopViewers(channelId);
        commands.forgetChannel(channelId);
        deps.log.write({ event: "remote_channel", channelId, state: "closed", by: "pc", reason: "PAIRING_REQUIRED", browserKeyId: keyId });
        try {
          await deps.http.call("channel/close", { linkId: link.linkId, channelId, reason: "PAIRING_REQUIRED" }, { signal: stopper.signal });
        } catch {
          // 응답 줄은 공용 입구가 남겼다 — PC 장부에서는 이미 지웠다(그 채널의 명령은 이제 unknown-channel).
        }
      }
    };
    if (deps.trust && deps.pairRelay) {
      const trust = deps.trust;
      const relay = deps.pairRelay;
      devices = new DeviceManager({
        keysPath: trust.keysPath,
        accountKey: trust.accountKey,
        userId: trust.userId,
        pcId: deps.pcId,
        relay,
        notifyRequest: (name) => void deps.notifier.notify({ kind: "device-request", keyId: "device-request", browserName: name }),
        log: (record) => deps.log.write(record),
        closeKey,
        remoteOn: () => remote === "on" && !ending,
      });
    }
    const commands = new CommandRunner(deps, control, book, () => remote, () => link.linkId, stopper.signal, {
      devices: () => devices,
      trusted: async (keyId) => (await loadTrust(deps))?.browsers.some((item) => item.keyId === keyId) === true,
      closeChannel,
      refreshChannel,
      resized: (session, size) => {
        for (const { watch, viewer } of viewers.values()) {
          if (watch.session === session) viewer.setSize(size);
        }
      },
      applyWatching,
    });
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
          // ★서버가 채널을 모두 잊었다 — 채널은 늘 새 hello 다(§11-2). 서버에 알릴 것도 없다. 진행 중 허용도 끝낸다(그 요청은 옛 링크의 것).
          devices?.stop();
          const dropped = book.dropAll();
          for (const channelId of dropped) {
            stopViewers(channelId);
            commands.forgetChannel(channelId);
          }
          watchList = [];
          deps.log.write({ event: "remote_reopened", reason: REMOTE_NOT_FOUND, previousLinkId: previous.linkId, linkId: link.linkId,
            channelsDropped: dropped.length });
          deps.print("AiNecto lost the remote terminal (it may have restarted); opened it again.");
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
      if (state) await applyRemote(state);
      for (const channelId of book.expired()) {
        await closeChannel(channelId, "HANDSHAKE_EXPIRED");
      }
      for (const item of pollItems(answer)) {
        if (ending) break;
        switch (item.type) {
          case "hello":
            await onHello(item.channelId, item.hello);
            break;
          case "cmd":
            await commands.run(item.command);
            break;
          case "bad-cmd":
            // 모양이 틀린 명령 — 실행하지 않는다. 아는 채널이면 검증 실패로 닫는다(그 뒤 번호는 어차피 결번이다).
            deps.log.write({ event: "remote_command_skipped", channelId: item.channelId, n: item.n, why: "malformed" });
            if (book.has(item.channelId)) await closeChannel(item.channelId, "DECRYPT_FAILED");
            break;
          case "watch":
            watchList = item.channels;
            break;
          case "pair-request":
            await devices?.onPairRequest(item.requestId);
            break;
          case "channel-closed":
            if (book.drop(item.channelId)) {
              deps.log.write({ event: "remote_channel", channelId: item.channelId, state: "closed", by: "web" });
            }
            stopViewers(item.channelId);
            commands.forgetChannel(item.channelId);
            break;
        }
      }
      await applyWatching();
      deps.onAnswer?.({ tags: cliTagsOf(answer.cli), watching: viewers.size });
      await syncList();
    }

    const outcome = ending ?? { exitCode: 1, reason: "The remote terminal stopped.", close: true };
    await syncing;
    await deps.notifier.flush();
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
    for (const { viewer } of viewers.values()) viewer.stop();
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
    pcId: deps.pcId, hostName: deps.hostName, cliVersion: deps.cliVersion, remoteEnabled, sessions, e2e: E2E_VERSION,
    // 새 기기 허용·기기 관리를 안다(approve-new-device §3-4) — 서버는 이 표시가 있는 링크에만 pair-request·device 를 보낸다.
    // ★옛 서버는 모르는 칸을 400 으로 거절한다 — 배포는 api 먼저(§7).
    ...(deps.trust && deps.pairRelay ? { devices: true } : {}),
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

/** hello 마다 — pc-keys.json 의 이 계정(PC 키·짝지은 브라우저). 없거나 못 읽으면 undefined(PAIRING_REQUIRED). */
async function loadTrust(deps: BridgeDeps): Promise<HelloTrust | undefined> {
  if (!deps.trust) return undefined;
  try {
    const account = (await loadPcKeys(deps.trust.keysPath)).accounts[deps.trust.accountKey];
    return account ? { userId: transcriptUserId(deps.trust.userId), pcKey: account.pcKey, browsers: account.browsers } : undefined;
  } catch (error) {
    deps.log.write({ event: "remote_trust_error", code: errorCode(error) });
    return undefined;
  }
}

/** 다시 하지 않을 서버 거절 — 사유와 함께 1. 새 CLI 가 아직 옛 서버를 만나면(open 400 INVALID — §11-6) 그렇게 말한다. */
function refused(error: unknown): RemoteEnd {
  if (error instanceof PcCallError && error.op === "open" && error.status === 400 && error.code === "INVALID") {
    return { exitCode: 1, reason: "AiNecto's server is not on the new version yet — run `ainecto start` again in a few minutes.", close: false };
  }
  const what = error instanceof PcCallError
    ? `${error.op}: ${error.status ?? "-"} ${error.code ?? ""} ${error.message}`.replace(/\s+/g, " ")
    : error instanceof Error ? error.message : String(error);
  return { exitCode: 1, reason: `AiNecto refused the remote terminal (${what}).`, close: true };
}

function forgotten(error: unknown): boolean {
  return error instanceof PcCallError && error.status === 404 && error.code === REMOTE_NOT_FOUND;
}

function errorCode(error: unknown): string {
  if (error instanceof TermError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "UNKNOWN";
}

function daemonFailed(deps: BridgeDeps, op: string, session: string | undefined, error: unknown): void {
  deps.log.write({ event: "remote_daemon_error", op, ...(session ? { session } : {}),
    code: errorCode(error), message: error instanceof Error ? error.message : String(error) });
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

interface RunnerHooks {
  /** 기기 관리 — 없으면 device 명령은 거절 답. */
  devices(): DeviceManager | undefined;
  /** 그 브라우저 키가 지금 핀에 있나(confirm 때 다시 본다 — hello 뒤 지운 키가 활성되지 않게). */
  trusted(keyId: string): Promise<boolean>;
  closeChannel(channelId: string, reason: CloseReason, browser?: ChannelBrowser): Promise<void>;
  refreshChannel(channelId: string): void;
  /** 세션 크기가 바뀌었다(데몬 set-size 의 적용값) — 그 세션을 보는 모든 화면 루프에. */
  resized(session: string, size: { cols: number; rows: number }): void;
  applyWatching(): Promise<void>;
}

/** 명령 하나의 데몬 결과 — 답에 실을 인스턴스(만들기는 새 세션의 것). */
interface Applied {
  instance?: string;
}

/**
 * poll 의 cmd 를 채널 장부로 복호·대조한 뒤 데몬으로 — 받은 순서 그대로. 결과는 명령 1줄 + 결과 1줄. CRUD 는 봉인 answer 로 돌려준다.
 * 실행 확인 지점(executedThrough)은 데몬 실행이 확인된 때만 오른다(A6) — 오르면 그 채널의 화면을 다시 보낸다(§14-6 1).
 */
class CommandRunner {
  /** 여러 바이트 글자가 메시지 경계에서 갈려도 잇는다 — (채널, 세션)마다(바이트는 그대로, 글자로 바꾸는 곳만 한 곳). */
  private readonly decoders = new Map<string, StringDecoder>();

  constructor(
    private readonly deps: BridgeDeps,
    private readonly control: DaemonControl,
    private readonly book: ChannelBook,
    private readonly remote: () => RemoteState,
    private readonly linkId: () => string,
    private readonly stopSignal: AbortSignal,
    private readonly hooks: RunnerHooks,
  ) {}

  forgetChannel(channelId: string): void {
    for (const key of this.decoders.keys()) {
      if (key.startsWith(`${channelId}\u0000`)) this.decoders.delete(key);
    }
  }

  /** cmd 하나 — 목록 올리기는 poll 한 바퀴 끝에 다리가 한다(바뀐 때만 올라간다). */
  async run(wire: WireCommand): Promise<void> {
    const outcome = await this.book.receive(wire);
    switch (outcome.type) {
      case "unknown":
        this.deps.log.write({ event: "remote_command_skipped", channelId: wire.channelId, n: wire.n, why: "unknown-channel" });
        return;
      case "duplicate":
        this.deps.log.write({ event: "remote_command_skipped", channelId: wire.channelId, n: wire.n, why: "duplicate" });
        return;
      case "close":
        await this.hooks.closeChannel(wire.channelId, outcome.reason);
        return;
      case "confirmed":
        if (!(await this.hooks.trusted(outcome.browser.keyId))) {
          // hello 를 검증한 뒤 그 키가 지워졌다 — 활성하지 않는다.
          await this.hooks.closeChannel(wire.channelId, "PAIRING_REQUIRED", outcome.browser);
          return;
        }
        this.deps.log.write({ event: "remote_channel", channelId: wire.channelId, state: "active", browserKeyId: outcome.browser.keyId });
        // ★키 소유 확인 뒤에만 «웹 세션 열림»(§11-2·§11-7) — hello 만으로는 알리지 않는다.
        void this.deps.notifier.notify({ kind: "session", keyId: outcome.browser.keyId, browserName: outcome.browser.name });
        await this.hooks.applyWatching();
        return;
      case "command":
        if (outcome.command.kind === "device") await this.device(wire, outcome.command, outcome.browser);
        else await this.execute(wire, outcome.command, outcome.browser);
        return;
    }
  }

  /** 기기 관리 명령(approve-new-device §3-4) — 답 봉투 {opId, kind:"device", ok, detail?, result}. 세션 없음(AAD session ""). */
  private async device(wire: WireCommand, command: Extract<ChannelCommand, { kind: "device" }>, browser: ChannelBrowser): Promise<void> {
    this.deps.log.write({ event: "remote_command", type: "device", channelId: wire.channelId, n: wire.n, opId: command.opId,
      ...(wire.requestId ? { requestId: wire.requestId } : {}) });
    const devices = this.hooks.devices();
    let failure: { code: string; message: string } | undefined;
    let result: Record<string, unknown> = {};
    if (this.remote() !== "on") {
      failure = { code: "REMOTE_OFF", message: "Terminals from the web are turned off on this PC." };
    } else if (!devices) {
      failure = { code: "TERM_BAD_REQUEST", message: "This PC cannot manage devices (account unknown)." };
    } else {
      try {
        result = await devices.command(command.action, browser);
      } catch (error) {
        failure = { code: errorCode(error), message: error instanceof Error ? error.message : String(error) };
      }
    }
    let box: { n: number; c: string };
    try {
      box = await this.book.seal(wire.channelId, { kind: "answer", session: "", opId: command.opId }, {
        opId: command.opId,
        kind: "device",
        ok: failure === undefined,
        ...(failure ? { detail: `${failure.code}: ${failure.message}` } : {}),
        result,
      });
    } catch (error) {
      // 자기 키를 지웠으면 채널이 이미 닫혔다 — 답은 못 간다(웹은 «결과 미확정» → 다른 기기의 목록으로 확인).
      const reason = error instanceof ChannelSealError && error.reason !== "CHANNEL_GONE" ? error.reason : undefined;
      this.logResult(wire, "device", "", false, failure?.code ?? reason ?? "CHANNEL_GONE");
      if (reason) await this.hooks.closeChannel(wire.channelId, reason);
      return;
    }
    if (wire.requestId) {
      try {
        await this.deps.http.call("answer", {
          linkId: this.linkId(), requestId: wire.requestId, channelId: wire.channelId, ...box, ok: failure === undefined,
          ...(failure ? { code: answerCodeOf(failure.code) } : {}),
        }, { signal: this.stopSignal });
      } catch {
        // 응답 줄은 공용 입구가 남겼다 — 웹은 기한이면 «결과 미확정».
      }
    }
    const raised = this.book.executed(wire.channelId, wire.n);
    this.logResult(wire, "device", "", failure === undefined, failure?.code, raised ? wire.n : undefined);
    if (raised) this.hooks.refreshChannel(wire.channelId);
  }

  private async execute(wire: WireCommand, command: Exclude<ChannelCommand, { kind: "confirm" | "device" }>, browser: ChannelBrowser): Promise<void> {
    const session = command.kind === "create" ? command.name : command.session;
    const opId = "opId" in command ? command.opId : undefined;
    this.deps.log.write({ event: "remote_command", type: command.kind, channelId: wire.channelId, n: wire.n, session,
      ...(opId ? { opId } : {}), ...(wire.requestId ? { requestId: wire.requestId } : {}),
      ...(command.kind === "input" ? { bytes: command.bytes.length } : {}) });
    let failure: { code: string; message: string } | undefined;
    let applied: Applied = {};
    if (this.remote() !== "on") {
      // ★이중 거절 — 서버가 먼저 막지만 PC 도 원격이 꺼졌으면 하지 않는다.
      failure = { code: "REMOTE_OFF", message: "Terminals from the web are turned off on this PC." };
    } else if (this.deps.exclude.includes(session)) {
      failure = { code: "TERM_NO_SESSION", message: `No session named "${session}".` };
    } else {
      try {
        applied = await this.apply(wire.channelId, command);
      } catch (error) {
        failure = { code: errorCode(error), message: error instanceof Error ? error.message : String(error) };
        // ★코드만 — 원문(경로 등)은 봉인 답의 detail 에만(§11-5). 원인은 데몬 로그의 응답 줄에 있다.
        this.deps.log.write({ event: "remote_daemon_error", op: command.kind, session, code: failure.code });
      }
    }
    const crud = command.kind === "create" || command.kind === "kill" || command.kind === "label";
    if (!crud && failure) {
      // 답 없는 명령이 거절됐다 — 실행 확인 지점을 올리지 않고 채널을 닫는다(결번과 같은 처리 — A6).
      this.logResult(wire, command.kind, session, false, failure.code);
      await this.hooks.closeChannel(wire.channelId, failure.code === "SESSION_REPLACED" ? "SESSION_REPLACED"
        : failure.code === "REMOTE_OFF" ? "REMOTE_OFF" : "COMMAND_FAILED", browser);
      return;
    }
    if (command.kind === "create" && !failure) {
      // 데몬이 실제로 만든 뒤에만(§11-7) — 첫 명령이 있으면 «명령 시작», 없으면 «새 셸». 명령 원문·폴더는 싣지 않는다.
      void this.deps.notifier.notify({ kind: command.command !== undefined && command.command.trim() !== "" ? "command" : "shell",
        keyId: browser.keyId, browserName: browser.name });
    }
    if (crud && !(await this.answer(wire, command, applied, failure))) return;   // 봉인 못 함 — 채널을 닫았다
    const raised = this.book.executed(wire.channelId, wire.n);
    this.logResult(wire, command.kind, session, failure === undefined, failure?.code, raised ? wire.n : undefined);
    if (raised) this.hooks.refreshChannel(wire.channelId);
  }

  /** CRUD 답 — 봉인 본문 {opId, kind, session?, instance?, ok, detail?} · 바깥 code 는 허용 목록만(A7). 봉인을 못 하면 채널을 닫고 false. */
  private async answer(wire: WireCommand, command: Extract<ChannelCommand, { kind: "create" | "kill" | "label" }>, applied: Applied,
    failure: { code: string; message: string } | undefined): Promise<boolean> {
    const session = command.kind === "create" ? command.name : command.session;
    const projectUuid = command.kind === "create" ? command.projectUuid : undefined;
    let box: { n: number; c: string };
    try {
      box = await this.book.seal(wire.channelId, { kind: "answer", session, opId: command.opId, ...(projectUuid ? { projectUuid } : {}) }, {
        opId: command.opId,
        kind: command.kind,
        session,
        ...(applied.instance ? { instance: applied.instance } : {}),
        ok: failure === undefined,
        ...(failure ? { detail: `${failure.code}: ${failure.message}` } : {}),
      });
    } catch (error) {
      const reason = error instanceof ChannelSealError && error.reason !== "CHANNEL_GONE" ? error.reason : "COMMAND_FAILED";
      this.logResult(wire, command.kind, session, false, failure?.code ?? reason);
      await this.hooks.closeChannel(wire.channelId, reason);
      return false;
    }
    if (!wire.requestId) return true;   // 서버 상관 id 가 없으면 돌려줄 곳이 없다(결과 줄은 남는다)
    try {
      await this.deps.http.call("answer", {
        linkId: this.linkId(), requestId: wire.requestId, channelId: wire.channelId, ...box, ok: failure === undefined,
        ...(failure ? { code: answerCodeOf(failure.code) } : {}),
      }, { signal: this.stopSignal });
    } catch {
      // 응답 줄은 공용 입구가 남겼다 — 웹은 기한(504 ANSWER_TIMEOUT)이면 «결과 미확정»(§13-1).
    }
    return true;
  }

  private logResult(wire: WireCommand, type: string, session: string, ok: boolean, code?: string, executedThrough?: number): void {
    this.deps.log.write({ event: "remote_command_result", type, channelId: wire.channelId, n: wire.n, session,
      ...(wire.requestId ? { requestId: wire.requestId } : {}), ok, ...(code ? { code } : {}),
      ...(executedThrough !== undefined ? { executedThrough } : {}) });
  }

  /**
   * 명령 하나를 데몬에 — ★세션을 겨누는 명령은 인스턴스를 싣는다. 비교는 데몬이 적용하는 자리에서(§14-6 4 — 여기서 미리 보지 않는다).
   * 데몬 응답에 인스턴스가 없으면 옛 데몬이다(검사를 하지 않았다) — 실패로 친다.
   */
  private async apply(channelId: string, command: Exclude<ChannelCommand, { kind: "confirm" | "device" }>): Promise<Applied> {
    switch (command.kind) {
      case "input": {
        const key = `${channelId}\u0000${command.session}`;
        let decoder = this.decoders.get(key);
        if (!decoder) {
          decoder = new StringDecoder("utf8");
          this.decoders.set(key, decoder);
        }
        const text = decoder.write(command.bytes);
        if (text === "") return {};
        return { ...checked(await this.control.request({ op: "send", name: command.session, text, paste: false,
          instance: command.instance })) };
      }
      case "key":
        // 이름 목록·바이트(커서키 모드)는 데몬 keys.ts 가 안다 — 모르는 이름이면 TERM_UNKNOWN_KEY.
        return { ...checked(await this.control.request({ op: "key", name: command.session, key: command.key,
          instance: command.instance })) };
      case "resize": {
        const result = await termRequest(this.deps.paths, { op: "set-size", name: command.session, cols: command.cols, rows: command.rows,
          instance: command.instance }, { start: false });
        if (!result.daemon) throw new TermError("TERM_DAEMON_GONE", "No term daemon is running.");
        const applied = appliedSize(result.data);
        if (!applied) throw new TermError("TERM_BAD_RESPONSE", "The term daemon answered set-size without cols and rows.");
        const instance = checked(result.data);
        this.hooks.resized(command.session, applied);
        return instance;
      }
      case "create": {
        // 폴더를 주면 그대로(절대 만들거나 지우지 않는다) · 비면 세션 폴더를 만들고, 거절되면 방금 만든 것만 지운다.
        // 프로젝트 꼬리표는 폴더를 주든 말든 같은 검사(isUuid)를 지나야 데몬에 간다.
        const project = command.projectUuid;
        if (project !== undefined && !isUuid(project)) {
          throw new TermError("TERM_BAD_REQUEST", `The project "${project}" is not a UUID, so the session was not made.`);
        }
        let cwd = command.cwd;
        let made: string | undefined;
        if (cwd === undefined) {
          const fresh = await this.sessionFolder(project, command.opId);
          cwd = fresh.folder;
          if (fresh.made) made = fresh.folder;
        }
        let created: unknown;
        try {
          created = await this.control.request({
            op: "new",
            name: command.name,
            cwd,
            command: command.command === undefined ? null : shellLineCommand(command.command, this.deps.sessionEnv),
            env: this.deps.sessionEnv,
            ...(project !== undefined ? { project } : {}),
          });
        } catch (error) {
          if (made) await this.dropSessionFolder(command.opId, made);
          throw error;
        }
        if (project !== undefined && createdProject(created) !== project) {
          this.deps.log.write({ event: "remote_create_project_dropped", opId: command.opId, session: command.name });
        }
        const instance = sessionInstance(created);
        return instance ? { instance } : {};
      }
      case "kill": {
        const instance = checked(await this.control.request({ op: "kill", name: command.session, instance: command.instance }));
        this.forgetSession(command.session);
        return instance;
      }
      case "label": {
        const result = await termRequest(this.deps.paths, { op: "label", name: command.session, label: command.label, instance: command.instance },
          { start: false });
        if (!result.daemon) throw new TermError("TERM_DAEMON_GONE", "No term daemon is running.");
        return checked(result.data);
      }
    }
  }

  private forgetSession(session: string): void {
    for (const key of this.decoders.keys()) {
      if (key.endsWith(`\u0000${session}`)) this.decoders.delete(key);
    }
  }

  /**
   * 웹이 폴더를 비운 만들기 — {@link webSessionFolder}(꼬리표가 있으면 프로젝트 아래)를 만든다. 폴더 이름은 브라우저가 봉인 전에 정한
   * 연산 ID(UUID — 만들기마다 새 값, §12-2)라 세션마다 새 폴더가 되고, remote_command 로그 줄(같은 opId)로 어느 만들기의 폴더인지 잇는다.
   */
  private async sessionFolder(projectUuid: string | undefined, opId: string): Promise<{ folder: string; made: boolean }> {
    const folder = webSessionFolder(this.deps.appHome, projectUuid, opId);
    const made = !existsSync(folder);
    await ensurePrivateDir(folder);
    return { folder, made };
  }

  /** 거절된 만들기 — 방금 만든 세션 폴더를 비어 있을 때만 지운다(rmdir, 재귀 아님). 못 지우면 한 줄 남기고 넘어간다. */
  private async dropSessionFolder(opId: string, folder: string): Promise<void> {
    try {
      await rmdir(folder);
    } catch (error) {
      this.deps.log.write({ event: "remote_session_folder_kept", opId, code: errorCode(error) });
    }
  }
}

/** 세션을 겨눈 데몬 응답의 인스턴스 — 없으면 옛 데몬(인스턴스 검사를 하지 않았다)이라 실패. */
function checked(data: unknown): { instance: string } {
  const instance = sessionInstance(data);
  if (!instance) {
    throw new TermError("TERM_DAEMON_OUTDATED", "The term daemon is older than this CLI (no session instance) — restart it with `ainecto term kill-server`.");
  }
  return { instance };
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

/** 데몬 `new` 응답(세션 info)의 프로젝트 꼬리표 — 없으면(옛 데몬) undefined. 순수 함수. */
function createdProject(data: unknown): string | undefined {
  return data && typeof data === "object" && "project" in data && typeof data.project === "string" ? data.project : undefined;
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

/** poll 의 commands 항목(A1) — hello·cmd·watch·channel-closed 넷. */
export type PollItem =
  | { type: "hello"; channelId: string; hello: unknown }
  | { type: "cmd"; command: WireCommand }
  /** 채널은 알지만 모양이 틀린 cmd — 실행하지 않고 한 줄 남긴다(다음 번호가 결번이 되어 그 채널은 닫힌다). */
  | { type: "bad-cmd"; channelId: string; n: number }
  | { type: "watch"; channels: Watch[] }
  | { type: "channel-closed"; channelId: string }
  /** 새 기기 허용 요청(approve-new-device §3-1) — 평문 · 서버가 만들 수 있다(시도를 여는 계기일 뿐 — 신뢰는 양쪽 동의로만). */
  | { type: "pair-request"; requestId: string };

/** poll 의 commands — 서버가 준 순서 그대로. 모르는 종류·모양 틀림은 뺀다(채널을 알 수 있는 cmd 는 bad-cmd). 순수 함수. */
export function pollItems(answer: Record<string, unknown>): PollItem[] {
  if (!Array.isArray(answer.commands)) return [];
  return answer.commands.flatMap((raw: unknown): PollItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const channelId = typeof item.channelId === "string" && item.channelId !== "" ? item.channelId : undefined;
    switch (item.type) {
      case "hello":
        return channelId ? [{ type: "hello", channelId, hello: item.hello }] : [];
      case "cmd": {
        const command = wireCommand(item);
        if (command) return [{ type: "cmd", command }];
        return channelId ? [{ type: "bad-cmd", channelId, n: typeof item.n === "number" ? item.n : -1 }] : [];
      }
      case "watch":
        return [{ type: "watch", channels: Array.isArray(item.channels) ? item.channels.flatMap((entry: unknown): Watch[] => {
          if (!entry || typeof entry !== "object") return [];
          const watch = entry as Record<string, unknown>;
          return typeof watch.channelId === "string" && watch.channelId !== "" && typeof watch.session === "string" && watch.session !== ""
            ? [{ channelId: watch.channelId, session: watch.session }]
            : [];
        }) : [] }];
      case "channel-closed":
        return channelId ? [{ type: "channel-closed", channelId }] : [];
      case "pair-request":
        return typeof item.requestId === "string" && item.requestId !== "" ? [{ type: "pair-request", requestId: item.requestId }] : [];
      default:
        return [];
    }
  });
}
