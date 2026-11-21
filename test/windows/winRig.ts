import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { termPaths, type TermPaths } from "../../src/core/term/paths";

/**
 * Windows 실물 시험 틀 — 진짜 CLI(tsx 로 소스)·진짜 데몬·진짜 named pipe·진짜 ConPTY. Windows CI(windows.yml)에서만 돈다.
 * Windows 의 홈은 HOME 이 아니라 USERPROFILE 이다(os.homedir) — 둘 다 시험 폴더로 바꾼다.
 */
export const WINDOWS = process.platform === "win32";
export const ROOT = resolve(__dirname, "..", "..");
const ENTRY = join(ROOT, "src/bin/ainecto.ts");
export const LONG = 90_000;

export interface WinRig {
  home: string;
  env: NodeJS.ProcessEnv;
  paths: TermPaths;
  shell: string;
}

export let rig: WinRig;

export function useWinRig(): void {
  beforeEach(async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "awin-")));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.AINECTO_TERM_SESSION;
    const shell = process.env.ComSpec;
    if (!shell) throw new Error("ComSpec is not set on this Windows runner");
    rig = { home, env, paths: termPaths(home), shell };
  });
  afterEach(async () => {
    await cli("term", "kill-server");
    const pid = await daemonPid();
    if (pid !== undefined && alive(pid)) process.kill(pid);
    await rm(rig.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });
}

const TSX = WINDOWS
  ? execFileSync(process.execPath, ["--input-type=module", "-e", "console.log(import.meta.resolve('tsx'))"], { cwd: ROOT, encoding: "utf8" }).trim()
  : "";

export interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

export function cli(...args: string[]): Promise<Run> {
  return new Promise((done) => {
    execFile(process.execPath, ["--import", TSX, ENTRY, ...args], { env: rig.env, cwd: rig.home, windowsHide: true }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : 0;
      done({ code, stdout, stderr });
    });
  });
}

export async function ok(...args: string[]): Promise<string> {
  const run = await cli(...args);
  expect(run.code, `ainecto ${args.join(" ")}: ${run.stderr}`).toBe(0);
  return run.stdout;
}

export async function daemonPid(): Promise<number | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(rig.paths.daemonInfo, "utf8"));
    return value && typeof value === "object" && "pid" in value && typeof value.pid === "number" ? value.pid : undefined;
  } catch {
    return undefined;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** pid 아래 모든 자손(Win32_Process 의 부모 관계) — 끈 뒤 «남은 프로세스 0» 판정용. 시험 전용. */
export function descendants(root: number): number[] {
  const json = execFileSync("powershell", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"], { encoding: "utf8", windowsHide: true });
  const rows = JSON.parse(json) as { ProcessId: number; ParentProcessId: number }[];
  const found: number[] = [];
  const queue = [root];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    for (const row of rows) {
      if (row.ParentProcessId === pid && row.ProcessId !== root && !found.includes(row.ProcessId)) {
        found.push(row.ProcessId);
        queue.push(row.ProcessId);
      }
    }
  }
  return found;
}

export async function until(check: () => boolean | Promise<boolean>, what: string, ms: number = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

export async function daemonLog(): Promise<Record<string, unknown>[]> {
  const text = await readFile(rig.paths.log, "utf8").catch(() => "");
  return text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}
