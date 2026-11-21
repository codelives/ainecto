import { spawn } from "node:child_process";
import { runToEnd, spawnAgent } from "../src/core/agent/child";
import { CMD_LINE_MAX, findExecutable, killTree, LaunchError, planLaunch, quoteArgument, stuckProcessHint } from "../src/core/os/launch";

/**
 * 실행 계획·강제 종료(설계 windows-pc r3 3-2·3-3) — 이 맥에서 돌릴 수 있는 부분(순수 계획 · Unix 실물 · Windows 분기의 실패 경로).
 * Windows 실물 왕복(진짜 shim·PTY·taskkill)은 test/windows/launch.win.test.ts.
 */
const COMSPEC = "C:\\Windows\\system32\\cmd.exe";
const WIN_ENV = { ComSpec: COMSPEC, PATHEXT: ".com;.exe;.bat;.cmd", Path: "C:\\Tools;C:\\Users\\r\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs" };

function files(...present: string[]): (path: string) => boolean {
  const set = new Set(present.map((path) => path.toLowerCase()));
  return (path) => set.has(path.toLowerCase());
}

describe("planLaunch — Unix 는 지금 그대로", () => {
  it("이름·인자 그대로, PTY 는 배열", () => {
    expect(planLaunch(["claude", "-p", "a b"], {}, "darwin")).toEqual({
      argv: ["claude", "-p", "a b"],
      child: { file: "claude", args: ["-p", "a b"], windowsVerbatimArguments: false },
      pty: { file: "claude", commandLine: ["-p", "a b"] },
    });
  });

  it("빈 명령은 사람 말 오류", () => {
    expect(() => planLaunch([], {}, "linux")).toThrow(expect.objectContaining({ code: "LAUNCH_EMPTY" }));
  });
});

describe("findExecutable — Path × PATHEXT, 현재 폴더는 찾지 않는다", () => {
  it("Path 순서 → 그 안에서 PATHEXT 순서 · env 키 대소문자 무시", () => {
    const isFile = files("C:\\Users\\r\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Program Files\\nodejs\\claude.exe");
    expect(findExecutable("claude", WIN_ENV, isFile)).toBe("C:\\Users\\r\\AppData\\Roaming\\npm\\claude.cmd");
    expect(findExecutable("claude", { pathext: WIN_ENV.PATHEXT, PATH: "C:\\Program Files\\nodejs" }, isFile)).toBe("C:\\Program Files\\nodejs\\claude.exe");
  });

  it("확장자를 이미 달았으면 그 이름만 · 폴더를 달았으면 Path 를 보지 않는다 · 없으면 undefined", () => {
    expect(findExecutable("npx.cmd", WIN_ENV, files("C:\\Program Files\\nodejs\\npx.cmd"))).toBe("C:\\Program Files\\nodejs\\npx.cmd");
    expect(findExecutable("C:\\x\\tool", WIN_ENV, files("C:\\x\\tool.exe"))).toBe("C:\\x\\tool.exe");
    expect(findExecutable("nothing", WIN_ENV, files())).toBeUndefined();
  });
});

