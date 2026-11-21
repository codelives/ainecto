import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToEnd, spawnAgent } from "../../src/core/agent/child";
import { claudeAgentArgs } from "../../src/core/agent/claudeArgs";
import { killTree, planLaunch, spawnCapture } from "../../src/core/os/launch";
import { TermSession } from "../../src/core/term/session";
import { alive, until, WINDOWS } from "./winRig";

/**
 * W2(설계 windows-pc r3 3-2·3-3) — 실행 계획이 진짜 Windows 대상마다 argv 를 그대로 넘기는지(child_process · 실제 TermSession PTY 양쪽),
 * 그리고 killTree 의 성공·실패·부분 종료가 결과에 그대로 남는지. ★대상별 1·2회 이스케이프는 이 시험의 결과로 확정한다(3-2 표).
 */
const ARGS: readonly string[] = [
  "plain", "two words", "", 'quote"inside', "back\\slash", "end\\", 'bs\\"q', "!bang!", "%PATH%", "^&|<>()", "한글 인자",
  JSON.stringify({ a: "b c", d: [1, '"x"'] }),
];
/** 일반 배치 파일은 메타문자 왕복을 보장하지 않는다(한계) — 공백·따옴표·한글만 본다. */
const SIMPLE_ARGS: readonly string[] = ["plain", "two words", 'quote"inside', "한글 인자"];

let work: string;
let outFile: string;
let env: NodeJS.ProcessEnv;

const ECHO = 'require("node:fs").writeFileSync(process.env.ARGV_OUT, JSON.stringify(process.argv.slice(2)));';

beforeAll(async () => {
  if (!WINDOWS) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "awin-launch-")));
  outFile = join(work, "argv.json");
  // 진짜 npm 이 만드는 shim — 로컬(node_modules\.bin) · 전역(prefix) 두 자리.
  const pkg = join(work, "argv-echo");
  await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "argv-echo", version: "1.0.0", bin: { "argv-echo": "echo.js" } }));
  await writeFile(join(pkg, "echo.js"), `#!/usr/bin/env node\n${ECHO}\n`);
  const project = join(work, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", private: true }));
  const npm = { cwd: project, encoding: "utf8" as const, shell: true, windowsHide: true };
  execFileSync("npm", ["install", "--no-audit", "--no-fund", pkg], npm);
  execFileSync("npm", ["install", "-g", "--no-audit", "--no-fund", "--prefix", join(work, "global"), pkg], npm);
  // .exe 대역 — node.exe 복사본(스크립트를 첫 인자로).
  await copyFile(process.execPath, join(work, "echo-node.exe"));
  await writeFile(join(work, "echo.js"), ECHO);
  // 일반 배치 파일 두 종류 — %* 재전달 · %1 직접.
  await writeFile(join(work, "forward.bat"), `@"${process.execPath}" "%~dp0echo.js" %*\r\n`);
  await writeFile(join(work, "direct.bat"), `@"${process.execPath}" "%~dp0echo.js" %1\r\n`);
  // ★Path 는 키가 하나여야 한다 — 러너의 키는 «PATH» 라 «Path» 를 따로 얹으면 대소문자 무시 찾기가 앞의 PATH(전역 폴더 없음)를
  //   읽는다(run 44901543830 spawn argv-echo ENOENT). 원래 키를 지우고 한 키로 넣는다.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
  env = { ...inherited, ARGV_OUT: outFile, Path: `${join(work, "global")};${process.env.Path ?? ""}` };
}, 180_000);

