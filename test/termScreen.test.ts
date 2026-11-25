import headless from "@xterm/headless";
import { keyBytes, pasteBytes } from "../src/core/term/keys";
import { screenLines, terminalResetSequence } from "../src/core/term/screen";

describe("term key table", () => {
  const normal = { applicationCursorKeys: false };
  const app = { applicationCursorKeys: true };

  it("maps design names, web-cmux spellings and aliases to the same bytes", () => {
    expect(keyBytes("enter", normal)).toBe("\r");
    expect(keyBytes("Return", normal)).toBe("\r");
    expect(keyBytes("esc", normal)).toBe("\x1b");
    expect(keyBytes("ctrl-c", normal)).toBe("\x03");
    expect(keyBytes("ctrl+c", normal)).toBe("\x03");
    expect(keyBytes("shift-tab", normal)).toBe("\x1b[Z");
    expect(keyBytes("ctrl-z", normal)).toBe("\x1a");
  });

  it("sends cursor keys as ESC O x when the app turned on DECCKM", () => {
    expect(keyBytes("up", normal)).toBe("\x1b[A");
    expect(keyBytes("up", app)).toBe("\x1bOA");
    expect(keyBytes("home", app)).toBe("\x1bOH");
    expect(keyBytes("pageup", app)).toBe("\x1b[5~");
  });

  it("does not guess unknown names", () => {
    expect(keyBytes("ctrl-1", normal)).toBeUndefined();
    expect(keyBytes("cmd-c", normal)).toBeUndefined();
    // 표준 바이트가 없는 조합(앱마다 다름)·같은 수식 두 번·수식만 — 짐작하지 않는다.
    for (const name of ["shift-enter", "ctrl-enter", "ctrl-tab", "ctrl-backspace", "shift-backspace", "shift-space", "shift-escape",
      "ctrl-escape", "alt-shift-tab", "shift-slash", "ctrl-ctrl-c", "ctrl", "alt-", "cmd-up"]) {
      expect(keyBytes(name, normal), name).toBeUndefined();
    }
  });

  it("modifier combos — xterm bytes: Alt = ESC prefix · modifier parameter for arrows/Home/End/PageUp/PageDown/Delete · Ctrl+Space/Ctrl+/", () => {
    // Alt + 한 바이트 키 = ESC + 그 바이트 (Alt 이 붙은 Ctrl·Shift 글자도).
    expect(keyBytes("alt-b", normal)).toBe("\x1bb");
    expect(keyBytes("alt-shift-b", normal)).toBe("\x1bB");
    expect(keyBytes("ctrl-alt-c", normal)).toBe("\x1b\x03");
    expect(keyBytes("alt+enter", normal)).toBe("\x1b\r");
    expect(keyBytes("alt-backspace", normal)).toBe("\x1b\x7f");
    expect(keyBytes("alt-tab", normal)).toBe("\x1b\t");
    expect(keyBytes("alt-escape", normal)).toBe("\x1b\x1b");
    expect(keyBytes("alt-space", normal)).toBe("\x1b ");
    expect(keyBytes("alt-slash", normal)).toBe("\x1b/");
    // Ctrl+Space = NUL · Ctrl+/ = 0x1F · Ctrl+Shift+글자 = Ctrl+글자 · Shift+글자 = 대문자.
    expect(keyBytes("ctrl-space", normal)).toBe("\x00");
    expect(keyBytes("ctrl-slash", normal)).toBe("\x1f");
    expect(keyBytes("ctrl+/", normal)).toBe("\x1f");
    expect(keyBytes("ctrl-shift-c", normal)).toBe("\x03");
    expect(keyBytes("shift-a", normal)).toBe("A");
    expect(keyBytes("ctrl-alt-space", normal)).toBe("\x1b\x00");
    // 수식 + 커서키 = CSI 1;m X (m = 1 + Shift 1 + Alt 2 + Ctrl 4) — 커서키 앱 모드여도 같다. 수식 순서는 상관없다.
    for (const context of [normal, app]) {
      expect(keyBytes("shift-up", context)).toBe("\x1b[1;2A");
      expect(keyBytes("alt-down", context)).toBe("\x1b[1;3B");
      expect(keyBytes("shift-alt-right", context)).toBe("\x1b[1;4C");
      expect(keyBytes("ctrl-left", context)).toBe("\x1b[1;5D");
      expect(keyBytes("ctrl-shift-home", context)).toBe("\x1b[1;6H");
      expect(keyBytes("alt-ctrl-end", context)).toBe("\x1b[1;7F");
      expect(keyBytes("ctrl-shift-alt-up", context)).toBe("\x1b[1;8A");
      // PageUp·PageDown·Delete = CSI n;m ~
      expect(keyBytes("shift-pageup", context)).toBe("\x1b[5;2~");
      expect(keyBytes("ctrl-pagedown", context)).toBe("\x1b[6;5~");
      expect(keyBytes("alt-delete", context)).toBe("\x1b[3;3~");
      expect(keyBytes("ctrl-shift-delete", context)).toBe("\x1b[3;6~");
    }
  });

  it("Ryan 11-25 — wheel-up/down: 마우스 추적이면 화면 가운데 칸 휠 보고(SGR · 옛 X10) · 추적 없는 전체 화면은 위/아래 키 · 보통 화면은 보낼 것 없음 · 화면 상태를 모르면 모르는 이름", () => {
    const wheel = { mouseTracking: "drag" as const, sgrMouse: true, altScreen: true, cols: 100, rows: 31 };
    expect(keyBytes("wheel-up", { ...normal, wheel })).toBe("\x1b[<64;50;16M");
    expect(keyBytes("wheel-down", { ...normal, wheel })).toBe("\x1b[<65;50;16M");
    expect(keyBytes("wheel-up", { ...normal, wheel: { ...wheel, sgrMouse: false } })).toBe(`\x1b[M${String.fromCharCode(96, 82, 48)}`);
    expect(keyBytes("wheel-down", { ...app, wheel: { ...wheel, mouseTracking: "none" } })).toBe("\x1bOB");
    expect(keyBytes("wheel-up", { ...normal, wheel: { ...wheel, mouseTracking: "none" } })).toBe("\x1b[A");
    expect(keyBytes("wheel-up", { ...normal, wheel: { ...wheel, mouseTracking: "none", altScreen: false } })).toBe("");
    expect(keyBytes("wheel-up", normal)).toBeUndefined();
  });

  it("wraps a paste only when the app asked for bracketed paste", () => {
    expect(pasteBytes("a\nb", true)).toBe("\x1b[200~a\nb\x1b[201~");
    expect(pasteBytes("a\nb", false)).toBe("a\nb");
  });
});

