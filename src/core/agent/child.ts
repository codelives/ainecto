import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { AGENT_STOP_WAIT_MS } from "./limits";

/** Agent 프로그램 띄우기 — 시험은 가짜 프로세스로 바꾼다. 실행 파일 이름(claude·codex)은 어댑터가 준다. */
export interface AgentSpawn {
  (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams;
}

export const spawnAgent: AgentSpawn = (command, args, options) =>
  spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });

export interface ChildExit {
  code: number | null;
  signal: string | null;
  stderrTail: string;
}

/** stderr 를 붙잡아 두는 길이 — 실패 답·로그에 싣는 꼬리. */
const STDERR_KEEP = 2_000;
const STDERR_TAIL = 500;

/**
 * ★Agent 프로세스 하나의 수명 — 두 어댑터가 같이 쓴다. stdout 은 한 줄씩, stderr 는 꼬리만 붙잡는다.
 * 멈추기: stdin 닫기 → B6 → SIGTERM → B6 → SIGKILL.
 */
export class AgentChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private exitInfo: ChildExit | undefined;
  private readonly exited: Promise<void>;

  constructor(
    spawnImpl: AgentSpawn,
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    hooks: { line(line: string): void; exit(exit: ChildExit): void },
  ) {
    this.child = spawnImpl(command, args, options);
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    this.exited = new Promise((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exitInfo) return;
        this.exitInfo = { code, signal, stderrTail: this.stderrTail() };
        hooks.exit(this.exitInfo);
        resolve();
      };
      this.child.on("exit", done);
      this.child.on("error", (error) => {
        this.stderr += `\n${error.message}`;
        done(null, null);
      });
    });
    this.child.stdin.on("error", () => {
      // 프로세스가 먼저 끝나 stdin 이 깨졌다 — exit 이 이유를 남긴다.
    });
    createInterface({ input: this.child.stdout }).on("line", hooks.line);
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  get alive(): boolean {
    return this.exitInfo === undefined;
  }

  /** 끝났으면 그 사정, 아니면 undefined. */
  get exit(): ChildExit | undefined {
    return this.exitInfo;
  }

  stderrTail(): string {
    return this.stderr.trim().slice(-STDERR_TAIL);
  }

  /** 한 줄 쓰기 — 이미 끝난 프로세스면 쓰지 않고 false. */
  writeLine(message: unknown): boolean {
    if (!this.alive) return false;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  async stop(): Promise<void> {
    if (!this.alive) return;
    this.child.stdin.end();
    if (await this.waitExit(AGENT_STOP_WAIT_MS)) return;
    this.child.kill("SIGTERM");
    if (await this.waitExit(AGENT_STOP_WAIT_MS)) return;
    this.child.kill("SIGKILL");
    await this.waitExit(AGENT_STOP_WAIT_MS);
  }

  private async waitExit(ms: number): Promise<boolean> {
    return await withDeadline(this.exited.then(() => true), ms, false);
  }
}

/** {@code work} 가 {@code ms} 안에 끝나지 않으면 {@code fallback}. 타이머는 반드시 치운다. */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RunResult {
  /** 띄우지도 못했으면(ENOENT 등) 그 이유. */
  spawnError?: string;
  timedOut: boolean;
  code: number | null;
  stdout: string;
  stderrTail: string;
}

/** 짧은 명령 하나(`--version`·`auth status`)를 끝까지 — 기한을 넘기면 죽이고 timedOut. */
export async function runToEnd(
  spawnImpl: AgentSpawn,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<RunResult> {
  return await new Promise<RunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError: string | undefined;
    let timedOut = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(command, args, { cwd: options.cwd, env: options.env });
    } catch (error) {
      resolve({ spawnError: error instanceof Error ? error.message : String(error), timedOut, code: null, stdout, stderrTail: "" });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error.code ?? error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ spawnError, timedOut, code, stdout, stderrTail: stderr.trim().slice(-STDERR_TAIL) });
    });
  });
}

/** 설치 감지 — `<command> --version` 이 0 으로 끝나면 설치됨, 첫 줄이 판. */
export async function detectByVersion(
  spawnImpl: AgentSpawn,
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ installed: boolean; version?: string; detail?: string }> {
  const run = await runToEnd(spawnImpl, command, ["--version"], options);
  if (run.spawnError || run.timedOut || run.code !== 0) {
    return { installed: false, detail: run.spawnError ?? (run.timedOut ? "timed out" : `exit ${run.code}`) };
  }
  return { installed: true, version: run.stdout.trim().split("\n")[0]?.trim() };
}
