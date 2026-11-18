/**
 * `ainecto term key` 의 키 이름 → 바이트 — ★한 곳(설계 2-2, 순수 함수).
 * 이름은 설계서 표기(`ctrl-c`)가 정본이고, 사용자 web-cmux 표기(`ctrl+c`)와 별칭(esc·return)도 같은 키로 읽는다.
 * 방향키·Home·End 는 앱이 커서키 앱 모드(DECCKM, `CSI ? 1 h`)를 켰으면 `ESC O x` 로 보낸다 — 화면 상태가 그 모드를 안다.
 *
 * 수식 조합(`ctrl-`·`shift-`·`alt-` 를 기본 키 앞에, 순서 상관없이 한 번씩) — 표준 xterm 바이트만:
 * - 방향·Home·End 에 수식 → `CSI 1;m X`, PageUp·PageDown·Delete 에 수식 → `CSI n;m ~`
 *   (m = 1 + Shift 1 + Alt 2 + Ctrl 4 — 수식이 있으면 커서키 앱 모드와 상관없이 CSI)
 * - 그 밖의 한 바이트 키에 Alt → ESC + 그 바이트(Ctrl·Shift 를 먼저 적용: `ctrl-alt-c` = ESC ^C)
 * - Ctrl + 글자 = 제어 문자(Shift 가 같이 있어도 같다) · Ctrl + Space = NUL · Ctrl + / = 0x1F · Shift + 글자 = 대문자
 * 표준 바이트가 없는 조합(Shift/Ctrl + Enter·Tab·Backspace·Space·Escape 등, 앱마다 다름)은 짐작하지 않는다(undefined).
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

/** `CSI n ~` 키 — 수식이 붙으면 `CSI n;m ~`. */
const TILDE_KEYS: Readonly<Record<string, number>> = {
  delete: 3,
  pageup: 5,
  pagedown: 6,
};

const ALIASES: Readonly<Record<string, string>> = {
  esc: "escape",
  return: "enter",
  btab: "shift-tab",
  "/": "slash",
};

type Modifier = "ctrl" | "shift" | "alt";
const MODIFIERS: readonly Modifier[] = ["ctrl", "shift", "alt"];

/** 사람이 고를 수 있는 이름 — 도움말·오류 문장이 같은 목록을 쓴다. */
export const KEY_NAMES: readonly string[] = [
  ...Object.keys(PLAIN_KEYS),
  ...Object.keys(CURSOR_KEYS),
  "ctrl-a … ctrl-z",
  "ctrl-space",
  "ctrl-slash",
  "alt-<key>",
  "ctrl-/shift-/alt- + up/down/left/right/home/end/pageup/pagedown/delete",
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
  return comboBytes(name);
}

/** 수식 조합 — 이름을 수식(각 한 번)과 기본 키 하나로 나눠 표준 바이트로. 모르는 조합은 undefined. */
function comboBytes(name: string): string | undefined {
  const parts = name.split("-");
  const last = parts.pop() ?? "";
  const base = ALIASES[last] ?? last;
  const mods = new Set<Modifier>();
  for (const part of parts) {
    const mod = MODIFIERS.find((m) => m === part);
    if (!mod || mods.has(mod)) return undefined;
    mods.add(mod);
  }
  if (mods.size === 0 || base === "") return undefined;
  const ctrl = mods.has("ctrl");
  const shift = mods.has("shift");
  const alt = mods.has("alt");
  const m = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
  const cursor = CURSOR_KEYS[base];
  if (cursor !== undefined) return `\x1b[1;${m}${cursor}`;
  const tilde = TILDE_KEYS[base];
  if (tilde !== undefined) return `\x1b[${tilde};${m}~`;
  const single = singleByte(base, ctrl, shift);
  if (single === undefined) return undefined;
  return alt ? `\x1b${single}` : single;
}

/** Alt 를 뺀 한 바이트 — 글자·Space·/ 와 수식 없는 한 바이트 키(Enter·Tab·Backspace·Escape). 표준이 없으면 undefined. */
function singleByte(base: string, ctrl: boolean, shift: boolean): string | undefined {
  if (/^[a-z]$/.test(base)) {
    return ctrl ? String.fromCharCode(base.charCodeAt(0) - 0x60) : shift ? base.toUpperCase() : base;
  }
  if (base === "space") return ctrl && !shift ? "\x00" : !ctrl && !shift ? " " : undefined;
  if (base === "slash") return ctrl && !shift ? "\x1f" : !ctrl && !shift ? "/" : undefined;
  const plain = PLAIN_KEYS[base];
  return !ctrl && !shift && plain !== undefined && plain.length === 1 ? plain : undefined;
}

/** 앱이 bracketed paste(`CSI ? 2004 h`)를 켰을 때만 감싼다(설계 2-2). */
export function pasteBytes(text: string, bracketedPasteMode: boolean): string {
  return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}
