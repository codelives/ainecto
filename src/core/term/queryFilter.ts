import { TERM_STRING_HOLD_MAX_CHARS } from "./limits";
import { VtAction, VtState, vtStep, type VtActionValue, type VtStateValue } from "./vtParser";

/**
 * 터미널 «질의»를 출력에서 걷어 내는 필터이자 attach 의 시퀀스 경계(순수 — 입출력 없음). 리뷰 #81 T2 · #82 Q1·Q2 · #83 B1.
 *
 * 앱이 보낸 질의(커서 위치 CSI 6 n · 장치 속성 CSI c · 모드 질의 · 색 질의 OSC 11;? …)에 답하는 쪽은 세션마다
 * «하나»여야 한다 — 둘이 답하면 남는 답이 키 입력으로 앱에 들어간다. 그래서:
 *   · 붙은 클라이언트가 없으면(또는 주인이 없으면) 헤드리스 화면이 답한다.
 *   · 주인(마지막으로 붙거나 입력한 클라이언트)이 있으면 그 터미널만 질의를 받아 답하고, 나머지 붙은 클라이언트는
 *     이 필터로 질의를 뺀 출력을 받는다(질의는 화면에 아무것도 그리지 않는다).
 *
 * ★시퀀스가 어디서 시작하고 끝나는지는 이 파일이 정하지 않는다 — 세션 화면을 그리는 xterm 파서와 같은 전이
 *   (vtParser.ts)를 한 글자씩 따른다. 그래서 새 attach 가 시퀀스 한가운데서 갈라져도(forkForNewReader) 화면과 같은
 *   경계에서 이어진다. 이 파일이 정하는 것은 «끝난 시퀀스가 질의인가»뿐이다.
 *
 * 한 시퀀스는 파서가 GROUND 를 떠난 때부터 끝날 때까지 붙잡았다가 통째로 내보내거나(질의면) 뺀다.
 * 단 쥔 글자가 TERM_STRING_HOLD_MAX_CHARS 를 넘으면(큰 이미지·클립보드 문자열 — 질의일 수 없는 길이) 앞부분을 내보내고
 * 끝까지 쌓지 않고 흘린다. 그 사이 갈라져 붙은 새 독자는 앞부분이 없으므로 그 시퀀스의 남은 부분을 버린다(리뷰 #84 M1).
 * 시퀀스 중간에 파서가 «실행»하는 C0(BEL·CR·LF 등)은 바로 내보낸다 — 파서도 그 자리에서 실행하고 시퀀스를 이어 가므로
 * «C0 효과 → 나중 디스패치» 순서가 같다.
 */
export class QueryFilter {
  private state: VtStateValue = VtState.GROUND;
  /** 지금 시퀀스의 받은 글자 그대로(바로 내보낸 C0 제외). */
  private held = "";
  /** 파서가 의미로 모은 글자 — 매개변수·중간 글자·끝 글자·OSC/DCS 본문. 질의 판정에 쓴다. */
  private meaning = "";
  /** 방금 ESC 로 끝난 문자열을 통째로 뺐다(또는 꼬리를 버렸다) — 그 ESC 가 여는 `ESC \`(ST)도 뺀다. */
  private dropTerminator = false;
  /**
   * 지금 시퀀스가 상한을 넘었나(리뷰 #84 M1). none — 보통(끝날 때까지 쥔다) · pass — 앞부분은 이미 내보냈다, 끝까지
   * 바로 흘린다 · skip — 앞부분을 못 받은 새 독자다, 끝 글자까지 버린다.
   */
  private overflow: Overflow = "none";

  /**
   * 같은 경계에서 시작하는 새 필터 — 지금까지의 출력을 직렬화 화면으로만 받은 새 독자(attach)용.
   * 직렬화 화면은 파서의 반쪽 상태를 담지 않으므로, 붙잡혀 있던 반쪽 시퀀스를 그대로 이어받아 끝날 때 통째로 내보낸다.
   */
  forkForNewReader(): QueryFilter {
    const fork = new QueryFilter();
    fork.state = this.state;
    fork.held = this.held;
    fork.meaning = this.meaning;
    fork.dropTerminator = this.dropTerminator;
    fork.overflow = this.overflow === "none" ? "none" : "skip";
    return fork;
  }