afterAll(async () => {
  if (WINDOWS) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

async function viaChild(argv: readonly string[]): Promise<string[]> {
  await rm(outFile, { force: true });
  const child = spawnCapture(argv, { cwd: join(work, "project"), env });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  child.stdout.resume();
  // 띄우기 실패(ENOENT 등)는 close 없이 error 만 온다 — 기다리지 않고 그 오류로 실패한다.
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  expect(code, stderr).toBe(0);
  return JSON.parse(await readFile(outFile, "utf8")) as string[];
}

async function viaPty(argv: readonly string[]): Promise<string[]> {
  await rm(outFile, { force: true });
  const sessionEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  // 띄우기 실패(node-pty «File not found»)는 start 의 거절로 온다 — 버리지 않고 그 오류로 실패한다.
  const ended = new Promise<number>((resolve, reject) => {
    TermSession.start({ name: "w2", cwd: join(work, "project"), command: [...argv], env: sessionEnv, createdAt: new Date().toISOString() },
      (_session, exitCode) => resolve(exitCode)).catch(reject);
  });
  expect(await ended).toBe(0);
  return JSON.parse(await readFile(outFile, "utf8")) as string[];
}

const TARGETS: ReadonlyArray<{ name: string; argv: () => string[]; args: readonly string[] }> = [
  { name: ".exe", argv: () => [join(work, "echo-node.exe"), join(work, "echo.js")], args: ARGS },
  { name: "로컬 node_modules\\.bin shim", argv: () => [join(work, "project", "node_modules", ".bin", "argv-echo")], args: ARGS },
  { name: "npm 전역 shim(Path 로 찾음)", argv: () => ["argv-echo"], args: ARGS },
  { name: "npx.cmd", argv: () => ["npx", "--no-install", "argv-echo"], args: ARGS },
  { name: "일반 배치 %* 재전달", argv: () => [join(work, "forward.bat")], args: SIMPLE_ARGS },
];

describe.runIf(WINDOWS)("W2 실행 계획 — 대상별 argv 왕복(child_process · TermSession PTY)", () => {
  for (const target of TARGETS) {
    it(`${target.name} · child_process`, async () => {
      expect(await viaChild([...target.argv(), ...target.args])).toEqual(target.args);
    }, 30_000);
    it(`${target.name} · PTY`, async () => {
      expect(await viaPty([...target.argv(), ...target.args])).toEqual(target.args);
    }, 30_000);
  }

  it("일반 배치 %1 직접 — 공백·따옴표·한글 인자 하나", async () => {
    expect(await viaChild([join(work, "direct.bat"), "two words"])).toEqual(["two words"]);
  }, 60_000);

  it("claude 헤드리스 실제 인자(npm 설치 가정)의 최종 cmd 줄 길이를 잰다 — 넘으면 LAUNCH_LINE_TOO_LONG", () => {
    const args = claudeAgentArgs({ schema: { type: "object" }, mcpConfig: { mcpServers: { ainecto: { command: process.execPath, args: ["x"] } } } });
    const shim = join(work, "global", "argv-echo.cmd");
    let length: number | string;
    try {
      const plan = planLaunch([shim, ...args], env);
      length = `${plan.child.file} ${plan.child.args.join(" ")}`.length;
    } catch (error) {
      length = error instanceof Error ? error.message : String(error);
    }
    console.log(JSON.stringify({ measure: "claude-args-cmd-line", length }));
  });
});

describe.runIf(WINDOWS)("W2 killTree — 결과를 버리지 않는다", () => {
  /** cmd → node(손자) 트리. 손자 pid 를 파일로 받는다. */
  async function tree(): Promise<{ child: ReturnType<typeof spawnAgent>; grandchild: number }> {
    const pidFile = join(work, `gc-${Date.now()}.pid`);
    const script = join(work, "hold.js");
    await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
    const holder = join(work, "hold.bat");
    await writeFile(holder, `@"${process.execPath}" "${script}"\r\n`);
    const child = spawnAgent(holder, [], { cwd: work, env });
    await until(async () => (await readFile(pidFile, "utf8").then(() => true, () => false)), "grandchild pid");
    return { child, grandchild: Number.parseInt(await readFile(pidFile, "utf8"), 10) };
  }

  it("성공: taskkill /T 가 0 → tree=ok · 손자까지 사라진다", async () => {
    const { child, grandchild } = await tree();
    expect(await killTree(child, 10_000)).toEqual({ directExited: true, tree: "ok" });
    await until(() => !alive(grandchild), "grandchild gone");
  }, 60_000);

  it("이미 끝난 프로세스 → not-attempted", async () => {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((resolve) => child.once("exit", resolve));
    expect(await killTree(child, 5_000)).toEqual({ directExited: true, tree: "not-attempted" });
  });

  it("실패·부분 종료: 가짜 taskkill(직계만 끄고 1) → tree=failed + 끝 코드 · 직계는 끝나도 손자는 남는다(정직하게 보고)", async () => {
    const fake = join(work, "fake-taskkill");
    await mkdir(fake, { recursive: true });
    await writeFile(join(fake, "taskkill.bat"), `@"%SystemRoot%\\System32\\taskkill.exe" /PID %2 /F >nul\r\n@exit /b 1\r\n`);
    const { child, grandchild } = await tree();
    const saved = process.env.Path;
    process.env.Path = `${fake};${saved ?? ""}`;
    try {
      const result = await killTree(child, 10_000);
      expect(result.directExited).toBe(true);
      expect(result.tree).toBe("failed");
      expect(result.detail).toMatch(/taskkill exit 1/);
      expect(alive(grandchild)).toBe(true);
    } finally {
      process.env.Path = saved;
      if (alive(grandchild)) process.kill(grandchild);
    }
  }, 60_000);

  it("runToEnd: 기한을 넘기면 트리째 끄고 결과를 싣는다", async () => {
    const script = join(work, "forever.js");
    await writeFile(script, "setInterval(() => {}, 1000);");
    const bat = join(work, "forever.bat");
    await writeFile(bat, `@"${process.execPath}" "${script}"\r\n`);
    const result = await runToEnd(spawnAgent, bat, [], { cwd: work, env, timeoutMs: 1_000 });
    expect(result.timedOut).toBe(true);
    expect(result.kill?.tree).toBe("ok");
  }, 60_000);
});
