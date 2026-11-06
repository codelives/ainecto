/**
 * `ainecto term key` 의 키 이름 → 바이트 — ★한 곳(설계 2-2, 순수 함수).
 * 이름은 설계서 표기(`ctrl-c`)가 정본이고, 사용자 web-cmux 표기(`ctrl+c`)와 별칭(esc·return)도 같은 키로 읽는다.
 * 방향키·Home·End 는 앱이 커서키 앱 모드(DECCKM, `CSI ? 1 h`)를 켰으면 `ESC O x` 로 보낸다 — 화면 상태가 그 모드를 안다.
 */
export interface KeyContext {
  /** 세션 화면의 DECCKM. */
  applicationCursorKeys: boolean;
}

const PLAIN_KEYS: Readonly<Record<string, string>> = {
  enter: "\r",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  escape: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  space: " ",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
};

/** 커서키 — 끝 글자. 보통 `ESC [ x`, DECCKM 이면 `ESC O x`. */
const CURSOR_KEYS: Readonly<Record<string, string>> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
  home: "H",
  end: "F",
};

const ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  btab: "shift-tab",
};

/** 사람이 고를 수 있는 이름 — 도움말·오류 문장이 같은 목록을 쓴다. */
export const KEY_NAMES: readonly string[] = [
  ...Object.keys(PLAIN_KEYS),
  ...Object.keys(CURSOR_KEYS),
  "ctrl-a … ctrl-z",
];

export function normalizeKeyName(raw: string): string {
  const lower = raw.trim().toLowerCase().replace(/\+/g, "-");
  return ALIASES[lower] ?? lower;
}

/** 모르는 이름이면 undefined. */
export function keyBytes(raw: string, context: KeyContext): string | undefined {
  const name = normalizeKeyName(raw);
  const plain = PLAIN_KEYS[name];
  if (plain !== undefined) {
    return plain;
  }
  const cursor = CURSOR_KEYS[name];
  if (cursor !== undefined) {
    return `${context.applicationCursorKeys ? "\x1bO" : "\x1b["}${cursor}`;
  }
  const ctrl = /^ctrl-([a-z])$/.exec(name);
  if (ctrl?.[1]) {
    return String.fromCharCode(ctrl[1].charCodeAt(0) - 0x60);
  }
  return undefined;
}

/** 앱이 bracketed paste(`CSI ? 2004 h`)를 켰을 때만 감싼다(설계 2-2). */
export function pasteBytes(text: string, bracketedPasteMode: boolean): string {
  return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}
