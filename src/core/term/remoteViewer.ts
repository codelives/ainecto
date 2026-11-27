import { sleep } from "../async/sleep";
import { PcCallError } from "../http/pcHttp";
import { openTermClient, type TermClient } from "./client";
import type { DaemonLog } from "./daemonLog";
import { TermError } from "./errors";
import type { TermPaths } from "./paths";
import { readLines, readModes, readStyles, sessionInstance } from "./protocol";
import type { RemoteHttp, RemoteLogRecord } from "./remote";
import { ChannelSealError, type CloseReason } from "./remoteChannel";
import { frameBudget, screenFrame } from "./remoteFrame";
import type { CellStyle, ScreenCursor } from "./screen";
import { FRAME_MIN_INTERVAL_MS, FRAME_SCROLLBACK_LINES, retryWait } from "./remoteLimits";

/** 지금 이어진 링크 — 서버가 잊어 다시 열면 세대가 바뀐다. */
export interface ViewerLink {
  linkId: string;
  generation: number;
  frameMaxBytes: number;
}

/**
 * 봉인 frame 본문(§14-4 · A6) — d = base64(UTF-8 화면) · instance = 이 화면을 읽은 세션 객체의 인스턴스 id.
 * styles·runs·cursor = 글자 속성 표·줄마다 구간·커서(선택 — 옛 데몬이면 없다, 웹은 없으면 글자만 그린다. 모양은 screen.ts StyledScreen).
 */
export interface FrameBody {
  d: string;
  modes?: { altScreen: boolean; appCursor: boolean; bracketedPaste: boolean; mouse?: boolean };
  styles?: CellStyle[];
  runs?: number[][];
  cursor?: ScreenCursor;
  instance: string;
  executedThrough: number;
}

export interface ViewerDeps {
  paths: TermPaths;
  session: string;
  /** 이 화면을 받는 채널(연결) — 채널마다 따로 봉인한다(§11-2 구독 = (연결, 세션)). */
  channelId: string;
  http: RemoteHttp;
  log: DaemonLog<RemoteLogRecord>;
  link(): ViewerLink;
  size: { cols: number; rows: number };
  /** 세션이 끝났거나 데몬이 그 세션을 모른다 — 다리가 목록을 다시 올린다. */
  onGone(reason: string): void;
  /** 다시 하지 않을 서버 거절(4xx) — 다리가 끝낼지 정한다. */
  onRefused(error: unknown): void;
  /** 서버 목록이 이 세션을 아직 모른다(SESSION_NOT_FOUND) — 다리가 목록을 올린다. */
  onUnknownSession(): void;
  /** 그 채널 키로 봉인 — 번호는 채널 장부가 정한다(remoteChannel.ChannelBook.seal). */
  seal(body: FrameBody): Promise<{ n: number; c: string }>;
  /** 그 채널의 연속 실행 확인 지점 — 없으면(채널이 닫힘) undefined. */
  executedThrough(): number | undefined;
  /** 봉인을 못 한다(채널 닫힘·번호 다 씀) — 다리가 그 채널을 이 사유로 닫는다. */
  onChannelEnded(reason: CloseReason | "CHANNEL_GONE"): void;
}

/**
 * 한 채널이 보고 있는 세션 하나의 화면 루프 — 데몬 watch 의 «바뀜» → C9 간격 이상으로 read(스크롤백 C10 + 화면 줄, 모드·인스턴스 포함) →
 * 글자·크기·모드·인스턴스·executedThrough 가 바뀐 때만 봉인 frame. 한 번에 하나, 밀린 것은 최신 하나로. (채널, 세션)마다 데몬 연결 하나.
 * ★executedThrough 가 오르면 화면 글자가 그대로여도 다시 보낸다(§14-6 1 — 에코 없는 실행도 웹이 «실행됨»을 안다).
 *   read «전에» 그 값을 잡는다 — 실려 가는 화면은 늘 그 실행 뒤의 화면이다.
 * ★원격의 생사는 poll 한 곳이 정한다 — frame 이 REMOTE_NOT_FOUND 면 그 세대에서 멈추고 다리가 다시 열기를 기다린다.
 */
export class RemoteViewer {
  private readonly stopper = new AbortController();
  private dirty = true;
  private wakeUp: (() => void) | undefined;
  private size: { cols: number; rows: number };
  private client: TermClient | undefined;
  /** 마지막으로 읽은 화면의 세션 uuid — 다시 붙을 때 그 세션만 watch 한다. */
  private instance: string | undefined;
  private reconnecting: Promise<boolean> | undefined;

