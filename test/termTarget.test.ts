import { pickTarget } from "../src/core/term/target";
import type { ListedSession } from "../src/core/term/protocol";

/** `<uuid|이름>` 풀기(세션 유지 구조 원칙 2 · G7) — uuid 면 그것, 이름이면 정확히 하나일 때만. */
const row = (name: string, instance?: string): ListedSession =>
  ({ name, pid: 1, clients: 0, cols: 80, rows: 24, cwd: "/", command: null, ...(instance !== undefined ? { instance } : {}) });
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("pickTarget", () => {
  it("uuid 가 맞으면 그 세션(이름이 무엇이든) · 이름이 하나면 그 세션의 uuid 를 싣는다 · 옛 데몬(인스턴스 없음)은 이름만", () => {
    expect(pickTarget([row("a", A), row("b", B)], B)).toEqual({ name: "b", instance: B });
    expect(pickTarget([row("a", A), row("b", B)], "a")).toEqual({ name: "a", instance: A });
    expect(pickTarget([row(A, B), row("x", A)], A)).toEqual({ name: "x", instance: A });   // uuid 가 먼저
    expect(pickTarget([row("old")], "old")).toEqual({ name: "old" });
  });

  it("이름이 여럿이면 «uuid 로 지정» · 없으면 «세션 없음»", () => {
    expect(() => pickTarget([row("a", A), row("a", B)], "a")).toThrow(expect.objectContaining({ code: "TERM_AMBIGUOUS_NAME" }));
    expect(() => pickTarget([row("a", A)], "z")).toThrow(expect.objectContaining({ code: "TERM_NO_SESSION" }));
  });
});
