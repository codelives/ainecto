import { QueryFilter } from "../src/core/term/queryFilter";

/** 질의 필터 — 질의만 빠지고 나머지 바이트는 한 글자도 바뀌지 않는다. 덩어리를 어디서 잘라도 결과가 같다. */
function strip(input: string, cuts: number[] = []): string {
  const filter = new QueryFilter();
  let out = "";
  let start = 0;
  for (const cut of [...cuts, input.length]) {
    out += filter.push(input.slice(start, cut), true);
    start = cut;
  }
  return out;
}

describe("term query filter", () => {
  it("drops cursor, device, mode, window, version and kitty queries", () => {
    const queries = ["\x1b[6n", "\x1b[5n", "\x1b[?6n", "\x1b[c", "\x1b[0c", "\x1b[>c", "\x1b[>0c", "\x1b[=c", "\x1b[?2004$p", "\x1b[18t", "\x1b[>q", "\x1b[?u", "\x1bZ"];
    for (const query of queries) {
      expect(strip(`a${query}b`), JSON.stringify(query)).toBe("ab");
    }
  });

  it("drops OSC colour and DCS capability queries with either terminator", () => {
    expect(strip("a\x1b]11;?\x07b")).toBe("ab");
    expect(strip("a\x1b]4;1;?\x1b\\b")).toBe("ab");
    expect(strip("a\x1bP$qm\x1b\\b")).toBe("ab");
    expect(strip("a\x1bP+q544e\x1b\\b")).toBe("ab");
  });

  it("keeps drawing, mode changes, colour settings, titles, links and sixel untouched", () => {
    const kept = [
      "\x1b[31m빨강\x1b[0m",
      "\x1b[?1049h\x1b[2J\x1b[H",
      "\x1b[?2004h",
      "\x1b[22;0t",
      "\x1b[>1u",
      "\x1b]11;rgb:00/00/00\x07",
      "\x1b]0;제목\x07",
      "\x1b]8;;https://ainecto.com\x1b\\link\x1b]8;;\x1b\\",
      "\x1bPq#0;2;0;0;0~-\x1b\\",
      "\x1b7\x1b8\x1bM",
    ];
    for (const text of kept) {
      expect(strip(text), JSON.stringify(text)).toBe(text);
    }
  });

  it("keeps CSI > Ps n — it turns a key modifier option off, it does not ask (review #84 Q1)", () => {
    // modifyOtherKeys 켜기(CSI > 4 ; 2 m) → 질의(CSI 6 n) → 끄기(CSI > 4 n): 비주인에게서 질의만 빠진다.
    expect(strip("a\x1b[>4;2mb\x1b[6nc\x1b[>4nd")).toBe("a\x1b[>4;2mbc\x1b[>4nd");
    for (const reset of ["\x1b[>n", "\x1b[>0n", "\x1b[>1n", "\x1b[>2n", "\x1b[>4n"]) {
      expect(strip(`a${reset}b`), JSON.stringify(reset)).toBe(`a${reset}b`);
      expect(strip(`a${reset}b`, [3]), JSON.stringify(reset)).toBe(`a${reset}b`);
    }
  });

  it("gives the same result wherever the chunks are cut", () => {
    const input = "x\x1b[6ny\x1b]11;?\x1b\\z\x1b[31mr\x1b]0;t\x07w";
    const expected = "xyz\x1b[31mr\x1b]0;t\x07w";
    for (let cut = 1; cut < input.length; cut += 1) {
      expect(strip(input, [cut]), `cut at ${cut}`).toBe(expected);
    }
    expect(strip(input, Array.from({ length: input.length - 1 }, (_, index) => index + 1))).toBe(expected);
  });

  it("passes everything through when not stripping, but still across chunk boundaries", () => {
    const filter = new QueryFilter();
    expect(filter.push("a\x1b[", false) + filter.push("6nb", false)).toBe("a\x1b[6nb");
  });

  it("ends an unterminated string at the next ESC and reads that ESC as a new sequence", () => {
    expect(strip("a\x1b]11;?\x1b[6nb")).toBe("ab");
    expect(strip("a\x1b]0;t\x1b[31mb")).toBe("a\x1b]0;t\x1b[31mb");
  });

  it("keeps the settings of an OSC that mixes settings and queries (review #82 Q2)", () => {
    expect(strip("\x1b]4;1;rgb:ff/00/00;2;?\x07")).toBe("\x1b]4;1;rgb:ff/00/00\x07");
    expect(strip("\x1b]4;1;?;2;?\x1b\\")).toBe("");
    // 10–19 는 자리가 번호다 — 질의를 지우면 번호가 밀리므로 남는 설정을 제 번호로 따로 낸다.
    expect(strip("\x1b]10;?;blue\x07")).toBe("\x1b]11;blue\x07");
    expect(strip("\x1b]10;red;?\x07")).toBe("\x1b]10;red\x07");
    expect(strip("\x1b]52;c;?\x07")).toBe("");
    expect(strip("\x1b]52;c;aGk=\x07")).toBe("\x1b]52;c;aGk=\x07");
  });
});

describe("term query filter — a reader that joins mid-stream (review #82 Q1)", () => {
  it("hands a half-read CSI to the new reader whole, so the tail is not printed as text", () => {
    const stream = new QueryFilter();
    expect(stream.push("x\x1b[", false)).toBe("x");
    const late = stream.forkForNewReader();
    expect(late.push("31mRED", false)).toBe("\x1b[31mRED");
    expect(stream.forkForNewReader().push("6n", true)).toBe("");
  });

  it("holds a string until the parser ends it, so a reader who joins in the middle gets it whole (review #83 B1)", () => {
    const stream = new QueryFilter();
    expect(stream.push("\x1b]0;long ti", false)).toBe("");
    const late = stream.forkForNewReader();
    expect(late.push("tle\x07after", false)).toBe("\x1b]0;long title\x07after");
    expect(stream.push("tle\x07after", false)).toBe("\x1b]0;long title\x07after");
  });

  it("keeps an ESC intermediate until its final byte — ESC ( then B is one charset selection (review #83 B1)", () => {
    const stream = new QueryFilter();
    expect(stream.push("\x1b(", false)).toBe("");
    expect(stream.forkForNewReader().push("BHELLO", false)).toBe("\x1b(BHELLO");
  });

  it("runs a C0 inside a CSI without ending it — ESC [ 31 BEL then m is still SGR 31 (review #83 B1)", () => {
    const stream = new QueryFilter();
    expect(stream.push("\x1b[31\x07", false)).toBe("\x07");
    const late = stream.forkForNewReader();
    expect(late.push("mRED", false)).toBe("\x1b[31mRED");
    // 질의를 빼는 쪽에서도 SGR 은 SGR 이다.
    expect(stream.forkForNewReader().push("mRED", true)).toBe("\x1b[31mRED");
    const query = new QueryFilter();
    expect(query.push("\x1b[\x07", true) + query.forkForNewReader().push("6n", true)).toBe("\x07");
  });

  it("hands a held colour query to the new reader whole", () => {
    const stream = new QueryFilter();
    expect(stream.push("\x1b]11;", false)).toBe("");
    expect(stream.forkForNewReader().push("?\x07", false)).toBe("\x1b]11;?\x07");
  });
});

