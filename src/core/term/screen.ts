import type { IBuffer, IBufferCell, IModes, Terminal } from "@xterm/headless";

/**
 * 헤드리스 화면에서 글자를 꺼내는 순수 함수들 — `read`·`wait` 가 같은 함수를 쓴다(설계 2-3).
 */
export interface ReadRange {
  /** true 면 스크롤백까지, 아니면 보이는 화면만. */
  scrollback: boolean;
  /** 끝에서부터 N 줄(뒤쪽 빈 줄을 걷은 뒤). 없으면 범위 전체. */
  lines?: number;
}

/**
 * 화면 줄 그대로(줄바꿈된 긴 줄을 잇지 않는다 — 보이는 것과 같게). 줄 끝 공백과 범위 끝의 빈 줄은 걷는다.
 * ★넓은 글자(한글)는 translateToString 이 두 칸을 한 글자로 돌려준다.
 */
export function screenLines(buffer: IBuffer, rows: number, range: ReadRange): string[] {
  return styledScreen(buffer, rows, range, false).lines;
}

/**
 * 글자 속성 한 벌 — 원격 웹이 화면을 칠한다(Ryan 11-25 «추천 텍스트 색상은 좀 연하게» → 흐림·색을 그대로 싣는다).
 * 색: 숫자 = 팔레트 번호(0~15 는 웹 테마의 ANSI 16색, 16~255 는 xterm 256색 표) · 문자열 = `#rrggbb`(앱이 쓴 24비트 색). 없으면 기본색.
 * 켜진 속성만 싣는다 — 기본 글자는 빈 객체이고 구간에 넣지 않는다.
 */
export interface CellStyle {
  fg?: number | string;
  bg?: number | string;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
  inverse?: true;
  invisible?: true;
  strike?: true;
}

/** 커서 자리 — row = 돌려준 줄 목록의 번호(줄 목록보다 아래일 수 있다 — 뒤쪽 빈 줄을 걷었다), col = 그 줄 글(UTF-16)의 위치(줄 끝 뒤는 한 칸 = 한 글자). */
export interface ScreenCursor {
  row: number;
  col: number;
}

/**
 * 글자 + 속성 — {@link screenLines} 와 같은 줄(글자는 그 함수 그대로)에 줄마다 속성 구간을 붙인다.
 * runs[i] = 줄 i 의 `[시작, 끝, styles 번호]` 를 이어 붙인 평평한 배열(글 위치는 UTF-16 — 웹이 그 줄 글을 그대로 자른다). 기본 글자 구간은 없다.
 * ★줄 끝 공백은 글자처럼 걷힌다(배경색만 있는 줄 끝 빈칸은 실리지 않는다 — 글자와 줄이 어긋나지 않게 한 규칙).
 */
export interface StyledScreen {
  lines: string[];
  styles: CellStyle[];
  runs: number[][];
  cursor?: ScreenCursor;
}

export function styledScreen(buffer: IBuffer, rows: number, range: ReadRange, cursorVisible: boolean): StyledScreen {
  const end = buffer.baseY + rows;
  const start = range.scrollback ? 0 : buffer.baseY;
  const lines: string[] = [];
  const runs: number[][] = [];
  const styles: CellStyle[] = [];
  const styleIndex = new Map<string, number>();
  const cell = buffer.getNullCell();
  for (let index = start; index < end; index += 1) {
    const line = buffer.getLine(index);
    const text = line?.translateToString(true) ?? "";
    lines.push(text);
    const row: number[] = [];
    let offset = 0;
    for (let column = 0; line && column < line.length && offset < text.length; column += 1) {
      line.getCell(column, cell);
      if (cell.getWidth() === 0) continue;
      const length = (cell.getChars() || " ").length;
      const style = cellStyle(cell);
      if (style) {
        const key = JSON.stringify(style);
        let at = styleIndex.get(key);
        if (at === undefined) {
          at = styles.length;
          styles.push(style);
          styleIndex.set(key, at);
        }
        const stop = Math.min(offset + length, text.length);
        if (row.length > 0 && row[row.length - 1] === at && row[row.length - 2] === offset) {
          row[row.length - 2] = stop;
        } else {
          row.push(offset, stop, at);
        }
      }
      offset += length;
    }
    runs.push(row);
  }
  let kept = lines.length;
  while (kept > 0 && lines[kept - 1] === "") kept -= 1;
  const from = range.lines === undefined ? 0 : Math.max(0, kept - range.lines);
  const cursorRow = buffer.baseY + buffer.cursorY - start - from;
  return {
    lines: lines.slice(from, kept),
    styles,
    runs: runs.slice(from, kept),
    ...(cursorVisible && cursorRow >= 0 ? { cursor: { row: cursorRow, col: cursorColumn(buffer, cell) } } : {}),
  };
}

