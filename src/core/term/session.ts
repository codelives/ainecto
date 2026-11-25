import { randomUUID } from "node:crypto";
// ★두 패키지는 webpack 으로 묶은 CJS 라 Node ESM 이 이름 있는 내보내기를 못 찾는다 — 기본 내보내기(module.exports)로 받는다.
import serializeAddon from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/headless";
import type { IPty } from "node-pty";
import { defaultShellCommand, planLaunch } from "../os/launch";
import { TermError } from "./errors";
import { keyBytes, pasteBytes } from "./keys";
import type { TermEvent } from "./protocol";
import { QueryFilter } from "./queryFilter";
import { screenLines, styledScreen, terminalResetSequence, trackScreenFlags, type ReadRange, type ScreenFlags, type StyledScreen } from "./screen";

/**
 * 세션 안 환경변수 — 에이전트가 «내가 누구인가»를 안다(설계 1-1 `identify` 행). 이름은 세션 수명 동안 바뀌지 않으므로
 * 자식이 받은 값이 끝까지 참이다(설계 v2 F4).
 */
export const SESSION_ENV = "AINECTO_TERM_SESSION";

export interface SessionSpec {
  name: string;
  cwd: string;
  /** 없으면 사용자 로그인 셸. */
  command: string[] | null;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  createdAt: string;
  /** 보이는 이름 — 데몬 이름은 그대로. */
  label?: string;
  /** 프로젝트 꼬리표(KAN-1238) — 세션 수명 동안 바뀌지 않는다. 매니페스트와 info() 가 이 값 하나를 내보낸다. */
  project?: string;
  /** 입력을 받지 않는 명령이면 "none"(launch.ts LaunchInput — 이 PC 연결 세션). 없으면 받는다. 옛 데몬·옛 파일은 이 칸 없이 그대로. */
  input?: "none";
}

/** 세션의 출력·이벤트를 받는 쪽(연결 하나). */
export interface SessionSink {
  send(event: TermEvent): void;
}

export interface SessionInfo {
  name: string;
  pid: number;
  cwd: string;
  command: string[] | null;
  createdAt: string;
  cols: number;
  rows: number;
  clients: number;
  /** 세션 인스턴스 id — 같은 이름으로 다시 만든 세션을 가른다(설계 terminal-e2e §13-1·§14-6 4). */
  instance: string;
  label?: string;
  project?: string;
  lastOutputAt?: string;
}

/** 화면의 터미널 모드 — 원격 웹이 «직접 키»로 바꿀지 본다. */
export interface ScreenModes {
  altScreen: boolean;
  appCursor: boolean;
  bracketedPaste: boolean;
  /** 앱이 마우스 추적을 켰는가 — 원격 웹이 휠을 앱에 보낼지(`wheel-up`·`wheel-down`) 본다. 옛 데몬은 이 칸이 없다(웹은 휠을 보내지 않는다). */
  mouse: boolean;
}

interface AttachState {
  /** 첫 화면을 보내기 전까지 모아 두는 출력. null 이면 바로 흘린다. */
  pending: string[] | null;
  cols: number;
  rows: number;
  /** 이 클라이언트에게 가는 출력에서 질의를 뺄지 — 주인이 아니면 뺀다(queryFilter.ts). */
  filter: QueryFilter;
}

/**
 * 세션 하나 = node-pty 프로세스 하나 + 헤드리스 화면 하나(설계 2-2·2-3).
 * 출력은 ① 헤드리스 화면 ② 붙은 클라이언트들로 나눠 흘린다.
 * ★앱의 터미널 질의(커서 위치 등)에 답하는 쪽은 하나다(리뷰 #81 T2): 출력을 흘리는 순간 주인(크기 주인)이 있으면
 *   그 터미널만 질의를 받아 답하고, 없으면 헤드리스 화면이 답해 PTY 로 돌려준다. 이 판정은 출력 덩어리마다 한 번 —
 *   헤드리스는 쓰기 순서대로 그리므로 덩어리마다 «헤드리스가 답하나»를 줄 세워 두고 그 덩어리를 그리는 동안 본다.
 * ★node-pty 는 스레드 안전하지 않다 — 데몬 메인 스레드에서만 다룬다.
 */
