import type { Terminal } from "@xterm/headless";
import { CLI_VERSION_LABEL } from "../version";
import { keyBytes, pasteBytes } from "./keys";
import { screenLines, styledScreen, terminalResetSequence, type ReadRange, type ScreenFlags, type StyledScreen } from "./screen";
import { XTERM_VERSION } from "./xtermVersion";

/**
 * 계산 모듈(세션 유지 구조 설계 3-2) — 화면 읽기·키 바이트처럼 ★부수효과 없는 함수 묶음 하나. holder 가 이 묶음만 새 판 것으로 갈아 끼운다
 * (열린 세션에도 새 판의 화면·키 계산이 들어온다). 출력 순서에 묶인 코드(질의 경계·attach 경계·크기 주인)와 파서 훅(screen.trackScreenFlags)은
 * holder 몫이라 여기 없다 — 이 모듈은 holder 가 넘기는 화면({@link ComputeView})을 읽기만 한다.
 *
 * ★CLI 배포물 옆에 따로 번들한다(tsup 진입 `term/compute` → dist/term/compute.js). holder 는 바깥이 알린 그 파일을 복사해 불러오고,
 *   적힌 xterm 판 · 요구하는 화면 칸({@link ComputeModule.needs}) · 자기 시험({@link ComputeModule.checks})을 스스로 확인한 뒤에만 쓴다(computeSlot.ts).
 * 이 파일의 내보내기 `compute` 의 모양은 holder 말과 같이 «추가만» — 칸을 지우거나 뜻을 바꾸면 옛 holder 가 새 모듈을 못 쓴다.
 */

/** holder 가 계산 함수에 넘기는 그 세션의 화면 — xterm Terminal(밀린 출력을 다 그린 뒤) + holder 의 파서 훅 값. */
export interface ComputeView {
  terminal: Terminal;
  flags: ScreenFlags;
}

/** 화면의 터미널 모드 — 원격 웹이 «직접 키»로 바꿀지 본다. */
export interface ScreenModes {
  altScreen: boolean;
  appCursor: boolean;
  bracketedPaste: boolean;
  /** 앱이 마우스 추적을 켰는가 — 원격 웹이 휠을 앱에 보낼지(`wheel-up`·`wheel-down`) 본다. 옛 데몬은 이 칸이 없다(웹은 휠을 보내지 않는다). */
  mouse: boolean;
}

/** 자기 시험 한 장 — 이 크기의 빈 화면에 `output` 을 쓴 뒤 각 함수의 답이 기댓값과 같아야 한다. 기댓값이 없는 함수는 보지 않는다. */
export interface ComputeCheck {
  name: string;
  cols: number;
  rows: number;
  output: string;
  read?: { range: ReadRange; lines: string[] };
  styled?: { range: ReadRange; screen: StyledScreen };
  modes?: ScreenModes;
  /** 키 이름 → 바이트(null = 모르는 이름). */
  keys?: Record<string, string | null>;
  paste?: { text: string; bytes: string };
  reset?: string;
}

export interface ComputeModule {
  /** 이 모듈을 낸 CLI 판(로컬 빌드면 `-dev+<빌드>`). */
  version: string;
  /** 맞춰 만든 @xterm/headless 판 — holder 의 것과 같아야 받는다. */
  xterm: string;
  /** 쓰는 {@link ComputeView} 칸 — holder 가 다 넘길 수 있어야 받는다(holder 몫 COMPUTE_VIEW). */
  needs: readonly string[];
  read(view: ComputeView, range: ReadRange): string[];
  readStyled(view: ComputeView, range: ReadRange): StyledScreen;
  modes(view: ComputeView): ScreenModes;
  /** 모르는 이름이면 undefined. */
  key(view: ComputeView, name: string): string | undefined;
  paste(view: ComputeView, text: string): string;
  /** 붙었던 터미널을 떼거나 세션이 끝날 때 사용자 터미널을 되돌리는 글자. */
  reset(view: ComputeView): string;
  checks: readonly ComputeCheck[];
}