  /** strip=false 면 시퀀스를 그대로 내보낸다(경계 상태만 이어 간다). */
  push(chunk: string, strip: boolean): string {
    let out = "";
    for (const char of chunk) {
      out += this.step(char, strip);
    }
    return out;
  }

  private step(char: string, strip: boolean): string {
    const code = char.codePointAt(0) ?? 0;
    const from = this.state;
    const { action, next } = vtStep(from, code);
    this.state = next;
    if (from === VtState.GROUND) {
      if (next === VtState.GROUND) {
        return char;
      }
      this.begin(char);
      return "";
    }
    if (action === VtAction.EXECUTE && next !== VtState.GROUND) {
      // 시퀀스 중간의 C0 — 파서는 실행만 하고 상태를 유지한다.
      return char;
    }
    if (next === VtState.GROUND) {
      return this.complete(action, char, strip);
    }
    if (startsNewSequence(code)) {
      // ESC·C1 도입 글자 — 지금 시퀀스를 끝내거나(OSC·DCS 의 ESC 끝) 버리고(그 밖) 새 시퀀스를 연다.
      const ended = action === VtAction.OSC_END || action === VtAction.DCS_UNHOOK
        ? this.complete(action, "", strip)
        : this.release(this.held);
      this.begin(char);
      return ended;
    }
    if (this.overflow !== "none") {
      return this.overflow === "pass" ? char : "";
    }
    this.held += char;
    if (MEANINGFUL.has(action)) {
      this.meaning += char;
    }
    if (this.held.length > TERM_STRING_HOLD_MAX_CHARS) {
      // 질의일 수 없는 길이 — 쥔 앞부분을 내보내고 이 시퀀스가 끝날 때까지 흘린다.
      const head = this.held;
      this.held = "";
      this.meaning = "";
      this.overflow = "pass";
      return this.release(head);
    }
    return "";
  }

  private begin(char: string): void {
    this.held = char;
    this.meaning = "";
    this.overflow = "none";
  }

  /** 끝난 시퀀스 — 질의면 빼거나(설정과 섞인 OSC 는 설정만 남겨) 그대로 내보낸다. */
  private complete(action: VtActionValue, terminator: string, strip: boolean): string {
    if (this.overflow !== "none") {
      return this.completeOverflow(terminator);
    }
    const whole = this.held + terminator;
    const meaning = DISPATCHES.has(action) ? this.meaning + terminator : this.meaning;
    const held = this.held;
    this.held = "";
    this.meaning = "";
    if (this.dropTerminator && action === VtAction.ESC_DISPATCH && meaning === "\\") {
      // 통째로 뺀(또는 꼬리를 버린) 문자열을 닫던 ST — 앞이 없으니 누구에게도 보내지 않는다.
      return this.release("");
    }
    if (!strip || terminator === CAN || terminator === SUB) {
      // 비주인이 아니거나, 취소(CAN·SUB)로 끝나 디스패치되지 않은 시퀀스.
      return this.release(whole);
    }
    switch (action) {
      case VtAction.CSI_DISPATCH:
        return this.release(isCsiQuery(meaning.slice(0, -1), meaning.slice(-1)) ? "" : whole);
      case VtAction.ESC_DISPATCH:
        // ESC Z (DECID) 는 옛 장치 속성 질의다.
        return this.release(meaning === "Z" ? "" : whole);
      case VtAction.OSC_END: {
        const pieces = oscWithoutQueries(meaning);
        if (pieces === undefined) {
          return this.release(whole);
        }
        const introducer = held.startsWith(C1_OSC) ? C1_OSC : `${ESC}]`;
        return this.releaseString(pieces.map((payload) => `${introducer}${payload}${terminator}`).join(""), terminator);
      }
      case VtAction.DCS_UNHOOK:
        // `DCS $ q`(DECRQSS) · `DCS + q`(XTGETTCAP) 만 질의다.
        return this.releaseString(/^[\d;:]*[$+]q/.test(meaning) ? "" : whole, terminator);
      default:
        return this.release(whole);
    }
  }

  /** 상한을 넘은 시퀀스의 끝 — 흘리던 쪽은 끝 글자도 흘리고, 앞부분이 없는 새 독자는 끝 글자까지 버린다. */
  private completeOverflow(terminator: string): string {
    const skipped = this.overflow === "skip";
    this.overflow = "none";
    if (!skipped) {
      return this.release(terminator);
    }
    // ESC 로 끝났으면(끝 글자 "") 그 ESC 가 여는 ST 도 버린다.
    this.dropTerminator = terminator === "";
    return "";
  }

