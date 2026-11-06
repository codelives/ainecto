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
