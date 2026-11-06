import type { IBuffer, IModes } from "@xterm/headless";

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
  const end = buffer.baseY + rows;
  const start = range.scrollback ? 0 : buffer.baseY;
  const lines: string[] = [];
  for (let index = start; index < end; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return range.lines === undefined ? lines : lines.slice(Math.max(0, lines.length - range.lines));
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
