import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { killTree, spawnPiped, type KillResult } from "../os/launch";
import { AGENT_STOP_WAIT_MS } from "./limits";

/** Agent 프로그램 띄우기 — 시험은 가짜 프로세스로 바꾼다. 실행 파일 이름(claude·codex)은 어댑터가 준다. */
export interface AgentSpawn {
  (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams;
}

export const spawnAgent: AgentSpawn = (command, args, options) => spawnPiped([command, ...args], options);

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
 * 멈추기: stdin 닫기 → B6 → SIGTERM → B6 → SIGKILL(launch.ts killTree — Windows 는 taskkill /T /F). 강제로 끈 결과는 hooks.killed 로.
 */
export class AgentChild {
  private readonly child: ChildProcessWithoutNullStreams;
  private stderr = "";
  private exitInfo: ChildExit | undefined;
  private readonly exited: Promise<void>;
  private readonly outputDone: Promise<void>;
  private readonly onKilled: ((result: KillResult) => void) | undefined;

  constructor(
    spawnImpl: AgentSpawn,
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
    hooks: { line(line: string): void; exit(exit: ChildExit): void; killed?(result: KillResult): void },
  ) {
    this.onKilled = hooks.killed;
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
        this.stderr = `${this.stderr}\n${error.message}`.slice(-STDERR_KEEP);
        // ★띄우지 못한 것(pid 없음)만 끝이다. 떠 있는 프로세스의 kill 오류(EPERM 등)는 사유만 남기고,
        // 실제 exit 이 올 때까지 살아 있는 것으로 둔다 — 끝난 줄 알고 놓으면 다음 차례가 앞 프로세스 위에 뜬다.
        if (this.child.pid === undefined) done(null, null);
      });
    });
    this.child.stdin.on("error", () => {
      // 프로세스가 먼저 끝나 stdin 이 깨졌다 — exit 이 이유를 남긴다.
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", hooks.line);
    this.outputDone = new Promise((resolve) => lines.once("close", () => resolve()));
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

  /** stdin 만 닫는다(입력 끝 알림) — 프로세스는 그대로 돈다. 한 차례에 프로세스 하나인 Agent(agy -p)가 쓴다. */
  endInput(): void {
    if (this.alive) this.child.stdin.end();
  }

  /** 기다리지 않고 바로 끈다(SIGTERM → B6 → SIGKILL · Windows 는 taskkill /T /F). 결과는 hooks.killed 에도. */
  async forceStop(): Promise<KillResult | undefined> {
    if (!this.alive) return undefined;
    const first = await killTree(this.child, AGENT_STOP_WAIT_MS, "SIGTERM");
    const result = first.directExited ? first : await killTree(this.child, AGENT_STOP_WAIT_MS, "SIGKILL");
    this.onKilled?.(result);
    return result;
  }

  /** stdin 을 닫아 스스로 끝나게 하고, 안 끝나면 강제로. 강제로 껐으면 그 결과(직계·트리)를 돌려주고 hooks.killed 에도 알린다. */
  async stop(): Promise<KillResult | undefined> {
    if (!this.alive) return undefined;
    this.child.stdin.end();
    if (await this.waitForExit(AGENT_STOP_WAIT_MS)) return undefined;
    return await this.forceStop();
  }

  /** {@code ms} 안에 프로세스가 끝나면 true. */
  async waitForExit(ms: number): Promise<boolean> {
    return await withDeadline(this.exited.then(() => true), ms, false);
  }

  /** stdout 이 다 읽혔으면(마지막 줄까지 hooks.line 으로 나갔으면) true — exit 이 마지막 줄보다 먼저 올 수 있다. */
  async waitForOutput(ms: number): Promise<boolean> {
    return await withDeadline(this.outputDone.then(() => true), ms, false);
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
  /** 기한을 넘겨 강제로 끈 결과(launch.ts killTree) — 직계가 끝났는지와 트리 정리는 따로 본다. */
  kill?: KillResult;
}

/**
 * 짧은 명령 하나(`--version`·`auth status`)를 끝까지 — 기한을 넘기면 강제로 끄고 timedOut.
 * ★끈 뒤 stdout·stderr 가 닫히는 close 도 {@link AGENT_STOP_WAIT_MS} 까지만 기다린다 — 남은 손자가 pipe 를 쥐면 close 가 오지 않는다.
 */
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
    let killing: Promise<KillResult> | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnImpl(command, args, { cwd: options.cwd, env: options.env });
    } catch (error) {
      resolve({ spawnError: error instanceof Error ? error.message : String(error), timedOut, code: null, stdout, stderrTail: "" });
      return;
    }
    const finish = (code: number | null, kill: KillResult | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeTimer);
      resolve({ spawnError, timedOut, code, stdout, stderrTail: stderr.trim().slice(-STDERR_TAIL), ...(kill ? { kill } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killing = killTree(child, AGENT_STOP_WAIT_MS, "SIGKILL");
      void killing.then((kill) => {
        closeTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null, kill);
        }, AGENT_STOP_WAIT_MS);
      });
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
      if (killing) {
        void killing.then((kill) => finish(code, kill));
      } else {
        finish(code, undefined);
      }
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