describe("planLaunch — Windows", () => {
  it(".exe(공식 설치 claude.exe): child 는 인자 배열(libuv 따옴표) · PTY 는 MSVCRT 따옴표 문자열", () => {
    const exe = "C:\\Users\\홍 길동\\.local\\bin\\claude.exe";
    const plan = planLaunch(["claude", "-p", "", 'a "b"'], { ...WIN_ENV, Path: "C:\\Users\\홍 길동\\.local\\bin" }, "win32", files(exe));
    expect(plan.child).toEqual({ file: exe, args: ["-p", "", 'a "b"'], windowsVerbatimArguments: false });
    expect(plan.pty).toEqual({ file: exe, commandLine: '"-p" "" "a \\"b\\""' });
    expect(plan.argv).toEqual(["claude", "-p", "", 'a "b"']);
  });

  it("npm 전역 .cmd(claude.cmd): %ComSpec% /d /s /c \"…\" · 메타문자 ^ 한 번(후보 — W2 실측으로 확정)", () => {
    const shim = "C:\\Users\\r\\AppData\\Roaming\\npm\\claude.cmd";
    const plan = planLaunch(["claude", "a&b", "%PATH%"], WIN_ENV, "win32", files(shim));
    const line = '"C:\\Users\\r\\AppData\\Roaming\\npm\\claude.cmd ^"a^&b^" ^"^%PATH^%^""';
    expect(plan.child).toEqual({ file: COMSPEC, args: ["/d", "/s", "/c", line], windowsVerbatimArguments: true });
    expect(plan.pty).toEqual({ file: COMSPEC, commandLine: `/d /s /c ${line}` });
  });

  it("로컬 node_modules\\.bin\\*.cmd: 메타문자 ^ 두 번(cross-spawn 7.0.6 과 같다)", () => {
    const shim = "C:\\proj\\node_modules\\.bin\\argv-echo.cmd";
    const plan = planLaunch([shim, "a&b"], WIN_ENV, "win32", files(shim));
    expect(plan.child.args[3]).toBe('"C:\\proj\\node_modules\\.bin\\argv-echo.cmd ^^^"a^^^&b^^^""');
  });

  it("최종 줄이 cmd 한도를 넘으면 띄우기 전에 사람 말 오류(이스케이프 뒤 길이로 잰다)", () => {
    const shim = "C:\\Users\\r\\AppData\\Roaming\\npm\\claude.cmd";
    // 인자 하나 = ^" … ^"(따옴표도 cmd 메타문자라 ^ 가 붙는다).
    const fits = "x".repeat(CMD_LINE_MAX - `${COMSPEC} /d /s /c "${shim} ^"^""`.length);
    expect(() => planLaunch(["claude", fits], WIN_ENV, "win32", files(shim))).not.toThrow();
    expect(() => planLaunch(["claude", `${fits}x`], WIN_ENV, "win32", files(shim))).toThrow(expect.objectContaining({ code: "LAUNCH_LINE_TOO_LONG" }));
    // 메타문자는 이스케이프로 길어진다 — 원래 길이가 아니라 최종 줄로 판정한다.
    expect(() => planLaunch(["claude", "&".repeat(fits.length)], WIN_ENV, "win32", files(shim))).toThrow(LaunchError);
  });

  it(".cmd 인데 ComSpec 이 없으면 사람 말 오류 · 못 찾은 이름은 그대로(띄울 때 ENOENT = «설치 안 됨»)", () => {
    const shim = "C:\\Tools\\x.cmd";
    expect(() => planLaunch(["x"], { PATHEXT: ".cmd", Path: "C:\\Tools" }, "win32", files(shim))).toThrow(expect.objectContaining({ code: "LAUNCH_NO_COMSPEC" }));
    expect(planLaunch(["codex", "app-server"], WIN_ENV, "win32", files()).child).toEqual({ file: "codex", args: ["app-server"], windowsVerbatimArguments: false });
  });

  it("quoteArgument — CommandLineToArgvW 규칙(따옴표 앞 역슬래시는 두 배, 끝 역슬래시도 두 배)", () => {
    expect(quoteArgument("")).toBe('""');
    expect(quoteArgument("a b")).toBe('"a b"');
    expect(quoteArgument('a"b')).toBe('"a\\"b"');
    expect(quoteArgument('a\\"b')).toBe('"a\\\\\\"b"');
    expect(quoteArgument("C:\\dir\\")).toBe('"C:\\dir\\\\"');
    expect(quoteArgument("C:\\a\\b")).toBe('"C:\\a\\b"');
  });

  it("멈춘 프로세스 안내 문구는 플랫폼마다 한 곳", () => {
    expect(stuckProcessHint(42, "win32")).toBe("If it hangs: taskkill /PID 42 /F.");
    expect(stuckProcessHint(42, "darwin")).toBe("If it is stopped: kill -CONT 42. If it hangs: kill 42.");
  });
});

describe.runIf(process.platform !== "win32")("killTree — Unix 실물 · Windows 분기의 실패 경로", () => {
  it("Unix: 신호 하나 · 직계 끝남 · 트리는 시도하지 않음(지금 동작 그대로)", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await new Promise((resolve) => child.once("spawn", resolve));
    expect(await killTree(child, 5_000, "SIGTERM")).toEqual({ directExited: true, tree: "not-attempted" });
    expect(await killTree(child, 5_000)).toEqual({ directExited: true, tree: "not-attempted" });
  });

  it("Windows 분기에서 taskkill 을 못 띄우면 tree=failed — 직계 kill 대체는 directExited 만 바꾸고 tree 를 ok 로 바꾸지 않는다", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    await new Promise((resolve) => child.once("spawn", resolve));
    const result = await killTree(child, 2_000, "SIGTERM", "win32");
    expect(result.directExited).toBe(true);
    expect(result.tree).toBe("failed");
    expect(result.detail).toMatch(/taskkill did not start/);
  });

  it("runToEnd: 기한을 넘겨 끈 뒤 손자가 pipe 를 쥐고 있어도 기다림이 끝난다(close 대기도 기한) · 끈 결과가 호출처까지", async () => {
    const started = Date.now();
    const result = await runToEnd(spawnAgent, "/bin/sh", ["-c", "sleep 30 & echo $!; wait"], { cwd: process.cwd(), env: process.env, timeoutMs: 300 });
    const grandchild = Number.parseInt(result.stdout.trim(), 10);
    try {
      expect(result.timedOut).toBe(true);
      expect(result.kill).toEqual({ directExited: true, tree: "not-attempted" });
      expect(Date.now() - started).toBeLessThan(20_000);
    } finally {
      if (Number.isSafeInteger(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  }, 30_000);
});
