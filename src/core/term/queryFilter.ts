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
 * 새로 붙는 클라이언트는 세션이 들고 있는 필터의 {@link QueryFilter.forkForNewReader} 로 시작한다(리뷰 #82 Q1).
 * 설정과 질의가 한 OSC 에 섞여 있으면 질의 부분만 뺀다(리뷰 #82 Q2).
 */
type StringMode =
  /** OSC 번호·DCS 머리를 읽는 중(붙잡음). */
  | "head"
  /** 질의일 수 있는 문자열 — 끝까지 붙잡는다. */
  | "query"
  /** 질의가 될 수 없는 문자열 — 흘리며 끝만 찾는다. */
  | "pass"
  /** 앞부분을 못 본 새 독자에게 남은 문자열 — 끝까지 아무것도 내보내지 않는다. */
  | "skip";

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

  /**
   * 같은 경계에서 시작하는 새 필터 — 지금까지의 출력을 직렬화 화면으로만 받은 새 독자(attach)용.
   * 붙잡혀 있던 반쪽 시퀀스(CSI·질의 문자열 머리)는 그대로 이어받아 완성될 때 통째로 내보낸다 — 직렬화 화면은
   * 파서의 반쪽 상태를 담지 않으므로 이렇게 해야 새 화면에 꼬리 글자가 찍히지 않고 질의도 온전히 받는다.
   * 이미 흘려보낸 문자열(pass)의 나머지는 새 독자에게 버린다(skip) — 앞부분을 못 봤다.
   */
  forkForNewReader(): QueryFilter {
    const fork = new QueryFilter();
    const state = this.state;
    fork.state = state.kind === "string" && state.mode === "pass" ? { ...state, mode: "skip" } : { ...state };
    return fork;
  }

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
    const skipping = state.mode === "skip";
    if (state.escaped) {
      if (char === "\\") {
        // ST — 문자열 끝.
        this.state = { kind: "ground" };
        return skipping ? "" : passing ? ESC + char : this.finish(state.held + ESC + char, strip);
      }
      // ESC 다음이 \ 가 아니다 — 문자열은 ESC 앞에서 끝났고 그 ESC 가 새 시퀀스를 연다.
      const ended = passing || skipping ? "" : this.finish(state.held, strip);
      this.state = { kind: "esc" };
      return ended + this.step(char, strip);
    }
    if (char === ESC) {
      this.state = { ...state, escaped: true };
      return "";
    }
    if (char === CAN || char === SUB || (char === BEL && state.type === "osc")) {
      this.state = { kind: "ground" };
      if (skipping) {
        return "";
      }
      if (char === BEL && !passing) {
        return this.finish(state.held + char, strip);
      }
      // 취소는 터미널에 그대로 맡긴다.
      return passing ? char : state.held + char;
    }
    if (passing) {
      return char;
    }
    if (skipping) {
      return "";
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

  /** 붙잡은 문자열 하나가 끝났다 — 질의 부분을 뺀다. */
  private finish(whole: string, strip: boolean): string {
    return strip ? withoutQueries(whole) : whole;
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

/** 붙잡은 OSC·DCS 문자열에서 질의 부분만 뺀 것 — 전부 질의면 빈 문자열, 질의가 없으면 그대로. */
function withoutQueries(whole: string): string {
  if (whole.startsWith(`${ESC}]`)) {
    return oscWithoutQueries(whole);
  }
  return /^\x1bP[\d;]*[$+]q/.test(whole) ? "" : whole;
}

/**
 * OSC 에서 «?» 매개변수만 뺀다(리뷰 #82 Q2 — XTerm 은 한 OSC 에 설정과 질의를 섞을 수 있다).
 *   4·5 : 번호;명세 짝이 여럿 — 질의가 아닌 짝만 남긴다.
 *   10–19 : 명세가 Ps, Ps+1, … 차례로 — 질의가 아닌 것만 제 번호의 OSC 로 따로 낸다(자리를 지우면 번호가 밀린다).
 *   52 : 클립보드 «?» 는 질의뿐이다.
 * 끝맺음(BEL·ST·없음)은 원래 것을 그대로 쓴다. 짝이 안 맞는 꼴은 손대지 않는다.
 */
function oscWithoutQueries(whole: string): string {
  const terminator = whole.endsWith(BEL) ? BEL : whole.endsWith(`${ESC}\\`) ? `${ESC}\\` : "";
  const [command = "", ...fields] = whole.slice(2, whole.length - terminator.length).split(";");
  if (!QUERYABLE_OSC.has(command) || !fields.includes("?")) {
    return whole;
  }
  if (command === "4" || command === "5") {
    if (fields.length % 2 !== 0) {
      return whole;
    }
    const kept: string[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      if (fields[index + 1] !== "?") {
        kept.push(fields[index] ?? "", fields[index + 1] ?? "");
      }
    }
    return kept.length > 0 ? `${ESC}]${command};${kept.join(";")}${terminator}` : "";
  }
  if (command === "52") {
    return "";
  }
  const first = Number(command);
  return fields.map((spec, offset) => (spec === "?" ? "" : `${ESC}]${first + offset};${spec}${terminator}`)).join("");
}