/** 커서 칸 → 그 줄 글의 위치(넓은 글자의 둘째 칸은 0 글자, 빈칸은 한 글자). */
function cursorColumn(buffer: IBuffer, cell: IBufferCell): number {
  const line = buffer.getLine(buffer.baseY + buffer.cursorY);
  let offset = 0;
  for (let column = 0; line && column < buffer.cursorX && column < line.length; column += 1) {
    line.getCell(column, cell);
    if (cell.getWidth() !== 0) offset += (cell.getChars() || " ").length;
  }
  return offset + Math.max(0, buffer.cursorX - (line?.length ?? 0));
}

function cellStyle(cell: IBufferCell): CellStyle | undefined {
  if (cell.isAttributeDefault()) return undefined;
  const style: CellStyle = {};
  const fg = cellColor(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor());
  const bg = cellColor(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor());
  if (fg !== undefined) style.fg = fg;
  if (bg !== undefined) style.bg = bg;
  if (cell.isBold()) style.bold = true;
  if (cell.isDim()) style.dim = true;
  if (cell.isItalic()) style.italic = true;
  if (cell.isUnderline()) style.underline = true;
  if (cell.isInverse()) style.inverse = true;
  if (cell.isInvisible()) style.invisible = true;
  if (cell.isStrikethrough()) style.strike = true;
  return Object.keys(style).length > 0 ? style : undefined;
}

function cellColor(isDefault: boolean, isRgb: boolean, value: number): number | string | undefined {
  if (isDefault) return undefined;
  return isRgb ? `#${value.toString(16).padStart(6, "0")}` : value;
}

/**
 * xterm 공개 API 가 알려 주지 않는 화면 모드 두 개 — 커서 보이기(DECTCEM `CSI ? 25 h/l`)와 마우스 SGR 인코딩(`CSI ? 1006 h/l`).
 * 파서에 «보기만 하는» 처리기를 건다(false 를 돌려 xterm 이 원래대로 처리한다). 전체 초기화(RIS `ESC c`)·소프트 초기화(DECSTR `CSI ! p`)는 처음 값으로.
 */
export interface ScreenFlags {
  readonly cursorVisible: boolean;
  readonly sgrMouse: boolean;
}

export function trackScreenFlags(terminal: Pick<Terminal, "parser">): ScreenFlags {
  const flags = { cursorVisible: true, sgrMouse: false };
  const privateMode = (on: boolean) => (params: (number | number[])[]) => {
    for (const param of params) {
      if (param === 25) flags.cursorVisible = on;
      if (param === 1006) flags.sgrMouse = on;
    }
    return false;
  };
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, privateMode(true));
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, privateMode(false));
  const reset = () => {
    flags.cursorVisible = true;
    flags.sgrMouse = false;
    return false;
  };
  terminal.parser.registerEscHandler({ final: "c" }, reset);
  terminal.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => {
    flags.cursorVisible = true;
    return false;
  });
  return flags;
}

/**
 * 붙었던 터미널을 떼거나 세션이 끝날 때 사용자 터미널에 남은 모드를 되돌리는 글자 —
 * 세션 앱이 켜 둔 모드(마우스·bracketed paste·커서키 앱 모드·alternate 화면)만 끈다.
 * ★우리는 화면을 다시 그리지 않고 바이트를 그대로 흘리므로, 이걸 안 보내면 셸로 돌아온 뒤 마우스 글자가 찍힌다.
 */
export function terminalResetSequence(
  modes: Pick<IModes, "mouseTrackingMode" | "sendFocusMode" | "bracketedPasteMode" | "applicationCursorKeysMode" | "applicationKeypadMode">,
  alternateScreen: boolean,
): string {
  let reset = "\x1b[0m";
  if (modes.mouseTrackingMode !== "none") {
    reset += "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
  }
  if (modes.sendFocusMode) {
    reset += "\x1b[?1004l";
  }
  if (modes.bracketedPasteMode) {
    reset += "\x1b[?2004l";
  }
  if (modes.applicationCursorKeysMode) {
    reset += "\x1b[?1l";
  }
  if (modes.applicationKeypadMode) {
    reset += "\x1b>";
  }
  if (alternateScreen) {
    reset += "\x1b[?1049l";
  }
  return `${reset}\x1b[?25h`;
}

/**
 * 세션 앱이 켠 모드를 모를 때(attach 중 데몬 연결이 끊김·detach 응답 없음) 사용자 터미널을 되돌리는 글자 —
 * 앱이 켤 수 있는 모드를 모두 켜졌다고 보고 같은 함수로 만든다(규칙을 두 벌 두지 않는다, 리뷰 #81 T5).
 */
export const FULL_TERMINAL_RESET = terminalResetSequence(
  { mouseTrackingMode: "any", sendFocusMode: true, bracketedPasteMode: true, applicationCursorKeysMode: true, applicationKeypadMode: true },
  true,
);
