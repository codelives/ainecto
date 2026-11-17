import { AGENT_CALL_TIMEOUT_MS, AGENT_STOP_WAIT_MS } from "../agent/limits";
import type { ListedSession } from "../term/protocol";
import { CALL_TIMEOUT_MS } from "../term/remoteLimits";
import { bridgePackageSpec, CLI_VERSION, PACKAGE_NAME } from "../version";

/**
 * «이 PC 연결» — 기존 term 데몬의 세션 하나({@link PC_SESSION_NAME})가 내부 명령 `ainecto pc run` 을 돈다(KAN-738, root REQ d37a6dc2).
 * 새 데몬 0. 여기는 순수 함수: 세션 명령 만들기 · 도는 것 찾기(★이름이 아니라 명령으로) · 시작/이미/갈아끼우기 판정 · 끄기 기다림.
 */
export const PC_SESSION_NAME = "ainecto-pc";

/** 받은 전역 플래그 — pc 세션에 그대로 넘긴다. */
export interface LaunchFlags {
  env?: string;
  endpoint?: string;
}

export function pcRunArgs(flags: LaunchFlags): string[] {
  return [
    "pc", "run",
    ...(flags.env ? ["--env", flags.env] : []),
    ...(flags.endpoint ? ["--endpoint", flags.endpoint] : []),
  ];
}

/**
 * 세션이 돌릴 명령 — ★이 CLI 판으로 고정한 npx({@link bridgePackageSpec}). 지금 프로세스의 경로(npx 캐시 폴더일 수 있다)에
 * 기대지 않는다. 주 이름의 기본 실행 파일은 MCP 브리지(`mcp`)라서 `--package … ainecto` 로 CLI 실행 파일을 고른다.
 */
export function npxCliCommand(args: readonly string[], version: string = CLI_VERSION): string[] {
  return ["npx", "-y", "--package", bridgePackageSpec(version), "ainecto", ...args];
}

export interface RunningPc {
  session: string;
  cwd: string;
  /** 세션 명령의 `--package` 값(판 고정이면 `@ainecto/mcp@<판>`). 없으면 undefined. */
  packageSpec?: string;
}

function isPcCommand(command: readonly string[] | null | undefined): command is readonly string[] {
  return Array.isArray(command) && command.some((word, index) => word === "pc" && command[index + 1] === "run");
}

function packageSpecOf(command: readonly string[]): string | undefined {
  const index = command.indexOf("--package");
  const spec = index >= 0 ? command[index + 1] : undefined;
  return spec !== undefined && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`)) ? spec : undefined;
}

/** term ls → `pc run` 을 도는 세션들(보통 하나). */
export function runningPcs(sessions: ReadonlyArray<Pick<ListedSession, "name" | "cwd" | "command">>): RunningPc[] {
  return sessions.flatMap((session) => {
    if (!isPcCommand(session.command)) {
      return [];
    }
    const packageSpec = packageSpecOf(session.command);
    return [{ session: session.name, cwd: session.cwd, ...(packageSpec ? { packageSpec } : {}) }];
  });
}

/** 판 표시 — `@ainecto/mcp@0.14.0` → `0.14.0`, 고정 안 됨 → «unpinned». */
export function pcVersionLabel(pc: RunningPc): string {
  return pc.packageSpec?.startsWith(`${PACKAGE_NAME}@`) ? pc.packageSpec.slice(PACKAGE_NAME.length + 1) : "unpinned";
}

export type PcAction =
  | { kind: "start" }
  | { kind: "already"; pc: RunningPc }
  | { kind: "replace"; pcs: RunningPc[] };

/**
 * 시작 판정 — 없으면 start · 이 판과 같은 판 하나면 already · 그 밖(옛 판·여러 개)은 replace(끄고 이 판으로 다시).
 * term 데몬 자체는 판이 달라도 그대로 둔다(내리면 사용자 세션이 죽는다) — 여기서 보지 않는다.
 */
export function pcAction(running: readonly RunningPc[], cliVersion: string): PcAction {
  const [only] = running;
  if (!only) {
    return { kind: "start" };
  }
  if (running.length === 1 && only.packageSpec === bridgePackageSpec(cliVersion)) {
    return { kind: "already", pc: only };
  }
  return { kind: "replace", pcs: [...running] };
}

/**
 * `ainecto stop` 이 Ctrl+C 뒤 pc 프로세스가 끝나기를 기다리는 시간 — ★새 값이 아니라 그 프로세스가 끝날 때 하는 일의 기존 기한 합:
 *   Agent 멈추기(Codex turn/interrupt 답 한 단계 + stdin 닫기 → SIGTERM → SIGKILL 세 단계, 단계마다 AGENT_STOP_WAIT_MS)
 *   + 서버 close 호출 하나(serve·원격 다리 기한 중 큰 것).
 * 넘으면 term kill 로 끝낸다. ⚠줄에 남은 할 일을 놓는 도구 호출(closeTodo)에는 기한이 없어 여기 넣지 못한다.
 */
export function pcStopDeadlineMs(): number {
  return AGENT_STOP_WAIT_MS * 4 + Math.max(AGENT_CALL_TIMEOUT_MS, CALL_TIMEOUT_MS);
}

/** 마지막으로 끊긴 사유 중 사람에게 풀어 줄 것(serve_stop reason → 한 줄). */
const STOP_NOTES: Readonly<Record<string, string>> = {
  replaced: "another PC took over your AiNecto agent — run `ainecto` here to take it back",
  auth: "AiNecto refused the sign-in — run `ainecto auth login`, then `ainecto`",
  signal: "stopped on this PC",
};

/** `ainecto status` 의 «이 PC 연결» 칸(순수 함수) — 연결·동의·원격 터미널 허용·이 PC 의 터미널 세션(연결 세션은 뺀다). */
export function pcStatusView(input: {
  sessions: ReadonlyArray<Pick<ListedSession, "name" | "cwd" | "command">>;
  /** 이 계정의 동의 — 로그인 전·계정을 못 읽었으면 undefined. */
  approval: { consentedAt: string; remoteTerminal: boolean } | undefined;
  agentLog: string;
  termProblem: string | undefined;
  /** agent.log 의 마지막 serve_stop — 연결이 없을 때 «왜 끊겼나». */
  lastStop?: { at: string; reason: string };
}): Record<string, unknown> {
  if (input.termProblem !== undefined) {
    return { connected: false, unsupported: input.termProblem };
  }
  const running = runningPcs(input.sessions);
  const pcNames = new Set(running.map((pc) => pc.session));
  return {
    connected: running.length > 0,
    ...(running[0] ? { session: running[0].session, folder: running[0].cwd, version: pcVersionLabel(running[0]), log: input.agentLog } : {}),
    ...(!running[0] && input.lastStop ? { lastStop: { ...input.lastStop, ...(STOP_NOTES[input.lastStop.reason] ? { note: STOP_NOTES[input.lastStop.reason] } : {}) } } : {}),
    approved: input.approval !== undefined,
    ...(input.approval ? { remoteTerminal: input.approval.remoteTerminal ? "allowed" : "blocked" } : {}),
    terminalSessions: input.sessions.filter((session) => !pcNames.has(session.name)).map((session) => session.name),
  };
}