export class TermSession {
  private readonly attached = new Map<SessionSink, AttachState>();
  /** watch 중인 쪽 → 다음 «바뀜» 알림을 보낼 차례인가. */
  private readonly watchers = new Map<SessionSink, boolean>();
  /** 크기를 정하는 쪽 — 마지막으로 붙거나 입력한 클라이언트(tmux `window-size latest`). */
  private sizeOwner: SessionSink | undefined;
  /**
   * 출력 흐름의 시퀀스 경계 — 붙은 클라이언트가 없어도 모든 출력을 따라간다. 새 attach 의 필터는 여기서 갈라
   * 시작한다(직렬화 화면은 파서의 반쪽 시퀀스를 담지 않는다 — 리뷰 #82 Q1).
   */
  private readonly boundary = new QueryFilter();
  /** 헤드리스 화면에 넣은 쓰기마다 «이 덩어리의 질의에 헤드리스가 답하나» — 맨 앞이 지금 그리는 덩어리다. */
  private readonly headlessAnswers: boolean[] = [];
  private exited = false;
  /** 보이는 이름 — label op 가 바꾼다. */
  label: string | undefined;
  /** 마지막 출력 시각(ISO) — 원격 웹 목록의 «마지막 활동». */
  private lastOutputAt: string | undefined;
  /**
   * 인스턴스 id — 데몬이 세션을 만들 때마다 새 무작위 값(설계 terminal-e2e §13-1). 이름이 같아도 다시 만든 세션은 다른 값이라,
   * 원격 명령은 이 값이 맞을 때만 이 세션에 적용된다(daemon.ts 의 이름 찾기 한 곳). 화면(read)도 이 객체에서 같이 낸다.
   */
  readonly instance = randomUUID();

  private constructor(
    readonly spec: SessionSpec,
    private readonly pty: IPty,
    private readonly screen: Terminal,
    private readonly serializer: SerializeAddon,
    private readonly flags: ScreenFlags,
  ) {}

  static async start(spec: SessionSpec, onExit: (session: TermSession, exitCode: number, signal: number) => void): Promise<TermSession> {
    const ptyModule = await loadNodePty();
    // ★원래 명령(spec.command)은 그대로 둔다 — 매니페스트·ls·runningPcs 판정이 그것을 본다. PTY 에는 실행 계획의 표현만 넘긴다.
    const plan = planLaunch(spec.command ?? defaultShellCommand(spec.env), spec.env, undefined, undefined, spec.input ?? "terminal");
    const pty = ptyModule.spawn(plan.pty.file, plan.pty.commandLine, {
      cwd: spec.cwd,
      env: { ...spec.env, [SESSION_ENV]: spec.name },
      ...(spec.cols && spec.rows ? { cols: spec.cols, rows: spec.rows } : {}),
    });
    const screen = new headless.Terminal({ cols: pty.cols, rows: pty.rows, allowProposedApi: true });
    const serializer = new serializeAddon.SerializeAddon();
    screen.loadAddon(serializer);
    const flags = trackScreenFlags(screen);
    const session = new TermSession(spec, pty, screen, serializer, flags);
    session.label = spec.label;
    screen.onData((answer) => session.answerQuery(answer));
    pty.onData((data) => session.handleOutput(data));
    pty.onExit(({ exitCode, signal }) => {
      session.handleExit(exitCode, signal ?? 0);
      onExit(session, exitCode, signal ?? 0);
    });
    return session;
  }

  get name(): string {
    return this.spec.name;
  }

  info(): SessionInfo {
    return {
      name: this.spec.name,
      pid: this.pty.pid,
      cwd: this.spec.cwd,
      command: this.spec.command,
      createdAt: this.spec.createdAt,
      cols: this.pty.cols,
      rows: this.pty.rows,
      clients: this.attached.size,
      instance: this.instance,
      ...(this.label !== undefined ? { label: this.label } : {}),
      ...(this.spec.project !== undefined ? { project: this.spec.project } : {}),
      ...(this.lastOutputAt !== undefined ? { lastOutputAt: this.lastOutputAt } : {}),
    };
  }

