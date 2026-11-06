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
});
