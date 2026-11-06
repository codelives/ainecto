import headless from "@xterm/headless";
import { VT_TRANSITIONS, vtStep, type VtStateValue } from "../src/core/term/vtParser";

/**
 * 우리 경계 파서가 세션 화면을 그리는 xterm 파서(설치된 @xterm/headless 6.0.0)와 «같은 것»인지 —
 * ① 전이 표를 바이트 단위로 ② 같은 입력을 둘에 넣어 코드 포인트마다 상태를 대조한다(리뷰 #83 B1).
 * xterm 의 내부 필드를 읽는 것은 이 시험뿐이다(제품 코드는 옮긴 표만 쓴다). xterm 을 올려 표가 바뀌면 여기서 깨진다.
 */
interface XtermParser {
  _transitions: { table: Uint8Array };
  currentState: number;
  parse(data: Uint32Array, length: number): void;
}

function xtermParser(): XtermParser {
  const terminal = new headless.Terminal({ allowProposedApi: true });
  const core = (terminal as unknown as { _core: { _inputHandler: { _parser: XtermParser } } })._core;
  return core._inputHandler._parser;
}

describe("term VT parser — the same as xterm's", () => {
  it("has xterm's transition table byte for byte", () => {
    const theirs = xtermParser()._transitions.table;
    expect(VT_TRANSITIONS.length).toBe(theirs.length);
    const differences: number[] = [];
    for (let index = 0; index < theirs.length; index += 1) {
      if (VT_TRANSITIONS[index] !== theirs[index]) {
        differences.push(index);
      }
    }
    expect(differences).toEqual([]);
  });

  it("is in the same state as xterm after every code point of a long random stream", () => {
    // 시퀀스를 만드는 글자를 자주 섞는다 — ESC·C0·C1·중간 글자·매개변수·끝 글자·DEL·한글.
    const alphabet = [
      0x1b, 0x1b, 0x1b, 0x1b, 0x07, 0x08, 0x0a, 0x0d, 0x18, 0x1a, 0x1c, 0x00, 0x7f,
      0x5b, 0x5b, 0x5d, 0x5d, 0x50, 0x58, 0x5e, 0x5f, 0x5c, 0x28, 0x29, 0x23, 0x24, 0x25, 0x2b, 0x20, 0x21,
      0x30, 0x31, 0x36, 0x39, 0x3b, 0x3a, 0x3c, 0x3d, 0x3e, 0x3f,
      0x40, 0x41, 0x42, 0x48, 0x4a, 0x4d, 0x5a, 0x63, 0x68, 0x6c, 0x6d, 0x6e, 0x70, 0x71, 0x74, 0x75, 0x7e,
      0x80, 0x84, 0x90, 0x98, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xd55c,
    ];
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const theirs = xtermParser();
    let ours: VtStateValue = 0;
    const history: number[] = [];
    for (let index = 0; index < 50_000; index += 1) {
      const code = alphabet[random() % alphabet.length] ?? 0x41;
      history.push(code);
      theirs.parse(Uint32Array.of(code), 1);
      ours = vtStep(ours, code).next;
      if (ours !== theirs.currentState) {
        throw new Error(`state ${ours} ≠ xterm ${theirs.currentState} after ${history.slice(-12).map((value) => value.toString(16)).join(" ")}`);
      }
    }
  });
});
