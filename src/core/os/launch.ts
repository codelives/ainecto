import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
  type ChildProcessWithoutNullStreams,
  type StdioOptions,
} from "node:child_process";
import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { win32 } from "node:path";
import type { Readable } from "node:stream";

/**
 * 프로세스 띄우기·끄기의 ★한 곳(설계 windows-pc r3 3-2·3-3). child_process 를 실행하는 곳은 이 파일과 브라우저 열기(oauth.ts)뿐이다
 * — 아키텍처 시험이 강제한다. 플랫폼마다 다른 것(실행 파일 찾기·cmd 이스케이프·창 숨김·트리 종료·셸)은 여기 안에 가둔다.
 *
 *   macOS·Linux : 지금 동작 그대로(이름 그대로 띄움 · 신호로 끔 · 로그인 셸).
 *   Windows     : ① Path × PATHEXT 로 찾는다 ② .exe/.com 은 바로 ③ .cmd/.bat 은 %ComSpec% /d /s /c 로 감싼다(cross-spawn 7.0.6 규칙을
 *                 후보로 — 대상별 1·2회는 W2 실측으로 확정) ④ 창을 숨긴다 ⑤ 강제 종료는 taskkill /T /F(결과를 버리지 않는다).
 */

/** cmd.exe 명령줄 한도(글자) — Microsoft «Command prompt line string limitation». 결재 2026-11-21(설계 7절 3). */
export const CMD_LINE_MAX = 8191;

/** cmd 메타문자 — cross-spawn 7.0.6 lib/util/escape.js. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
/** 로컬 npm shim — cross-spawn 7.0.6 lib/parse.js isCmdShimRegExp(메타문자 2회). */
const LOCAL_CMD_SHIM = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;
const BATCH = /\.(?:cmd|bat)$/i;

/** 실행 계획 — 원래 명령(argv)은 그대로 두고(매니페스트·runningPcs 판정), child_process 용과 PTY 용 표현을 따로 낸다. */
export interface LaunchPlan {
  argv: readonly string[];
  child: { file: string; args: string[]; windowsVerbatimArguments: boolean };
  /** node-pty 용 — Windows 는 항상 완성된 명령줄 문자열(node-pty 의 배열 따옴표 규칙을 쓰지 않는다). */
  pty: { file: string; commandLine: string | string[] };
}

export class LaunchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type Env = Record<string, string | undefined>;

/** 순수 함수(파일 있음 판정만 주입). 못 찾으면 이름 그대로 둔다 — 띄울 때 ENOENT(«설치 안 됨» 보고)가 그대로 난다. */
export function planLaunch(
  argv: readonly string[],
  env: Env,
  platform: NodeJS.Platform = process.platform,
  isFile: (path: string) => boolean = fileExists,
): LaunchPlan {
  const [command, ...args] = argv;
  if (command === undefined || command === "") {
    throw new LaunchError("LAUNCH_EMPTY", "The command to run is empty.");
  }
  if (platform !== "win32") {
    return { argv, child: { file: command, args, windowsVerbatimArguments: false }, pty: { file: command, commandLine: args } };
  }
  const file = findExecutable(command, env, isFile) ?? command;
  if (!BATCH.test(file)) {
    return { argv, child: { file, args, windowsVerbatimArguments: false }, pty: { file, commandLine: args.map(quoteArgument).join(" ") } };
  }
  const comspec = requireComSpec(env);
  const twice = LOCAL_CMD_SHIM.test(file);
  const line = `"${[escapeCmd(win32.normalize(file)), ...args.map((arg) => escapeCmd(quoteArgument(arg), twice))].join(" ")}"`;
  const total = `${comspec} /d /s /c ${line}`.length;
  if (total > CMD_LINE_MAX) {
    throw new LaunchError("LAUNCH_LINE_TOO_LONG", `Running ${win32.basename(file)} needs a ${total}-character cmd.exe line, over its ${CMD_LINE_MAX}-character limit. `
      + "Install the program's native .exe (for Claude Code: the official installer) so cmd.exe is not needed.");
  }
  return { argv, child: { file: comspec, args: ["/d", "/s", "/c", line], windowsVerbatimArguments: true }, pty: { file: comspec, commandLine: `/d /s /c ${line}` } };
}

/** MSVCRT(CommandLineToArgvW) 규칙으로 인자 하나를 따옴표한다 — qntm.org/cmd · cross-spawn escapeArgument 의 앞부분. 순수 함수. */
export function quoteArgument(arg: string): string {
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

function escapeCmd(text: string, twice = false): string {
  const once = text.replace(CMD_META, "^$1");
  return twice ? once.replace(CMD_META, "^$1") : once;
}

/** Windows 실행 파일 찾기 — Path × PATHEXT(env 키는 대소문자 무시). 현재 폴더는 찾지 않는다. 순수 함수(파일 판정 주입). */
export function findExecutable(command: string, env: Env, isFile: (path: string) => boolean): string | undefined {
  const extensions = (envValue(env, "PATHEXT") ?? "").split(";").map((ext) => ext.trim()).filter(Boolean);
  const own = win32.extname(command).toLowerCase();
  const names = own !== "" && extensions.some((ext) => ext.toLowerCase() === own) ? [command] : extensions.map((ext) => `${command}${ext}`);
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir ? [""] : (envValue(env, "Path") ?? "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = hasDir ? name : win32.join(dir, name);
      if (isFile(full)) return full;
    }
  }
  return undefined;
}

