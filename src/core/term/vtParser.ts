/**
 * VT 시퀀스 경계 — `@xterm/headless 6.0.0` 의 EscapeSequenceParser 상태 전이를 «그대로» 옮겼다(리뷰 #83 B1).
 * 세션 화면을 그리는 헤드리스 파서와 우리 경계 필터가 같은 바이트에서 같은 상태에 있어야 attach 의 첫 화면과
 * 그 뒤 출력이 이어진다. 사례마다 예외를 덧대는 대신 표 자체를 같게 둔다 — 시험이 설치된 xterm 의 표와 바이트 단위로
 * 대조하고, 같은 입력을 두 파서에 넣어 매 코드 포인트의 상태를 비교한다(xterm 을 올리면 거기서 깨진다).
 *
 * 원본: xterm.js src/common/parser/EscapeSequenceParser.ts(VT500_TRANSITION_TABLE · parse 의 OSC_END/DCS_UNHOOK)
 * 와 src/common/parser/Constants.ts. Copyright (c) 2017 The xterm.js authors. MIT License.
 * 원본의 표는 Paul Williams 의 DEC ANSI 파서 상태도(https://vt100.net/emu/dec_ansi_parser)를 따른다.
 */

/** 파서 상태 — 원본 ParserState 와 같은 번호. */
export const VtState = {
  GROUND: 0,
  ESCAPE: 1,
  ESCAPE_INTERMEDIATE: 2,
  CSI_ENTRY: 3,
  CSI_PARAM: 4,
  CSI_INTERMEDIATE: 5,
  CSI_IGNORE: 6,
  SOS_PM_APC_STRING: 7,
  OSC_STRING: 8,
  DCS_ENTRY: 9,
  DCS_PARAM: 10,
  DCS_IGNORE: 11,
  DCS_INTERMEDIATE: 12,
  DCS_PASSTHROUGH: 13,
} as const;

/** 파서 동작 — 원본 ParserAction 과 같은 번호. */
export const VtAction = {
  IGNORE: 0,
  ERROR: 1,
  PRINT: 2,
  EXECUTE: 3,
  OSC_START: 4,
  OSC_PUT: 5,
  OSC_END: 6,
  CSI_DISPATCH: 7,
  PARAM: 8,
  COLLECT: 9,
  ESC_DISPATCH: 10,
  CLEAR: 11,
  DCS_HOOK: 12,
  DCS_PUT: 13,
  DCS_UNHOOK: 14,
} as const;

export type VtStateValue = (typeof VtState)[keyof typeof VtState];
export type VtActionValue = (typeof VtAction)[keyof typeof VtAction];

const ACTION_SHIFT = 4;
const STATE_MASK = 15;
const STATE_SHIFT = 8;
/** 원본의 «ASCII 밖 인쇄 문자» 자리 — 0xA0 이상의 코드 포인트는 모두 이 칸을 본다. */
const NON_ASCII_PRINTABLE = 0xa0;

