/**
 * 터미널 «질의»를 출력에서 걷어 내는 필터(순수 — 입출력 없음). 리뷰 #81 T2.
 *
 * 앱이 보낸 질의(커서 위치 CSI 6 n · 장치 속성 CSI c · 모드 질의 · 색 질의 OSC 11;? …)에 답하는 쪽은 세션마다
 * «하나»여야 한다 — 둘이 답하면 남는 답이 키 입력으로 앱에 들어간다. 그래서:
 *   · 붙은 클라이언트가 없으면(또는 주인이 없으면) 헤드리스 화면이 답한다.
 *   · 주인(마지막으로 붙거나 입력한 클라이언트)이 있으면 그 터미널만 질의를 받아 답하고, 나머지 붙은 클라이언트는
 *     이 필터로 질의를 뺀 출력을 받는다(질의는 화면에 아무것도 그리지 않는다).
 *
 * 덩어리 사이에 걸친 시퀀스는 끝날 때까지 붙잡는다. 클라이언트마다 인스턴스 하나가 상태를 이어 가므로 주인이 바뀌는
 * 순간에도 반쪽 시퀀스가 두 번 나가지 않는다. 질의가 될 수 없는 OSC·DCS(제목·링크·그림)는 머리만 보고 바로 흘린다.
 */
type StringMode =
  /** OSC 번호·DCS 머리를 읽는 중(붙잡음). */
  | "head"
  /** 질의일 수 있는 문자열 — 끝까지 붙잡는다. */
  | "query"
  /** 질의가 될 수 없는 문자열 — 흘리며 끝만 찾는다. */
  | "pass";

type State =
  | { kind: "ground" }
  | { kind: "esc" }
  | { kind: "csi"; held: string }
  | { kind: "string"; type: "osc" | "dcs"; held: string; mode: StringMode; escaped: boolean };

const ESC = "\x1b";
const BEL = "\x07";
const CAN = "\x18";
const SUB = "\x1a";

/** 색·클립보드 질의를 받는 OSC 번호 — `OSC Ps ; … ; ? ST`. */
const QUERYABLE_OSC = new Set(["4", "5", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "52"]);
/** XTWINOPS 보고 요청 — CSI Ps t 중 답을 돌려주는 것만(22·23 제목 저장·복원은 질의가 아니다). */
const WINDOW_REPORTS = new Set(["11", "13", "14", "15", "16", "18", "19", "20", "21"]);

export class QueryFilter {
  private state: State = { kind: "ground" };

  /** strip=false 면 시퀀스를 그대로 내보낸다(덩어리 경계 상태만 이어 간다). */
  push(chunk: string, strip: boolean): string {
    let out = "";
    for (const char of chunk) {
      out += this.step(char, strip);
    }
    return out;
  }

