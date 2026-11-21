import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellLineCommand } from "../../src/core/os/launch";
import { TermSession } from "../../src/core/term/session";
import { alive, until, WINDOWS } from "./winRig";

/**
 * W3(설계 windows-pc r3 8·9·3-4) — 기본 셸 = cmd · 사용자 줄 = cmd 가 해석 · ConPTY ^C → 자식 node SIGINT · 강제 끄기의 성공 기준 = 트리 소멸.
 * ★SIGHUP 처리기가 돌았는지는 기준이 아니다. 잔존이 보이면 이 시험이 실패한다 — 그 결과를 루트에 보고한다(설계 GO 가 잔존을 받아들인 것이 아니다).
 */
let work: string;
let env: Record<string, string>;

beforeAll(async () => {
  if (!WINDOWS) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "awin-pty-")));
  env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
});
afterAll(async () => {
  if (WINDOWS) await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
});

interface Running {
  session: TermSession;
  exit: Promise<number>;
}

async function start(command: string[] | null, cwd: string = work): Promise<Running> {
  let resolveExit: (code: number) => void = () => undefined;
  const exit = new Promise<number>((resolve) => { resolveExit = resolve; });
  const session = await TermSession.start({ name: `w3-${Date.now()}`, cwd, command, env, createdAt: new Date().toISOString() },
    (_session, exitCode) => resolveExit(exitCode));
  return { session, exit };
}

async function screen(running: Running): Promise<string> {
  return (await running.session.read({ scrollback: true })).join("\n");
}

describe.runIf(WINDOWS)("W3 PTY — 셸·^C·강제 끄기", () => {
  it("기본 셸(command 없음) = %ComSpec% 대화형 — 입력한 명령을 cmd 가 돌린다", async () => {
    const running = await start(null);
    await running.session.send("echo w3-%COMPUTERNAME%-ok\r", false);
    await until(async () => /w3-.+-ok/.test(await screen(running)), "echo in default shell");
    await running.session.send("exit\r", false);
    expect(await running.exit).toBe(0);
  }, 60_000);

  it("사용자 줄(웹 메뉴 ②) = cmd /d /s /c — && 와 %변수% 를 cmd 가 해석한다", async () => {
    const running = await start(shellLineCommand('echo first && echo "second %OS%"', env));
    expect(await running.exit).toBe(0);
    const text = await screen(running);
    expect(text).toContain("first");
    expect(text).toContain('"second Windows_NT"');
  }, 60_000);

  it("^C → 자식 node 의 SIGINT 처리기가 돌고 코드 0 으로 끝난다(정상 끄기)", async () => {
    const marker = join(work, "sigint.txt");
    const script = join(work, "sigint.js");
    await writeFile(script, `process.on("SIGINT", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(0); });
console.log("w3-ready"); setInterval(() => {}, 1000);`);
    const running = await start([process.execPath, script]);
    await until(async () => (await screen(running)).includes("w3-ready"), "ready");
    await running.session.key("ctrl-c");
    expect(await running.exit).toBe(0);
    expect(await readFile(marker, "utf8")).toBe("1");
  }, 60_000);

  /** npx.cmd 로 감싼 node 에 ^C — 끝나는 시간·«일괄 작업» 프롬프트·자식 SIGINT 처리기를 잰다(설계 9번). */
  async function npxCtrlC(measure: string, command: (project: string) => string[]): Promise<void> {
    const pkg = join(work, `${measure}-pkg`);
    await mkdir(pkg, { recursive: true });
    const marker = join(work, `${measure}.txt`);
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "sigint-wait", version: "1.0.0", bin: { "sigint-wait": "wait.js" } }));
    await writeFile(join(pkg, "wait.js"), `#!/usr/bin/env node
process.on("SIGINT", () => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1"); process.exit(0); });
console.log("w3-npx-ready"); setInterval(() => {}, 1000);`);
    const project = join(work, `${measure}-project`);
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", private: true }));
    execFileSync("npm", ["install", "--no-audit", "--no-fund", pkg], { cwd: project, shell: true, windowsHide: true });
    const running = await start(command(project), project);
    await until(async () => (await screen(running)).includes("w3-npx-ready"), "npx ready");
    const sent = Date.now();
    await running.session.key("ctrl-c");
    const ended = await Promise.race([running.exit.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000))]);
    const text = await screen(running);
    console.log(JSON.stringify({ measure, endedWithin10s: ended, ms: Date.now() - sent, batchPrompt: /\(Y\/N\)/i.test(text) }));
    if (!ended) running.session.kill();
    expect(await readFile(marker, "utf8")).toBe("1");
  }

  it("npx.cmd 로 감싼 node 에 ^C — 지금 실행 계획(planLaunch .cmd → %ComSpec% /d /s /c)", async () => {
    await npxCtrlC("npx-ctrl-c", () => ["npx", "--no-install", "sigint-wait"]);
  }, 90_000);

  // ★결정 전 실측(impl-notes «결정 필요» Ctrl+C) — 후보 A: 감싼 cmd 의 표준 입력을 NUL 로 주면 프롬프트가 NUL 을 읽고 바로 끝나는가.
  //   콘솔 Ctrl+C 신호는 표준 입력과 무관하게 콘솔에 붙은 프로세스에 가므로 자식 SIGINT 처리기는 그대로 돌아야 한다.
  it("후보 A 실측 — 같은 명령을 cmd 표준 입력 NUL 로(< nul)", async () => {
    await npxCtrlC("npx-ctrl-c-stdin-nul", () => shellLineCommand("npx --no-install sigint-wait < nul", env) ?? []);
  }, 90_000);

  it("강제 끄기(TermSession.kill) 성공 기준 = 트리 소멸: cmd → node(콘솔) → node(창 숨김 자식) 가 모두 사라진다", async () => {
    const pids = join(work, "tree.json");
    const parent = join(work, "parent.js");
    await writeFile(parent, `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
require("node:fs").writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);`);
    const holder = join(work, "parent.bat");
    await writeFile(holder, `@"${process.execPath}" "${parent}"\r\n`);
    const running = await start([holder]);
    await until(async () => (await readFile(pids, "utf8").then(() => true, () => false)), "tree pids");
    const tree = JSON.parse(await readFile(pids, "utf8")) as { parent: number; child: number };
    running.session.kill();
    await running.exit;
    const left = await until(() => !alive(tree.parent) && !alive(tree.child), "tree gone", 15_000).then(() => [], () => [
      ...(alive(tree.parent) ? [`parent ${tree.parent}`] : []), ...(alive(tree.child) ? [`hidden child ${tree.child}`] : []),
    ]);
    console.log(JSON.stringify({ measure: "pty-force-kill-tree", left }));
    for (const pid of [tree.parent, tree.child]) if (alive(pid)) process.kill(pid);
    expect(left).toEqual([]);
  }, 60_000);
});