  /** 지금까지 받은 출력을 모두 그린 뒤의 모드. */
  async modes(): Promise<ScreenModes> {
    await this.settled();
    return {
      altScreen: this.screen.buffer.active.type === "alternate",
      appCursor: this.screen.modes.applicationCursorKeysMode,
      bracketedPaste: this.screen.modes.bracketedPasteMode,
      mouse: this.screen.modes.mouseTrackingMode !== "none",
    };
  }

  async send(text: string, paste: boolean): Promise<void> {
    await this.settled();
    this.pty.write(paste ? pasteBytes(text, this.screen.modes.bracketedPasteMode) : text);
  }

  async key(name: string): Promise<void> {
    await this.settled();
    const bytes = keyBytes(name, {
      applicationCursorKeys: this.screen.modes.applicationCursorKeysMode,
      wheel: {
        mouseTracking: this.screen.modes.mouseTrackingMode,
        sgrMouse: this.flags.sgrMouse,
        altScreen: this.screen.buffer.active.type === "alternate",
        cols: this.screen.cols,
        rows: this.screen.rows,
      },
    });
    if (bytes === undefined) {
      throw new TermError("TERM_UNKNOWN_KEY", `Unknown key "${name}".`);
    }
    this.pty.write(bytes);
  }

  /** 지금까지 받은 출력을 모두 그린 뒤의 글자. watch 중인 쪽이 읽으면 다음 알림을 다시 켠다. */
  async read(range: ReadRange, reader?: SessionSink): Promise<string[]> {
    if (reader && this.watchers.has(reader)) {
      this.watchers.set(reader, true);
    }
    await this.settled();
    return screenLines(this.screen.buffer.active, this.screen.rows, range);
  }

  /** {@link read} 와 같은 줄에 글자 속성·커서까지(원격 웹 화면 — 색·흐림을 칠한다). */
  async readStyled(range: ReadRange, reader?: SessionSink): Promise<StyledScreen> {
    if (reader && this.watchers.has(reader)) {
      this.watchers.set(reader, true);
    }
    await this.settled();
    return styledScreen(this.screen.buffer.active, this.screen.rows, range, this.flags.cursorVisible);
  }

  /**
   * 붙는다 — ★첫 화면(직렬화)과 그 «뒤» 출력의 경계를 맞춘다: 붙는 순간부터 오는 출력은 모아 두고,
   * 그 앞까지 그린 화면을 직렬화해 보낸 다음 모은 출력을 흘린다(설계 2-3 «화면 세대 번호»와 같은 일).
   * 직렬화는 빈 쓰기의 콜백 안에서 한다 — xterm 은 쓰기 순서대로 그리고 각 쓰기 직후 콜백을 부른다.
   */
  attach(sink: SessionSink, cols: number, rows: number): void {
    const state: AttachState = { pending: [], cols, rows, filter: this.boundary.forkForNewReader() };
    this.attached.set(sink, state);
    this.takeSize(sink, state);
    this.writeScreen("", false, () => {
      sink.send({ event: "screen", d: Buffer.from(this.serializer.serialize(), "utf8").toString("base64") });
      for (const data of state.pending ?? []) {
        sink.send({ event: "out", d: Buffer.from(data, "utf8").toString("base64") });
      }
      state.pending = null;
    });
  }

  /** 뗀다 — 사용자 터미널에 남은 모드를 되돌릴 글자를 돌려준다. */
  detach(sink: SessionSink): string {
    this.attached.delete(sink);
    if (this.sizeOwner === sink) {
      this.sizeOwner = undefined;
    }
    return this.resetSequence();
  }

  input(sink: SessionSink, bytes: Buffer): void {
    const state = this.attached.get(sink);
    if (!state) {
      return;
    }
    if (this.sizeOwner !== sink) {
      this.takeSize(sink, state);
    }
    // ★바이트 그대로 — 덩어리마다 글자로 바꾸면 경계에 걸친 한글·이모지가 깨진다(리뷰 #81 T3).
    this.pty.write(bytes);
  }

  resizeFrom(sink: SessionSink, cols: number, rows: number): void {
    const state = this.attached.get(sink);
    if (!state) {
      return;
    }
    state.cols = cols;
    state.rows = rows;
    if (this.sizeOwner === sink) {
      this.resize(cols, rows);
    }
  }