  constructor(private readonly deps: ViewerDeps) {
    this.size = deps.size;
  }

  get stopped(): boolean {
    return this.stopper.signal.aborted;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopper.abort();
    this.nudge();
    this.client?.close();
  }

  /** 세션 크기가 바뀌었다(웹 패널 크기 → 데몬 set-size) — 다시 올린다. */
  setSize(size: { cols: number; rows: number }): void {
    this.size = size;
    this.refresh();
  }

  /** 다시 그려 보낸다(다시 열린 링크·목록을 올린 뒤·실행 확인 지점이 오른 뒤). */
  refresh(): void {
    this.dirty = true;
    this.nudge();
  }

  async run(): Promise<void> {
    if (await this.connect()) await this.loop();
  }

  /**
   * 데몬에 붙어 이 세션을 watch 한다 — 처음과, 바깥이 갈린 뒤(설계 4절 규칙 2 · 경우 1 — 바깥 끊김은 세션 끝이 아니다:
   * 같은 채널·같은 uuid 로 다시 watch). 다시 붙을 때는 마지막으로 읽은 uuid 를 싣는다 — 그 사이 같은 이름으로 다시 만든 세션이면
   * 데몬이 SESSION_REPLACED 로 거절해 멈춘다. 못 붙으면 멈추고 다리에 알린다(true = 붙었다).
   */
  private async connect(): Promise<boolean> {
    const name = this.deps.session;
    let client: TermClient | undefined;
    try {
      client = await openTermClient(this.deps.paths, { start: false });
    } catch (error) {
      this.daemonFailed("watch", error);
      return false;
    }
    if (!client || this.stopped) {
      client?.close();
      if (!client) {
        this.stop();
        this.deps.onGone("the term daemon is not running");
      }
      return false;
    }
    const opened = client;
    this.client = opened;
    opened.onEvent((event) => {
      if (event.event === "changed") {
        this.refresh();
      } else if (event.event === "exit") {
        this.stop();
        this.deps.onGone(`session ${name} exited`);
      }
    });
    opened.onClose(() => {
      if (this.client === opened && !this.stopped) void this.reconnect();
    });
    try {
      await opened.request({ op: "watch", name, ...(this.instance ? { instance: this.instance } : {}) });
    } catch (error) {
      this.daemonFailed("watch", error);
      return false;
    }
    return true;
  }