describe("term screen text", () => {
  it("reads wide characters, trims the trailing blank lines and keeps the last N", async () => {
    const terminal = new headless.Terminal({ cols: 20, rows: 5, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write("one\r\n한글 두칸\r\nthree\r\n", resolve));
    expect(screenLines(terminal.buffer.active, terminal.rows, { scrollback: false })).toEqual(["one", "한글 두칸", "three"]);
    expect(screenLines(terminal.buffer.active, terminal.rows, { scrollback: false, lines: 2 })).toEqual(["한글 두칸", "three"]);
  });

  it("separates the visible screen from the scrollback", async () => {
    const terminal = new headless.Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    await new Promise<void>((resolve) => terminal.write("a\r\nb\r\nc\r\nd", resolve));
    expect(screenLines(terminal.buffer.active, terminal.rows, { scrollback: false })).toEqual(["c", "d"]);
    expect(screenLines(terminal.buffer.active, terminal.rows, { scrollback: true })).toEqual(["a", "b", "c", "d"]);
  });

  it("turns off only the modes the app left on", () => {
    const off = { mouseTrackingMode: "none", sendFocusMode: false, bracketedPasteMode: false, applicationCursorKeysMode: false, applicationKeypadMode: false } as const;
    expect(terminalResetSequence(off, false)).toBe("\x1b[0m\x1b[?25h");
    expect(terminalResetSequence({ ...off, mouseTrackingMode: "any", bracketedPasteMode: true }, true))
      .toBe("\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l\x1b[?25h");
  });
});