function envValue(env: Env, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function requireComSpec(env: Env): string {
  const comspec = envValue(env, "ComSpec");
  if (!comspec) {
    throw new LaunchError("LAUNCH_NO_COMSPEC", "ComSpec is not set (Windows sets it to cmd.exe), so .cmd/.bat programs and the default shell cannot start.");
  }
  return comspec;
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 입출력 셋 다 pipe — Agent(claude·codex). */
export function spawnPiped(argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  const plan = planLaunch(argv, options.env);
  return spawn(plan.child.file, plan.child.args, {
    cwd: options.cwd, env: options.env, windowsHide: true, windowsVerbatimArguments: plan.child.windowsVerbatimArguments,
  });
}

/** 입력 없음 · 출력 둘을 모은다 — 짧은 외부 명령(setup·status·doctor·npx 확인·taskkill). */
export function spawnCapture(argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessByStdio<null, Readable, Readable> {
  const plan = planLaunch(argv, options.env);
  return spawn(plan.child.file, plan.child.args, {
    cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    windowsVerbatimArguments: plan.child.windowsVerbatimArguments,
  });
}

/** 세션 밖 독립 프로세스 — 지금 node 로 이 CLI 자신을 띄운다(찾기 없음). 콘솔 창을 만들지 않는다. */
export function spawnDetached(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: StdioOptions }): ChildProcess {
  return spawn(file, [...args], { cwd: options.cwd, env: options.env, stdio: options.stdio, detached: true, windowsHide: true });
}

/**
 * 강제 종료 결과 — ★직계가 끝났는지와 트리가 정리됐는지는 다른 사실이다. 직계를 직접 죽이는 대체는 {@code directExited} 만 바꾸고
 * {@code tree} 를 «ok» 로 바꾸지 않는다. Unix 는 지금처럼 신호 하나(트리를 죽이지 않는다 — not-attempted).
 */
export interface KillResult {
  directExited: boolean;
  tree: "ok" | "failed" | "unfinished" | "not-attempted";
  detail?: string;
}

/**
 * 강제로 끈다. Windows: `taskkill /PID <pid> /T /F` 의 끝 코드·stderr 를 모은다(0 = ok · 그 밖·못 띄움 = failed · 기한 넘김 = unfinished)
 * → 직계 exit 를 기다린다 → 안 끝났으면 직계 kill 한 번. 기다림은 모두 {@code waitMs} 로 묶인다 — 호출처가 끝없이 기다리지 않는다.
 */
export async function killTree(
  child: ChildProcess,
  waitMs: number,
  signal: NodeJS.Signals = "SIGTERM",
  platform: NodeJS.Platform = process.platform,
): Promise<KillResult> {
  if (exited(child)) {
    return { directExited: true, tree: "not-attempted" };
  }
  if (platform !== "win32" || child.pid === undefined) {
    child.kill(signal);
    return { directExited: await waitExit(child, waitMs), tree: "not-attempted" };
  }
  const tree = await taskkill(child.pid, waitMs);
  let directExited = await waitExit(child, waitMs);
  if (!directExited) {
    child.kill();
    directExited = await waitExit(child, waitMs);
  }
  return { directExited, ...tree };
}

function taskkill(pid: number, waitMs: number): Promise<Pick<KillResult, "tree" | "detail">> {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    const done = (result: Pick<KillResult, "tree" | "detail">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let killer: ChildProcessByStdio<null, Readable, Readable>;
    try {
      killer = spawnCapture(["taskkill", "/PID", String(pid), "/T", "/F"], { cwd: process.cwd(), env: process.env });
    } catch (error) {
      done({ tree: "failed", detail: `taskkill did not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    timer = setTimeout(() => done({ tree: "unfinished", detail: `taskkill did not finish within ${waitMs} ms` }), waitMs);
    killer.stdout.resume();
    killer.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    killer.on("error", (error) => done({ tree: "failed", detail: `taskkill did not start: ${error.message}` }));
    killer.on("close", (code) => done(code === 0 ? { tree: "ok" } : { tree: "failed", detail: `taskkill exit ${code ?? "-"}: ${stderr.trim().slice(-300)}` }));
  });
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

/** 멈춘·응답 없는 프로세스를 사람이 끄는 안내 — 플랫폼 명령 문구는 여기 한 곳. */
export function stuckProcessHint(pid: number, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? `If it hangs: taskkill /PID ${pid} /F.`
    : `If it is stopped: kill -CONT ${pid}. If it hangs: kill ${pid}.`;
}

/** 사용자 로그인 셸 — 환경의 SHELL, 없으면 계정의 셸(macOS·Linux). */
export function loginShell(env: Env): string {
  return env.SHELL || userInfo().shell || "/bin/sh";
}