  /** ESC 로 끝난 문자열을 통째로 뺐으면 뒤따르는 ST 도 뺄 차례다. */
  private releaseString(text: string, terminator: string): string {
    this.dropTerminator = text === "" && terminator === "";
    return text;
  }

  private release(text: string): string {
    this.dropTerminator = false;
    return text;
  }
}

/** 상한을 넘은 시퀀스의 처리 — QueryFilter.overflow. */
type Overflow = "none" | "pass" | "skip";

const ESC = "\x1b";
const CAN = "\x18";
const SUB = "\x1a";
const C1_OSC = "\x9d";

/** 파서가 «의미»로 모으는 동작 — 질의 판정 재료. */
const MEANINGFUL: ReadonlySet<VtActionValue> = new Set([VtAction.PARAM, VtAction.COLLECT, VtAction.OSC_PUT, VtAction.DCS_HOOK, VtAction.DCS_PUT]);
/** 끝 글자가 의미에 드는 끝 — CSI·ESC 의 끝 글자. */
const DISPATCHES: ReadonlySet<VtActionValue> = new Set([VtAction.CSI_DISPATCH, VtAction.ESC_DISPATCH]);

/** 어느 상태에서든 새 시퀀스를 여는 글자 — ESC 와 C1 도입 글자(CSI·DCS·OSC·SOS·PM·APC). */
function startsNewSequence(code: number): boolean {
  return code === 0x1b || code === 0x9b || code === 0x90 || code === 0x9d || code === 0x98 || code === 0x9e || code === 0x9f;
}

/** 색·클립보드 질의를 받는 OSC 번호 — `OSC Ps ; … ; ? ST`. */
const QUERYABLE_OSC = new Set(["4", "5", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "52"]);
/** XTWINOPS 보고 요청 — CSI Ps t 중 답을 돌려주는 것만(22·23 제목 저장·복원은 질의가 아니다). */
const WINDOW_REPORTS = new Set(["11", "13", "14", "15", "16", "18", "19", "20", "21"]);

/** CSI 매개변수(앞 표지·중간 글자 포함)와 끝 글자로 질의인지. */
function isCsiQuery(params: string, final: string): boolean {
  switch (final) {
    case "n":
      // DSR(CSI Ps n) · DEC DSR(CSI ? Ps n) 만 «보고하라»다 — xterm.js 6 InputHandler 도 이 두 꼴만 DSR 로 받는다.
      // CSI > Ps n 은 XTerm 의 «키 수정자 옵션 끄기»(modifyOtherKeys 등) — 설정이라 모든 화면에 가야 한다(리뷰 #84 Q1).
      return /^\??[\d;:]*$/.test(params);
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

/**
 * OSC 본문에서 «?» 매개변수만 뺀다(리뷰 #82 Q2 — XTerm 은 한 OSC 에 설정과 질의를 섞을 수 있다).
 * 질의가 없으면 undefined(그대로 내보낸다), 아니면 내보낼 본문들(빈 배열 = 전부 질의).
 *   4·5 : 번호;명세 짝이 여럿 — 질의가 아닌 짝만 남긴다.
 *   10–19 : 명세가 Ps, Ps+1, … 차례로 — 질의가 아닌 것만 제 번호의 OSC 로 따로 낸다(자리를 지우면 번호가 밀린다).
 *   52 : 클립보드 «?» 는 질의뿐이다.
 * 짝이 안 맞는 꼴은 손대지 않는다.
 */
function oscWithoutQueries(payload: string): string[] | undefined {
  const [command = "", ...fields] = payload.split(";");
  if (!QUERYABLE_OSC.has(command) || !fields.includes("?")) {
    return undefined;
  }
  if (command === "4" || command === "5") {
    if (fields.length % 2 !== 0) {
      return undefined;
    }
    const kept: string[] = [];
    for (let index = 0; index < fields.length; index += 2) {
      if (fields[index + 1] !== "?") {
        kept.push(fields[index] ?? "", fields[index + 1] ?? "");
      }
    }
    return kept.length > 0 ? [`${command};${kept.join(";")}`] : [];
  }
  if (command === "52") {
    return [];
  }
  const first = Number(command);
  return fields.flatMap((spec, offset) => (spec === "?" ? [] : [`${first + offset};${spec}`]));
}
