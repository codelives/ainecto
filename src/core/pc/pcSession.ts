import { AGENT_CALL_TIMEOUT_MS, AGENT_STOP_WAIT_MS } from "../agent/limits";
import { AGENT_MISSING_LINE, SERVE_CONNECTED_PREFIX, SERVE_RECONNECTED_LINE } from "../agent/serve";
import { NO_AGENTS_REASON, type LastUpgrade } from "../agent/log";
import { ERROR_LINE_PREFIX } from "../output/render";
import { newerVersion, talkLacking, type OuterCaps } from "../term/holderTalk";
import type { ListedSession, SessionKind } from "../term/protocol";
import { CALL_TIMEOUT_MS } from "../term/remoteLimits";
import { REMOTE_OFF_BY_WEB_LINE, REMOTE_STATE_PREFIX } from "../term/remote";
import { bridgePackageSpec, CLI_VERSION, PACKAGE_NAME } from "../version";
import { bridgeKind } from "./bridgeKind";

/**
 * «이 PC 연결» — 기존 term 데몬의 세션 하나(bridgeKind.PC_SESSION_NAME)가 내부 명령 `ainecto pc run` 을 돈다(KAN-738, root REQ d37a6dc2).
 * 새 데몬 0. 여기는 순수 함수: 세션 명령 만들기 · 도는 것 찾기(★종류로 — bridgeKind 한 곳) · 시작/이미/갈아끼우기 판정 · 끄기 기다림.
 */

/** 받은 전역 플래그 — pc 세션에 그대로 넘긴다. */
export interface LaunchFlags {
  env?: string;
  endpoint?: string;
  /** 자동 업그레이드가 실패·거절해 옛 판으로 되돌릴 때 — 그 목표를 이 프로세스에서 다시 시도하지 않는다(pc.json 칸이 아니라 인자로). */
  skipUpgrade?: string;
}

export function pcRunArgs(flags: LaunchFlags): string[] {
  return [
    "pc", "run",
    ...(flags.env ? ["--env", flags.env] : []),
    ...(flags.endpoint ? ["--endpoint", flags.endpoint] : []),
    ...(flags.skipUpgrade ? [SKIP_UPGRADE_FLAG, flags.skipUpgrade] : []),
  ];
}

/** pc run 인자 — 이 목표 판은 건너뛴다(자동 업그레이드 되돌림). */
export const SKIP_UPGRADE_FLAG = "--skip-upgrade";