  /** 데몬 연결이 끊겼다(바깥이 갈림 등) — 한 번 다시 붙는다. 읽기 실패와 연결 끊김이 겹쳐도 하나로. */
  private reconnect(): Promise<boolean> {
    this.reconnecting ??= (async () => {
      this.client = undefined;
      this.deps.log.write({ event: "remote_viewer_reconnect", channelId: this.deps.channelId, session: this.deps.session });
      const connected = await this.connect();
      if (connected) this.refresh();
      return connected;
    })().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  private async loop(): Promise<void> {
    const name = this.deps.session;
    let sentKey: string | undefined;
    let sentGeneration = 0;
    let parkedGeneration = 0;
    let lastRead = 0;
    let dropped = 0;
    let attempt = 0;
    while (!this.stopped) {
      const target = this.deps.link();
      if (!this.dirty || parkedGeneration === target.generation) {
        await new Promise<void>((resolve) => {
          this.wakeUp = resolve;
        });
        continue;
      }
      if (sentGeneration !== target.generation) {
        sentGeneration = target.generation;
        sentKey = undefined;
      }
      const gap = lastRead + FRAME_MIN_INTERVAL_MS - Date.now();
      if (gap > 0) {
        await sleep(gap, this.stopper.signal);
        continue;
      }
      this.dirty = false;
      lastRead = Date.now();
      const { cols, rows } = this.size;
      const executedThrough = this.deps.executedThrough();
      if (executedThrough === undefined) {
        this.stop();
        this.deps.onChannelEnded("CHANNEL_GONE");
        return;
      }
      let data: unknown;
      try {
        if (!this.client) throw new TermError("TERM_DAEMON_GONE", "The term daemon connection is being opened again.");
        data = await this.client.request({ op: "read", name, scrollback: true, lines: FRAME_SCROLLBACK_LINES + rows, styles: true });
      } catch (error) {
        // ★바깥이 갈려 끊겼다 — 세션 끝이 아니다. 읽기는 다시 해도 같은 결과라(상태를 바꾸지 않는다) 다시 붙어 다시 읽는다.
        if (error instanceof TermError && error.code === "TERM_DAEMON_GONE" && !this.stopped) {
          if (await this.reconnect()) continue;
          return;
        }
        this.daemonFailed("read", error);
        return;
      }
      const instance = sessionInstance(data);
      if (instance === undefined) {
        // 옛 데몬 — 인스턴스를 모르면 웹이 명령을 겨눌 수 없고(§14-6 4) 데몬도 검사하지 않는다. 화면을 보내지 않는다.
        this.daemonFailed("read", new TermError("TERM_DAEMON_OUTDATED",
          "The term daemon is older than this CLI (no session instance) — restart it with `ainecto term kill-server`."));
        return;
      }
      this.instance = instance;
      const modes = readModes(data);
      const lines = readLines(data);
      const attributes = readStyles(data, lines.length);
      const outer = { linkId: target.linkId, channelId: this.deps.channelId, session: name, cols, rows };
      const sealed = { ...(modes ? { modes } : {}), ...(attributes ? { styles: attributes.styles } : {}), instance };
      const frame = screenFrame(lines, frameBudget(target.frameMaxBytes, outer, sealed), attributes);
      if (frame.dropped !== dropped) {
        dropped = frame.dropped;
        this.deps.log.write({ event: "remote_frame_trimmed", channelId: this.deps.channelId, session: name, dropped });
      }
      const key = `${frame.hash}:${cols}x${rows}:${JSON.stringify(modes ?? null)}:${instance}:${executedThrough}`;
      if (key === sentKey) continue;
      let box: { n: number; c: string };
      try {
        box = await this.deps.seal({
          d: frame.d, ...sealed, ...(frame.runs ? { runs: frame.runs } : {}), ...(frame.cursor ? { cursor: frame.cursor } : {}), executedThrough,
        });
      } catch (error) {
        this.stop();
        this.deps.onChannelEnded(error instanceof ChannelSealError ? error.reason : "CHANNEL_GONE");
        return;
      }
      // 봉인하는 사이 멈췄다(기기 지우기·채널 닫기) — 이미 봉인한 화면도 보내지 않는다.
      if (this.stopped) return;
      try {
        await this.deps.http.call("frame", { ...outer, ...box }, { signal: this.stopper.signal });
        sentKey = key;
        attempt = 0;
      } catch (error) {
        if (this.stopped) return;
        if (error instanceof PcCallError && error.status === 404 && error.code === "REMOTE_NOT_FOUND") {
          parkedGeneration = target.generation;
          this.dirty = true;
          continue;
        }
        if (error instanceof PcCallError && error.status === 404 && error.code === "SESSION_NOT_FOUND") {
          this.deps.onUnknownSession();
        } else if (error instanceof PcCallError && (error.status === 401 || error.status === 403)) {
          this.stop();
          this.deps.onRefused(error);
          return;
        } else if (!(error instanceof PcCallError) || !error.retryable) {
          // 그 밖 4xx(채널을 서버가 이미 닫음 등) — 이 화면만 멈춘다. 다리는 계속(응답 줄은 공용 입구가 남겼다).
          this.stop();
          return;
        }
        await sleep(retryWait(attempt, Math.random()), this.stopper.signal);
        attempt += 1;
        this.dirty = true;   // 기다린 사이 바뀐 것까지 — 다시 읽어 최신 한 장을 보낸다.
      }
    }
  }

  /**
   * 데몬 요청 실패 — 한 줄 남기고 멈춘다(세션이 없어졌으면 다리가 목록을 다시 올린다).
   * 세션이 이미 끝났으면(웹에서 끝낸 직후 읽기가 끝남과 겹침) 오류가 아니라 «끝남» 한 줄.
   */
  private daemonFailed(op: string, error: unknown): void {
    const code = error instanceof TermError ? error.code : "UNKNOWN";
    const session = this.deps.session;
    this.stop();
    if (code === "TERM_NO_SESSION") {
      this.deps.log.write({ event: "remote_session_ended", op, session, code });
      this.deps.onGone(`session ${session} ended`);
      return;
    }
    this.deps.log.write({ event: "remote_daemon_error", op, session, code, message: error instanceof Error ? error.message : String(error) });
    this.deps.onGone(`${op} failed (${code})`);
  }

  private nudge(): void {
    const wake = this.wakeUp;
    this.wakeUp = undefined;
    wake?.();
  }
}
