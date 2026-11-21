import { AGENT_STOP_WAIT_MS } from "../agent/limits";
import { killTree, spawnCapture, type KillResult } from "../os/launch";

/**
 * 외부 명령({@code claude}·{@code codex}) 실행의 ★단일 지점. setup·status·doctor 가 모두 이것만 부른다 —
 * 시험은 가짜 실행기(또는 PATH 앞의 기록 스크립트)를 넣는다.
 *
 * <p>셸을 거치지 않는다(인자 그대로 — Windows .cmd 는 launch.ts 가 cmd.exe 이스케이프). 실행 파일이 없으면 {@code missing} 이고 예외가 아니다 —
 * «설치 안 됨»은 실패가 아니라 보고할 상태다.
 */
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 실행 파일을 찾지 못했다(ENOENT). */
  missing: boolean;
  /** 시간 초과로 끈 결과(launch.ts killTree) — 직계가 끝났는지와 트리 정리는 따로 본다. */
  kill?: KillResult;
}

export interface RunOptions {
  /** 자식의 출력을 «받는 대로» 사용자에게도 보인다 — 실행 중에 사람이 봐야 하는 것(로그인 링크)이 있을 때만. */
  show?: (text: string) => void;
}

export type CommandRunner = (command: string, args: readonly string[], options?: RunOptions) => Promise<CommandResult>;

/**
 * 실행한 명령 한 줄 — ★요청과 응답이 한 항목이다(명령 줄 + 종료 코드). 결과의 {@code commands} 로 나간다.
 * 응답이 없는 요청은 구조적으로 없다: 실행기가 끝나야 항목이 생긴다.
 */
export interface CommandLog {
  command: string;
  exitCode: number | null;
  missing?: true;
  /** 실패했을 때 stderr(없으면 stdout)의 마지막 줄 — 원인을 그 자리에서 보이게. */
  error?: string;
}

/**
 * {@code claude mcp get} 은 서버 연결 점검까지 한다(브리지를 띄운다) — 그래서 짧지 않다.
 * 이 한도를 넘기면 그 클라이언트만 실패로 보고하고 나머지는 계속한다.
 */
const COMMAND_TIMEOUT_MS = 90_000;

export function systemCommandRunner(options: { cwd: string; env?: NodeJS.ProcessEnv }): CommandRunner {
  return (command, args, run) => new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: CommandResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      }
    };
    let child: ReturnType<typeof spawnCapture>;
    try {
      child = spawnCapture([command, ...args], { cwd: options.cwd, env: options.env ?? process.env });
    } catch (error) {
      // 띄우기 전에 끊겼다(launch.ts — cmd 줄 한도 등). «설치 안 됨»이 아니라 실패로 보고한다.
      finish({ exitCode: null, stdout, stderr: error instanceof Error ? error.message : String(error), missing: false });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      void killTree(child, AGENT_STOP_WAIT_MS).then((kill) => {
        finish({ exitCode: null, stdout, stderr: `${stderr}\n${command} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`, missing: false, kill });
      });
    }, COMMAND_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); run?.show?.(String(chunk)); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); run?.show?.(String(chunk)); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ exitCode: null, stdout, stderr: error.message, missing: error.code === "ENOENT" });
    });
    child.on("close", (code) => {
      // 시간 초과로 끄는 중이면 끈 결과와 함께 위에서 끝낸다.
      if (!timedOut) finish({ exitCode: code, stdout, stderr, missing: false });
    });
  });
}

/** 실행기를 감싸 실행한 명령을 {@link CommandLog} 로 모은다. */
export function recordingRunner(runner: CommandRunner, log: CommandLog[]): CommandRunner {
  return async (command, args, run) => {
    const result = await runner(command, args, run);
    const entry: CommandLog = { command: [command, ...args].join(" "), exitCode: result.exitCode };
    if (result.missing) {
      entry.missing = true;
    } else if (result.exitCode !== 0) {
      entry.error = lastLine(result.stderr) ?? lastLine(result.stdout);
    }
    log.push(entry);
    return result;
  };
}

/** 출력의 마지막 비어 있지 않은 줄 — 실패 원인을 한 줄로 보일 때 쓴다. */
export function lastLine(text: string): string | undefined {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1];
}