/** pc run 의 나머지 인자 → 건너뛸 목표 판(순수 함수). */
export function skipUpgradeOf(argv: readonly string[]): string | undefined {
  const index = argv.indexOf(SKIP_UPGRADE_FLAG);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith("--") ? value : undefined;
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

function packageSpecOf(command: readonly string[]): string | undefined {
  const index = command.indexOf("--package");
  const spec = index >= 0 ? command[index + 1] : undefined;
  return spec !== undefined && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`)) ? spec : undefined;
}

/** term ls → PC 연결 세션들(보통 하나 — 종류는 bridgeKind 한 곳). */
export function runningPcs(sessions: ReadonlyArray<Pick<ListedSession, "name" | "cwd" | "command" | "kind">>): RunningPc[] {
  return sessions.flatMap((session) => {
    if (bridgeKind(session) !== "pc-bridge") {
      return [];
    }
    const packageSpec = packageSpecOf(session.command ?? []);
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
 * term 데몬의 판은 여기서 보지 않는다 — {@link daemonUpgrade} 가 먼저 정한다.
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

export type DaemonPlan =
  | { kind: "keep" }
  /** 새 구조 · 바깥이 이 CLI 보다 낮은 판 — 새 바깥을 띄워 넘겨받는다(세션은 닫히지 않는다 · 묻지 않는다). */
  | { kind: "handover" }
  /** 새 구조 · holder 말이 이 CLI 보다 모자라고 사용자 세션 0 — holder 를 갈아 끼운다(PC 연결 세션째 · 다음 시작이 새 판). */
  | { kind: "retire"; holder: string }
  /** 옛 구조(0.16.x 데몬) — 첫 전환. 세션이 있으면 한 번 묻는다(모두 닫힌다 — 종류로 가려내지 않는다). */
  | { kind: "switch"; sessions: Array<{ name: string; kind?: SessionKind }> };

/**
 * term 데몬 판정(세션 유지 구조 설계 3-4·3-6·5절) — 무엇이 떠 있는지는 살아 있는 바깥의 기능 묻기로 안다(G4 — 남은 파일로 짐작하지 않는다).
 *   새 구조: holder 말 모자람 + 사용자 세션(종류 user — 비면 user) 0 → retire · 그 밖에 바깥이 낮은 판 → handover · 아니면 keep.
 *            넘기기는 세션을 닫지 않아 터미널 세션 안에서도 한다. retire 는 터미널 세션 안에서는 하지 않는다.
 *   옛 구조: 터미널 세션 안 → keep(끄면 자기 셸이 죽는다) · 그 밖 → switch(모든 세션 이름 — PC 연결 세션 포함).
 * 순수 함수.
 */
export function daemonPlan(input: {
  /** 새 구조면 바깥의 기능 묻기 답 · 옛 구조(기능 묻기에 답하지 않음)면 "old". */
  structure: OuterCaps | "old";
  cliVersion: string;
  sessions: ReadonlyArray<Pick<ListedSession, "name" | "kind">>;
  insideTermSession: boolean;
  /** 이 CLI 의 holder 말(시험이 바꿔 끼운다). */
  cliTalk?: Readonly<Record<string, readonly string[]>>;
}): DaemonPlan {
  const { structure, sessions, insideTermSession } = input;
  if (structure === "old") {
    return insideTermSession ? { kind: "keep" } : { kind: "switch", sessions: sessions.map(({ name, kind }) => ({ name, ...(kind ? { kind } : {}) })) };
  }
  const users = sessions.filter((session) => (session.kind ?? "user") === "user");
  if (!insideTermSession && users.length === 0 && talkLacking(structure.talk, input.cliTalk)) {
    return { kind: "retire", holder: structure.holder };
  }
  return newerVersion(input.cliVersion, structure.version) ? { kind: "handover" } : { kind: "keep" };
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
  [NO_AGENTS_REASON]: AGENT_MISSING_LINE,
};

/** `ainecto status` 의 «이 PC 연결» 칸(순수 함수) — 연결·동의·원격 터미널 허용·이 PC 의 터미널 세션(연결 세션은 뺀다). */
export function pcStatusView(input: {
  sessions: ReadonlyArray<Pick<ListedSession, "name" | "cwd" | "command" | "kind">>;
  /** 이 계정의 동의 — 로그인 전·계정을 못 읽었으면 undefined. */
  approval: { consentedAt: string; remoteTerminal: boolean } | undefined;
  agentLog: string;
  termProblem: string | undefined;
  /** agent.log 의 마지막 serve_stop — 연결이 없을 때 «왜 끊겼나». */
  lastStop?: { at: string; reason: string };
  /** 지금 도는 pc 에 Agent 가 없다(다리만) — agent.log 의 마지막 serve 기록. */
  agentMissing?: boolean;
  /** agent.log 의 마지막 자동 업그레이드(끝·실패·거절) — 연결 여부와 상관없이 보인다. */
  lastUpgrade?: LastUpgrade;
}): Record<string, unknown> {
  if (input.termProblem !== undefined) {
    return { connected: false, unsupported: input.termProblem };
  }
  const running = runningPcs(input.sessions);
  const pcNames = new Set(running.map((pc) => pc.session));
  return {
    connected: running.length > 0,
    ...(running[0] ? { session: running[0].session, folder: running[0].cwd, version: pcVersionLabel(running[0]), log: input.agentLog } : {}),
    ...(running[0] && input.agentMissing ? { agent: AGENT_MISSING_LINE } : {}),
    ...(!running[0] && input.lastStop ? { lastStop: { ...input.lastStop, ...(STOP_NOTES[input.lastStop.reason] ? { note: STOP_NOTES[input.lastStop.reason] } : {}) } } : {}),
    ...(input.lastUpgrade ? { lastUpgrade: input.lastUpgrade } : {}),
    approved: input.approval !== undefined,
    ...(input.approval ? { remoteTerminal: input.approval.remoteTerminal ? "allowed" : "blocked" } : {}),
    terminalSessions: input.sessions.filter((session) => !pcNames.has(session.name)).map((session) => session.name),
  };
}

/**
 * `ainecto start` 가 «연결됨»을 기다리는 시간 — ★새 값이 아니라 pc 프로세스가 연결 전에 하는 일의 기존 기한 합:
 *   Agent 준비 확인(claude·codex, AGENT_CALL_TIMEOUT_MS) + open 호출(같은 기한) + 401 뒤 로그인 갱신하고 한 번 더(같은 기한).
 * 넘어도 실패로 보지 않는다 — 문구만 «아직 연결 중»으로 바꾼다(틀린 말을 찍지 않으려는 기다림).
 */
export function pcReadyDeadlineMs(): number {
  return AGENT_CALL_TIMEOUT_MS * 3;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** pc 세션 화면에서 «연결됨»(또는 다시 붙음)·«실패로 끝남» 줄을 찾는 식. */
export const PC_OUTCOME_PATTERN = new RegExp(
  `^(${escapeRegExp(SERVE_CONNECTED_PREFIX)}|${escapeRegExp(SERVE_RECONNECTED_LINE)}|${escapeRegExp(REMOTE_STATE_PREFIX)}|${escapeRegExp(ERROR_LINE_PREFIX)})`,
);

/** pc 화면의 마지막 원격 상태 줄이 «웹에서 꺼짐»인가(순수 함수) — 그러면 start 가 «Already» 대신 다시 띄워 원격을 켠다. */
export function remoteOffByWeb(lines: readonly string[]): boolean {
  const last = [...lines].reverse().find((line) => line.startsWith(REMOTE_STATE_PREFIX));
  return last !== undefined && last.startsWith(REMOTE_OFF_BY_WEB_LINE);
}

/** 화면 줄 → 결과(순수 함수). 연결 줄이 있으면 connected, 오류 줄만 있으면 failed(그 줄), 둘 다 없으면 undefined. */
export function pcOutcome(lines: readonly string[]): { kind: "connected"; agentMissing?: true } | { kind: "failed"; line: string } | undefined {
  let failed: string | undefined;
  // Agent 없이 다리만 — 다리의 원격 상태 줄(열린 뒤에만 찍힌다)도 «연결됨»이다. Agent 없음 줄이 있으면 그것까지 알린다.
  const agentMissing = lines.some((line) => line.startsWith(AGENT_MISSING_LINE));
  for (const line of lines) {
    if (line.startsWith(SERVE_CONNECTED_PREFIX) || line.startsWith(SERVE_RECONNECTED_LINE) || line.startsWith(REMOTE_STATE_PREFIX)) {
      return agentMissing ? { kind: "connected", agentMissing: true } : { kind: "connected" };
    }
    if (line.startsWith(ERROR_LINE_PREFIX)) {
      failed ??= line;
    }
  }
  return failed === undefined ? undefined : { kind: "failed", line: failed };
}
