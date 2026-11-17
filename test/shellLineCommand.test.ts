import { describe, expect, it } from "vitest";
import { shellLineCommand } from "../src/core/term/session";

/** 명령 «줄» → 세션 명령 한 곳 — 다음 판 웹 «새 세션»이 쓴다(로그인 셸이 따옴표·파이프·&&·변수 대입을 해석). */
describe("shellLineCommand", () => {
  it("줄 = [로그인 셸, -lc, 줄] 한 덩어리 · 공백만이면 null(로그인 셸 그대로)", () => {
    const env = { SHELL: "/bin/zsh" };
    expect(shellLineCommand("  claude --append-system-prompt \"a b\" ", env)).toEqual(["/bin/zsh", "-lc", "claude --append-system-prompt \"a b\""]);
    expect(shellLineCommand("FOO=1 make && echo ok | tr o 0", env)).toEqual(["/bin/zsh", "-lc", "FOO=1 make && echo ok | tr o 0"]);
    expect(shellLineCommand("   ", env)).toBeNull();
  });
});