/** 원본 VT500_TRANSITION_TABLE 을 같은 순서·같은 호출로 만든다(한 줄씩 대응). */
export const VT_TRANSITIONS: Uint8Array = (() => {
  const table = new Uint8Array(4095);
  const setDefault = (action: number, next: number): void => {
    table.fill((action << ACTION_SHIFT) | next);
  };
  const add = (code: number, state: number, action: number, next: number): void => {
    table[(state << STATE_SHIFT) | code] = (action << ACTION_SHIFT) | next;
  };
  const addMany = (codes: number[], state: number, action: number, next: number): void => {
    for (const code of codes) {
      add(code, state, action, next);
    }
  };
  const r = (start: number, end: number): number[] => Array.from({ length: end - start }, (_, index) => start + index);
  const S = VtState;
  const A = VtAction;

  const PRINTABLES = r(0x20, 0x7f);
  const EXECUTABLES = [...r(0x00, 0x18), 0x19, ...r(0x1c, 0x20)];
  const states = r(S.GROUND, S.DCS_PASSTHROUGH + 1);

  setDefault(A.ERROR, S.GROUND);
  addMany(PRINTABLES, S.GROUND, A.PRINT, S.GROUND);
  for (const state of states) {
    addMany([0x18, 0x1a, 0x99, 0x9a], state, A.EXECUTE, S.GROUND);
    addMany(r(0x80, 0x90), state, A.EXECUTE, S.GROUND);
    addMany(r(0x90, 0x98), state, A.EXECUTE, S.GROUND);
    add(0x9c, state, A.IGNORE, S.GROUND);
    add(0x1b, state, A.CLEAR, S.ESCAPE);
    add(0x9d, state, A.OSC_START, S.OSC_STRING);
    addMany([0x98, 0x9e, 0x9f], state, A.IGNORE, S.SOS_PM_APC_STRING);
    add(0x9b, state, A.CLEAR, S.CSI_ENTRY);
    add(0x90, state, A.CLEAR, S.DCS_ENTRY);
  }
  addMany(EXECUTABLES, S.GROUND, A.EXECUTE, S.GROUND);
  addMany(EXECUTABLES, S.ESCAPE, A.EXECUTE, S.ESCAPE);
  add(0x7f, S.ESCAPE, A.IGNORE, S.ESCAPE);
  addMany(EXECUTABLES, S.OSC_STRING, A.IGNORE, S.OSC_STRING);
  addMany(EXECUTABLES, S.CSI_ENTRY, A.EXECUTE, S.CSI_ENTRY);
  add(0x7f, S.CSI_ENTRY, A.IGNORE, S.CSI_ENTRY);
  addMany(EXECUTABLES, S.CSI_PARAM, A.EXECUTE, S.CSI_PARAM);
  add(0x7f, S.CSI_PARAM, A.IGNORE, S.CSI_PARAM);
  addMany(EXECUTABLES, S.CSI_IGNORE, A.EXECUTE, S.CSI_IGNORE);
  addMany(EXECUTABLES, S.CSI_INTERMEDIATE, A.EXECUTE, S.CSI_INTERMEDIATE);
  add(0x7f, S.CSI_INTERMEDIATE, A.IGNORE, S.CSI_INTERMEDIATE);
  addMany(EXECUTABLES, S.ESCAPE_INTERMEDIATE, A.EXECUTE, S.ESCAPE_INTERMEDIATE);
  add(0x7f, S.ESCAPE_INTERMEDIATE, A.IGNORE, S.ESCAPE_INTERMEDIATE);
  // osc
  add(0x5d, S.ESCAPE, A.OSC_START, S.OSC_STRING);
  addMany(PRINTABLES, S.OSC_STRING, A.OSC_PUT, S.OSC_STRING);
  add(0x7f, S.OSC_STRING, A.OSC_PUT, S.OSC_STRING);
  addMany([0x9c, 0x1b, 0x18, 0x1a, 0x07], S.OSC_STRING, A.OSC_END, S.GROUND);
  addMany(r(0x1c, 0x20), S.OSC_STRING, A.IGNORE, S.OSC_STRING);
  // sos/pm/apc does nothing
  addMany([0x58, 0x5e, 0x5f], S.ESCAPE, A.IGNORE, S.SOS_PM_APC_STRING);
  addMany(PRINTABLES, S.SOS_PM_APC_STRING, A.IGNORE, S.SOS_PM_APC_STRING);
  addMany(EXECUTABLES, S.SOS_PM_APC_STRING, A.IGNORE, S.SOS_PM_APC_STRING);
  add(0x9c, S.SOS_PM_APC_STRING, A.IGNORE, S.GROUND);
  add(0x7f, S.SOS_PM_APC_STRING, A.IGNORE, S.SOS_PM_APC_STRING);
  // csi entries
  add(0x5b, S.ESCAPE, A.CLEAR, S.CSI_ENTRY);
  addMany(r(0x40, 0x7f), S.CSI_ENTRY, A.CSI_DISPATCH, S.GROUND);
  addMany(r(0x30, 0x3c), S.CSI_ENTRY, A.PARAM, S.CSI_PARAM);
  addMany([0x3c, 0x3d, 0x3e, 0x3f], S.CSI_ENTRY, A.COLLECT, S.CSI_PARAM);
  addMany(r(0x30, 0x3c), S.CSI_PARAM, A.PARAM, S.CSI_PARAM);
  addMany(r(0x40, 0x7f), S.CSI_PARAM, A.CSI_DISPATCH, S.GROUND);
  addMany([0x3c, 0x3d, 0x3e, 0x3f], S.CSI_PARAM, A.IGNORE, S.CSI_IGNORE);
  addMany(r(0x20, 0x40), S.CSI_IGNORE, A.IGNORE, S.CSI_IGNORE);
  add(0x7f, S.CSI_IGNORE, A.IGNORE, S.CSI_IGNORE);
  addMany(r(0x40, 0x7f), S.CSI_IGNORE, A.IGNORE, S.GROUND);
  addMany(r(0x20, 0x30), S.CSI_ENTRY, A.COLLECT, S.CSI_INTERMEDIATE);
  addMany(r(0x20, 0x30), S.CSI_INTERMEDIATE, A.COLLECT, S.CSI_INTERMEDIATE);
  addMany(r(0x30, 0x40), S.CSI_INTERMEDIATE, A.IGNORE, S.CSI_IGNORE);
  addMany(r(0x40, 0x7f), S.CSI_INTERMEDIATE, A.CSI_DISPATCH, S.GROUND);
  addMany(r(0x20, 0x30), S.CSI_PARAM, A.COLLECT, S.CSI_INTERMEDIATE);
  // esc_intermediate
  addMany(r(0x20, 0x30), S.ESCAPE, A.COLLECT, S.ESCAPE_INTERMEDIATE);
  addMany(r(0x20, 0x30), S.ESCAPE_INTERMEDIATE, A.COLLECT, S.ESCAPE_INTERMEDIATE);
  addMany(r(0x30, 0x7f), S.ESCAPE_INTERMEDIATE, A.ESC_DISPATCH, S.GROUND);
  addMany(r(0x30, 0x50), S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  addMany(r(0x51, 0x58), S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  addMany([0x59, 0x5a, 0x5c], S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  addMany(r(0x60, 0x7f), S.ESCAPE, A.ESC_DISPATCH, S.GROUND);
  // dcs entry
  add(0x50, S.ESCAPE, A.CLEAR, S.DCS_ENTRY);
  addMany(EXECUTABLES, S.DCS_ENTRY, A.IGNORE, S.DCS_ENTRY);
  add(0x7f, S.DCS_ENTRY, A.IGNORE, S.DCS_ENTRY);
  addMany(r(0x1c, 0x20), S.DCS_ENTRY, A.IGNORE, S.DCS_ENTRY);
  addMany(r(0x20, 0x30), S.DCS_ENTRY, A.COLLECT, S.DCS_INTERMEDIATE);
  addMany(r(0x30, 0x3c), S.DCS_ENTRY, A.PARAM, S.DCS_PARAM);
  addMany([0x3c, 0x3d, 0x3e, 0x3f], S.DCS_ENTRY, A.COLLECT, S.DCS_PARAM);
  addMany(EXECUTABLES, S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  addMany(r(0x20, 0x80), S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  addMany(r(0x1c, 0x20), S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  addMany(EXECUTABLES, S.DCS_PARAM, A.IGNORE, S.DCS_PARAM);
  add(0x7f, S.DCS_PARAM, A.IGNORE, S.DCS_PARAM);
  addMany(r(0x1c, 0x20), S.DCS_PARAM, A.IGNORE, S.DCS_PARAM);
  addMany(r(0x30, 0x3c), S.DCS_PARAM, A.PARAM, S.DCS_PARAM);
  addMany([0x3c, 0x3d, 0x3e, 0x3f], S.DCS_PARAM, A.IGNORE, S.DCS_IGNORE);
  addMany(r(0x20, 0x30), S.DCS_PARAM, A.COLLECT, S.DCS_INTERMEDIATE);
  addMany(EXECUTABLES, S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_INTERMEDIATE);
  add(0x7f, S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_INTERMEDIATE);
  addMany(r(0x1c, 0x20), S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_INTERMEDIATE);
  addMany(r(0x20, 0x30), S.DCS_INTERMEDIATE, A.COLLECT, S.DCS_INTERMEDIATE);
  addMany(r(0x30, 0x40), S.DCS_INTERMEDIATE, A.IGNORE, S.DCS_IGNORE);
  addMany(r(0x40, 0x7f), S.DCS_INTERMEDIATE, A.DCS_HOOK, S.DCS_PASSTHROUGH);
  addMany(r(0x40, 0x7f), S.DCS_PARAM, A.DCS_HOOK, S.DCS_PASSTHROUGH);
  addMany(r(0x40, 0x7f), S.DCS_ENTRY, A.DCS_HOOK, S.DCS_PASSTHROUGH);
  addMany(EXECUTABLES, S.DCS_PASSTHROUGH, A.DCS_PUT, S.DCS_PASSTHROUGH);
  addMany(PRINTABLES, S.DCS_PASSTHROUGH, A.DCS_PUT, S.DCS_PASSTHROUGH);
  add(0x7f, S.DCS_PASSTHROUGH, A.IGNORE, S.DCS_PASSTHROUGH);
  addMany([0x1b, 0x9c, 0x18, 0x1a], S.DCS_PASSTHROUGH, A.DCS_UNHOOK, S.GROUND);
  // special handling of unicode chars
  add(NON_ASCII_PRINTABLE, S.GROUND, A.PRINT, S.GROUND);
  add(NON_ASCII_PRINTABLE, S.OSC_STRING, A.OSC_PUT, S.OSC_STRING);
  add(NON_ASCII_PRINTABLE, S.CSI_IGNORE, A.IGNORE, S.CSI_IGNORE);
  add(NON_ASCII_PRINTABLE, S.DCS_IGNORE, A.IGNORE, S.DCS_IGNORE);
  add(NON_ASCII_PRINTABLE, S.DCS_PASSTHROUGH, A.DCS_PUT, S.DCS_PASSTHROUGH);
  return table;
})();

export interface VtStep {
  action: VtActionValue;
  next: VtStateValue;
}

/**
 * 코드 포인트 하나의 전이 — 원본 parse 반복과 같다: 0xA0 이상은 NON_ASCII_PRINTABLE 칸을 보고,
 * ESC 로 끝난 OSC·DCS(OSC_END·DCS_UNHOOK)는 GROUND 가 아니라 ESCAPE 로 간다(그 ESC 가 다음 시퀀스를 연다).
 */
export function vtStep(state: VtStateValue, code: number): VtStep {
  const transition = VT_TRANSITIONS[(state << STATE_SHIFT) | (code < NON_ASCII_PRINTABLE ? code : NON_ASCII_PRINTABLE)] ?? 0;
  const action = (transition >> ACTION_SHIFT) as VtActionValue;
  let next = (transition & STATE_MASK) as VtStateValue;
  if (code === 0x1b && (action === VtAction.OSC_END || action === VtAction.DCS_UNHOOK)) {
    next = VtState.ESCAPE;
  }
  return { action, next };
}