  private step(char: string, strip: boolean): string {
    const state = this.state;
    switch (state.kind) {
      case "ground":
        if (char === ESC) {
          this.state = { kind: "esc" };
          return "";
        }
        return char;
      case "esc":
        if (char === "[") {
          this.state = { kind: "csi", held: ESC + char };
          return "";
        }
        if (char === "]" || char === "P") {
          this.state = { kind: "string", type: char === "]" ? "osc" : "dcs", held: ESC + char, mode: "head", escaped: false };
          return "";
        }
        if (char === ESC) {
          // ESC ESC — 앞 ESC 는 홀로 끝났다.
          return ESC;
        }
        this.state = { kind: "ground" };
        // ESC Z (DECID) 는 옛 장치 속성 질의다.
        return strip && char === "Z" ? "" : ESC + char;
      case "csi": {
        const held = state.held + char;
        const code = char.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          this.state = { kind: "ground" };
          return strip && isCsiQuery(held.slice(2, -1), char) ? "" : held;
        }
        if (code >= 0x20 && code <= 0x3f) {
          this.state = { kind: "csi", held };
          return "";
        }
        // 시퀀스 안의 다른 문자(취소·제어 문자) — 모양이 깨졌다. 터미널에 그대로 맡긴다.
        this.state = { kind: "ground" };
        return held;
      }
      case "string":
        return this.stringStep(state, char, strip);
    }
  }

  private stringStep(state: Extract<State, { kind: "string" }>, char: string, strip: boolean): string {
    const passing = state.mode === "pass";
    if (state.escaped) {
      if (char === "\\") {
        // ST — 문자열 끝.
        this.state = { kind: "ground" };
        return passing ? ESC + char : this.finish(state.held + ESC + char, strip);
      }
      // ESC 다음이 \ 가 아니다 — 문자열은 ESC 앞에서 끝났고 그 ESC 가 새 시퀀스를 연다.
      const ended = passing ? "" : this.finish(state.held, strip);
      this.state = { kind: "esc" };
      return ended + this.step(char, strip);
    }
    if (char === ESC) {
      this.state = { ...state, escaped: true };
      return "";
    }
    if (char === CAN || char === SUB || (char === BEL && state.type === "osc")) {
      this.state = { kind: "ground" };
      if (char === BEL && !passing) {
        return this.finish(state.held + char, strip);
      }
      // 취소는 터미널에 그대로 맡긴다.
      return passing ? char : state.held + char;
    }
    if (passing) {
      return char;
    }
    const held = state.held + char;
    if (state.mode === "query") {
      this.state = { ...state, held };
      return "";
    }
    const next = headMode(state.type, held.slice(2));
    if (next === "pass") {
      this.state = { ...state, held: "", mode: "pass" };
      return held;
    }
    this.state = { ...state, held, mode: next };
    return "";
  }

  /** 붙잡은 문자열 하나가 끝났다 — 질의면 버린다. */
  private finish(whole: string, strip: boolean): string {
    return strip && isStringQuery(whole) ? "" : whole;
  }
}

/** 문자열 머리(ESC ] / ESC P 뒤)로 다음 모드를 정한다. */
function headMode(type: "osc" | "dcs", body: string): StringMode {
  if (type === "osc") {
    const semicolon = body.indexOf(";");
    if (semicolon === -1) {
      return /^\d*$/.test(body) ? "head" : "pass";
    }
    return QUERYABLE_OSC.has(body.slice(0, semicolon)) ? "query" : "pass";
  }
  const last = body.charCodeAt(body.length - 1);
  if (last >= 0x40 && last <= 0x7e) {
    // 머리 끝 — `DCS $ q`(DECRQSS)·`DCS + q`(XTGETTCAP)만 질의다.
    return /^[\d;]*[$+]q$/.test(body) ? "query" : "pass";
  }
  return "head";
}

/** CSI 매개변수(앞 표지 포함)와 끝 글자로 질의인지. */
function isCsiQuery(params: string, final: string): boolean {
  switch (final) {
    case "n":
      // DSR — 장치 상태·커서 위치 등 «보고하라»뿐이다.
      return true;
    case "c":
      // DA1(CSI c, CSI 0 c) · DA2(CSI > c) · DA3(CSI = c).
      return /^[>=]?0?$/.test(params);
    case "p":
      // DECRQM — CSI Ps $ p / CSI ? Ps $ p.
      return params.endsWith("$");
    case "t":
      return WINDOW_REPORTS.has(params.split(";")[0] ?? "");
    case "q":
      // XTVERSION — CSI > q / CSI > 0 q.
      return /^>0?$/.test(params);
    case "u":
      // kitty 키보드 현재 플래그 질의.
      return params === "?";
    default:
      return false;
  }
}

/** 붙잡은 OSC·DCS 문자열 전체가 질의인지. */
function isStringQuery(whole: string): boolean {
  if (whole.startsWith(`${ESC}]`)) {
    const fields = whole.slice(2).replace(/(\x07|\x1b\\)$/, "").split(";");
    return QUERYABLE_OSC.has(fields[0] ?? "") && fields.slice(1).includes("?");
  }
  return /^\x1bP[\d;]*[$+]q/.test(whole);
}