  /**
   * 붙지 않은 쪽(원격 웹 패널)이 크기를 정한다 — 크기 주인을 비운다. 붙은 터미널이 있으면 그 터미널의 다음 입력이 크기를 되찾는다
   * («따르는 크기» 그대로). 크기를 바꾸는 곳은 {@link resize} 하나.
   */
  resizeTo(cols: number, rows: number): void {
    this.sizeOwner = undefined;
    this.resize(cols, rows);
  }

  watch(sink: SessionSink): void {
    this.watchers.set(sink, true);
  }

  /** 연결이 끊겼다 — 붙음·watch 를 모두 지운다. */
  forget(sink: SessionSink): void {
    this.attached.delete(sink);
    this.watchers.delete(sink);
    if (this.sizeOwner === sink) {
      this.sizeOwner = undefined;
    }
  }

  /** SIGHUP — tmux kill-session 과 같다. 끝나면 onExit 이 부른다. */
  kill(): void {
    if (!this.exited) {
      this.pty.kill();
    }
  }

  private takeSize(sink: SessionSink, state: AttachState): void {
    this.sizeOwner = sink;
    this.resize(state.cols, state.rows);
  }

  private resize(cols: number, rows: number): void {
    if (this.exited || (this.pty.cols === cols && this.pty.rows === rows)) {
      return;
    }
    this.pty.resize(cols, rows);
    this.screen.resize(cols, rows);
  }

  private handleOutput(data: string): void {
    this.lastOutputAt = new Date().toISOString();
    this.boundary.push(data, false);
    this.writeScreen(data, this.sizeOwner === undefined, () => this.notifyWatchers());
    for (const [sink, state] of this.attached) {
      const text = state.filter.push(data, sink !== this.sizeOwner);
      if (text.length === 0) {
        continue;
      }
      if (state.pending) {
        state.pending.push(text);
      } else {
        sink.send({ event: "out", d: Buffer.from(text, "utf8").toString("base64") });
      }
    }
  }

  /** 헤드리스 화면의 질의 응답 — 지금 그리는 덩어리를 흘릴 때 주인이 없었으면 PTY 로 돌려준다. */
  private answerQuery(answer: string): void {
    if (!this.exited && this.headlessAnswers[0] === true) {
      this.pty.write(answer);
    }
  }

  /** 헤드리스 화면에 쓰는 곳은 여기 하나 — 덩어리마다 «헤드리스가 답하나»를 같은 순서로 줄 세운다. */
  private writeScreen(data: string, headlessAnswers: boolean, done?: () => void): void {
    this.headlessAnswers.push(headlessAnswers);
    this.screen.write(data, () => {
      this.headlessAnswers.shift();
      done?.();
    });
  }

  private notifyWatchers(): void {
    for (const [sink, armed] of this.watchers) {
      if (armed) {
        this.watchers.set(sink, false);
        sink.send({ event: "changed" });
      }
    }
  }

  private handleExit(exitCode: number, signal: number): void {
    this.exited = true;
    const reset = Buffer.from(this.resetSequence(), "utf8").toString("base64");
    for (const sink of new Set([...this.attached.keys(), ...this.watchers.keys()])) {
      sink.send({ event: "exit", exitCode, signal, reset });
    }
    this.attached.clear();
    this.watchers.clear();
    this.screen.dispose();
  }

  private resetSequence(): string {
    return terminalResetSequence(this.screen.modes, this.screen.buffer.active.type === "alternate");
  }

  /** 지금까지 받은 출력을 헤드리스 화면이 다 그릴 때까지 기다린다. */
  private settled(): Promise<void> {
    if (this.exited) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.writeScreen("", false, resolve));
  }
}

/**
 * node-pty 는 선택 의존성(optionalDependencies)이다 — 설치에 실패해도 setup·MCP 는 그대로 돌고,
 * term 을 쓸 때만 여기서 사람 말로 끊는다(설계 2-8 가안).
 */
async function loadNodePty(): Promise<typeof import("node-pty")> {
  try {
    return await import("node-pty");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TermError(
      "TERM_PTY_UNAVAILABLE",
      `ainecto term needs the optional package node-pty, which did not load on this machine (${reason}). `
        + "Reinstall the CLI (npm install -g ainecto) on macOS, Linux (glibc) or Windows (x64·arm64).",
    );
  }
}

