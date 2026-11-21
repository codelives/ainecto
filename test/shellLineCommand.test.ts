import { describe, expect, it } from "vitest";
import { defaultShellCommand, planLaunch, shellLineCommand } from "../src/core/os/launch";

/** 명령 «줄» → 세션 명령 한 곳 — 다음 판 웹 «새 세션»이 쓴다(로그인 셸이 따옴표·파이프·&&·변수 대입을 해석). */
describe("shellLineCommand", () => {
  it("줄 = [로그인 셸, -lc, 줄] 한 덩어리 · 공백만이면 null(로그인 셸 그대로)", () => {
    const env = { SHELL: "/bin/zsh" };
    expect(shellLineCommand("  claude --append-system-prompt \"a b\" ", env, "darwin")).toEqual(["/bin/zsh", "-lc", "claude --append-system-prompt \"a b\""]);
    expect(shellLineCommand("FOO=1 make && echo ok | tr o 0", env, "darwin")).toEqual(["/bin/zsh", "-lc", "FOO=1 make && echo ok | tr o 0"]);
    expect(shellLineCommand("   ", env, "darwin")).toBeNull();
  });

  it("Windows: 줄 = [%ComSpec%, /d, /s, /c, 줄] · 기본 셸 = %ComSpec% · 실행 계획은 줄을 이스케이프하지 않고 cmd 에 그대로(사용자 줄 계약)", () => {
    const env = { ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    const argv = shellLineCommand(" claude --resume \"a b\" && echo %USERNAME% ", env, "win32");
    expect(argv).toEqual([env.ComSpec, "/d", "/s", "/c", "claude --resume \"a b\" && echo %USERNAME%"]);
    expect(defaultShellCommand(env, "win32")).toEqual([env.ComSpec]);
    const plan = planLaunch(argv ?? [], env, "win32");
    expect(plan.pty).toEqual({ file: env.ComSpec, commandLine: '/d /s /c "claude --resume \"a b\" && echo %USERNAME%"' });
    expect(plan.child).toEqual({ file: env.ComSpec, args: ["/d", "/s", "/c", '"claude --resume \"a b\" && echo %USERNAME%"'], windowsVerbatimArguments: true });
    expect(() => shellLineCommand("x", {}, "win32")).toThrow(expect.objectContaining({ code: "LAUNCH_NO_COMSPEC" }));
  });
});