const alternate = (view: ComputeView): boolean => view.terminal.buffer.active.type === "alternate";

/** 마우스 추적(1000) 위에 1016(SGR 픽셀) — xterm 내부 인코딩은 픽셀이지만 0.16.3 은 1006 을 보지 않았으므로 X10 휠 바이트(설계 3-3 실측). */
const X10_WHEEL_UP_80x24 = `\x1b[M${String.fromCharCode(96, 72, 44)}`;

export const compute: ComputeModule = {
  version: CLI_VERSION_LABEL,
  xterm: XTERM_VERSION,
  needs: ["terminal", "flags.cursorVisible", "flags.sgrMouse"],
  read: (view, range) => screenLines(view.terminal.buffer.active, view.terminal.rows, range),
  readStyled: (view, range) => styledScreen(view.terminal.buffer.active, view.terminal.rows, range, view.flags.cursorVisible),
  modes: (view) => ({
    altScreen: alternate(view),
    appCursor: view.terminal.modes.applicationCursorKeysMode,
    bracketedPaste: view.terminal.modes.bracketedPasteMode,
    mouse: view.terminal.modes.mouseTrackingMode !== "none",
  }),
  key: (view, name) => keyBytes(name, {
    applicationCursorKeys: view.terminal.modes.applicationCursorKeysMode,
    wheel: {
      mouseTracking: view.terminal.modes.mouseTrackingMode,
      sgrMouse: view.flags.sgrMouse,
      altScreen: alternate(view),
      cols: view.terminal.cols,
      rows: view.terminal.rows,
    },
  }),
  paste: (view, text) => pasteBytes(text, view.terminal.modes.bracketedPasteMode),
  reset: (view) => terminalResetSequence(view.terminal.modes, alternate(view)),
  checks: [
    {
      name: "plain shell screen",
      cols: 80,
      rows: 24,
      output: "hello\r\n\x1b[31mred\x1b[0m \x1b[2mdim\x1b[0m",
      read: { range: { scrollback: false }, lines: ["hello", "red dim"] },
      styled: {
        range: { scrollback: false },
        screen: { lines: ["hello", "red dim"], styles: [{ fg: 1 }, { dim: true }], runs: [[], [0, 3, 0, 4, 7, 1]], cursor: { row: 1, col: 7 } },
      },
      modes: { altScreen: false, appCursor: false, bracketedPaste: false, mouse: false },
      keys: { enter: "\r", "ctrl-c": "\x03", up: "\x1b[A", "wheel-up": "", "no-such-key": null },
      paste: { text: "a\nb", bytes: "a\nb" },
      reset: "\x1b[0m\x1b[?25h",
    },
    {
      name: "full-screen app (cursor keys · bracketed paste · alternate)",
      cols: 80,
      rows: 24,
      output: "\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?25l",
      styled: { range: { scrollback: false }, screen: { lines: [], styles: [], runs: [] } },
      modes: { altScreen: true, appCursor: true, bracketedPaste: true, mouse: false },
      keys: { up: "\x1bOA", "wheel-down": "\x1bOB" },
      paste: { text: "x", bytes: "\x1b[200~x\x1b[201~" },
      reset: "\x1b[0m\x1b[?2004l\x1b[?1l\x1b[?1049l\x1b[?25h",
    },
    {
      name: "mouse 1000 → 1016 (X10 wheel, as 0.16.3)",
      cols: 80,
      rows: 24,
      output: "\x1b[?1000h\x1b[?1016h",
      modes: { altScreen: false, appCursor: false, bracketedPaste: false, mouse: true },
      keys: { "wheel-up": X10_WHEEL_UP_80x24 },
    },
    {
      name: "mouse 1000 → 1006 → 1016 (SGR cell wheel, as 0.16.3)",
      cols: 80,
      rows: 24,
      output: "\x1b[?1000h\x1b[?1006h\x1b[?1016h",
      keys: { "wheel-up": "\x1b[<64;40;12M", "wheel-down": "\x1b[<65;40;12M" },
    },
  ],
};
