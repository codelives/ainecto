import { renderSuccess } from "../../core/output/render";
import {
  accountKey,
  loadPcSettings,
  savePcSettings,
  withConsent,
  withoutEndpoint,
  withRemoteTerminal,
} from "../../core/pc/pcSettings";
import {
  PC_OUTCOME_PATTERN,
  PC_SESSION_NAME,
  pcAction,
  remoteOffByWeb,
  pcOutcome,
  pcRunArgs,
  pcVersionLabel,
  runningPcs,
  type LaunchFlags,
  type RunningPc,
} from "../../core/pc/pcSession";
import type { AccountSummary } from "../../core/setup/accountSummary";
import { lastLine, type CommandRunner } from "../../core/setup/commandRunner";
import { doctorChecks } from "../../core/setup/doctorChecks";
import type { MachineStatus } from "../../core/setup/machineStatus";
import { openTermClient, termRequest, type TermConnectOptions } from "../../core/term/client";
import { TermError } from "../../core/term/errors";
import type { TermPaths } from "../../core/term/paths";
import { listedSessions, readLines, type ListedSession } from "../../core/term/protocol";
import { waitForMatch } from "../../core/term/wait";
import { isNodeError } from "../../core/fs/privateFiles";
import { updatePcKeys, withoutEndpointKeys, type PcGroup } from "../../core/pc/pcKeys";
import { processGroupAlive, processGroupOf } from "../../core/os/processes";
import { readFile } from "node:fs/promises";
import type { CliIO } from "./ainectoCli";
import { promptLine } from "./destructiveConfirmation";
import { CliCommandError } from "./errors";
import { pcResultText, preflightNotes } from "./pcStartText";

/**
 * «이 PC 연결» 입구 — `ainecto`(인자 없음·터미널)·`start`·`stop [--forget]`·`remote on|off`(KAN-738, root REQ d37a6dc2·b1f76f76).
 * 이 PC 연결 = 기존 term 데몬의 세션 하나가 `ainecto pc run` 을 돈다. 판단은 core/pc 의 순수 함수, 여기는 입출력·데몬 요청만.
 */
export interface PcDeps {
  io: CliIO;
  json: boolean;
  /** 사람이 보는 터미널인가 — 아니면 묻지 않는다(동의가 없으면 띄우지 않는다). */
  interactive: boolean;
  paths: TermPaths;
  settingsPath: string;
  /** `~/.ainecto/pc-keys.json` — stop --forget 이 이 서버의 키도 지운다. */
  keysPath: string;
  hostName: string;
  endpoint: string;
  /** pc 세션의 폴더 — serve 가 이 폴더의 .ainecto/agent.local 에서 Agent 이름을 읽는다. */
  cwd: string;
  /** 세션이 받을 환경 — `term new` 와 같다. */
  sessionEnv: Record<string, string>;
  flags: LaunchFlags;
  cliVersion: string;
  /** ★pc 세션 명령을 만드는 곳 — 운영은 npxCliCommand, 시험은 대역. */
  managedCommand: (args: string[]) => string[];
  /** 명령의 첫 실행(판 확인) — npx 캐시를 채우고 실패를 그 자리에서 보인다. */
  runner: CommandRunner;
  /** term 을 못 쓰는 기기면 그 이유. */
  termProblem: string | undefined;
  agentLog: string;
  stopDeadlineMs: number;
  /** start 가 «연결됨»을 기다리는 시간(pcReadyDeadlineMs). */
  readyDeadlineMs: number;
  /** status·doctor 와 같은 수집. */
  machine: () => Promise<MachineStatus>;
  /** 로그인한 계정(identity_get_self). */
  account: () => Promise<AccountSummary>;
  /** `ainecto setup` 그대로. */
  setup: () => Promise<number>;
}

/** `ainecto` · `ainecto start` — 점검 → (처음이면) 동의 → pc 세션 시작/이미/갈아끼우기. */
export async function executePcStart(deps: PcDeps): Promise<number> {
  assertTerm(deps);
  const note = (line: string): void => {
    deps.io.stderr.write(`${line}\n`);
  };
  note("Checking sign-in and connections…");
  let status = await deps.machine();
  // ★알릴 것은 결과 «뒤»에 — 결과(연결됐다·무엇에 쓰나·끄는 법)를 먼저 보인다(pcStartText).
  let later = preflightNotes(doctorChecks(status));
  const signedIn = status.token.state === "env" || status.token.state === "signed-in";
  if (!signedIn) {
    if (!deps.interactive) {
      throw new CliCommandError("PC_NOT_SIGNED_IN", "Not signed in to AiNecto — run `ainecto setup` in a terminal first.");
    }
    if (!yes(await promptLine(deps.io, "Sign in and connect your coding agents now (ainecto setup)? [Y/n]: "), true)) {
      note("Run `ainecto setup` when you are ready, then `ainecto` again.");
      return 0;
    }
    const code = await deps.setup();
    if (code !== 0) {
      return code;
    }
    status = await deps.machine();
    later = preflightNotes(doctorChecks(status));
  }
  const userId = status.account?.userId;
  if (!userId) {
    throw new CliCommandError("PC_ACCOUNT_UNKNOWN", `Could not read your AiNecto account${status.account?.problem ? ` (${status.account.problem.message})` : ""}. `
      + "Run `ainecto doctor` to see why.");
  }
  const key = accountKey(deps.endpoint, userId);
  let settings = await loadPcSettings(deps.settingsPath, deps.hostName);
  if (!settings.accounts[key]) {
    if (!deps.interactive) {
      throw new CliCommandError("PC_NOT_APPROVED", "This PC is not connected yet — run `ainecto` in a terminal once to approve.");
    }
    note("");
    note(`This connects this PC to AiNecto as ${status.account?.displayName ?? "your account"} (${deps.endpoint}).`);
    note("  · Your AiNecto agent will run work on this PC (Claude Code / Codex).");
    note("  · From AiNecto on the web, you can open terminals on this PC and run commands in them.");
    note("  · It keeps itself up to date — new AiNecto releases built and signed on AiNecto's GitHub are installed when this PC is idle.");
    if (!yes(await promptLine(deps.io, "Connect this PC? [y/N]: "), false)) {
      note("Not connected. Nothing was started.");
      return 0;
    }
    const remote = yes(await promptLine(deps.io, "Also allow terminals from the web? [y/N]: "), false);
    settings = withConsent(settings, key, remote, new Date());
    await savePcSettings(deps.settingsPath, settings);
  }

  const action = pcAction(runningPcs(await listed(deps)), deps.cliVersion);
  if (action.kind === "already") {
    // ★웹 «원격 터미널 끊기» 뒤 원격은 그 pc 프로세스가 사는 동안 꺼진 채다 — 같은 판이어도 다시 띄워야 원격이 켜진다(R3).
    if (!remoteOffByWeb(await screenLines(deps, action.pc.session))) {
      return withNotes(deps, later, print(deps, { connected: true, already: true, ...pcView(deps, action.pc) },
        pcResultText({ kind: "already", folder: action.pc.cwd, version: pcVersionLabel(action.pc), log: deps.agentLog })));
    }
    note("The remote terminal was turned off from the web — reconnecting this PC to turn it back on…");
    await stopPc(deps, action.pc);
    return withNotes(deps, later, await launchPc(deps));
  }
  await prepare(deps);
  if (action.kind === "replace") {
    for (const pc of action.pcs) {
      note(`Replacing the PC connection ${pcVersionLabel(pc)} (session ${pc.session}) with ${deps.cliVersion}…`);
      await stopPc(deps, pc);
    }
  }
  return withNotes(deps, later, await launchPc(deps));
}

/** 결과를 찍은 «뒤» 알릴 것(stderr) — 종료 코드는 그대로. */
function withNotes(deps: PcDeps, notes: readonly string[], code: number): number {
  for (const line of notes) deps.io.stderr.write(`${line}\n`);
  return code;
}

/** pc 세션을 띄우고 «연결됨»을 기다린다 — start·갈아끼우기·원격 설정 반영이 같은 길. */
async function launchPc(deps: PcDeps): Promise<number> {
  return reportOutcome(deps, await startPcSession(deps));
}

/** 띄운 pc 세션의 결과 — 연결됨(다리만이면 agentMissing) · 기한 안에 아직(connecting). 끝남·오류 줄이면 PC_START_FAILED 로 던진다. */
export type PcStartOutcome = { kind: "connected"; agentMissing: boolean } | { kind: "connecting" };

/**
 * pc 세션을 띄우고 «연결됨»을 기다린다(★틀린 «Connected» 를 찍지 않으려고) — start·갈아끼우기·원격 설정 반영·자동 업그레이드가 같은 길.
 * 연결됨 → connected · 기한(pcReadyDeadlineMs) 안에 없음 → connecting(실패가 아니다) · 오류 줄로 끝남·세션이 끝남 → 사유와 함께 던진다.
 */
export async function startPcSession(deps: PcDeps): Promise<PcStartOutcome> {
  const startedAt = new Date().toISOString();
  await termRequest(deps.paths, {
    op: "new",
    name: PC_SESSION_NAME,
    cwd: deps.cwd,
    command: deps.managedCommand(pcRunArgs(deps.flags)),
    env: deps.sessionEnv,
    // 사람 입력을 받지 않는다 — Windows 에서 stop·swap 의 ^C 뒤 cmd «일괄 작업» 확인이 기다리지 않게(launch.ts LaunchInput).
    input: "none",
  }, { start: true });
  let line: string;
  try {
    line = (await waitForMatch(deps.paths, PC_SESSION_NAME, PC_OUTCOME_PATTERN, { scrollback: true }, deps.readyDeadlineMs)).line;
  } catch (error) {
    if (error instanceof TermError && error.code === "TERM_WAIT_TIMEOUT") {
      return { kind: "connecting" };
    }
    // 끝남 — 기다리는 동안(SESSION_ENDED) 또는 기다리기 전에 이미(NO_SESSION: 바로 끝나 데몬 표에서 빠졌다).
    if (error instanceof TermError && (error.code === "TERM_SESSION_ENDED" || error.code === "TERM_NO_SESSION")) {
      const last = await lastLogLineSince(deps.agentLog, startedAt);
      throw new CliCommandError("PC_START_FAILED", `The PC connection stopped right after it started (${error.message})`
        + `${last ? ` Last log line: ${last}` : ""} Log: ${deps.agentLog}`);
    }
    throw error;
  }
  const outcome = pcOutcome([line]);
  if (outcome?.kind === "failed") {
    throw new CliCommandError("PC_START_FAILED", `The PC connection could not start — ${outcome.line} Log: ${deps.agentLog}`);
  }
  // 무엇이 붙었는지 그대로 — 화면 전체로 본다(Agent 없음 줄은 다리 연결 줄보다 앞에 찍힌다).
  const screen = pcOutcome(await screenLines(deps, PC_SESSION_NAME));
  return { kind: "connected", agentMissing: screen?.kind === "connected" && screen.agentMissing === true };
}

/** pc 세션 화면(스크롤백 포함) — 없으면 빈 목록. */
async function screenLines(deps: PcDeps, session: string): Promise<string[]> {
  try {
    const result = await termRequest(deps.paths, { op: "read", name: session, scrollback: true }, { start: false });
    return result.daemon ? readLines(result.data) : [];
  } catch (error) {
    if (error instanceof TermError && error.code === "TERM_NO_SESSION") return [];
    throw error;
  }
}

/**
 * 띄운 pc 세션이 서버에 «연결됨»을 찍을 때까지 기다린다(★틀린 «Connected» 를 찍지 않으려고). 연결됨 → Connected ·
 * 오류 줄로 끝남·세션이 끝남 → 그 사유 + 종료 1 · 기한(pcReadyDeadlineMs) 안에 둘 다 없음 → «아직 연결 중» + 종료 0(실패가 아니다).
 */
/** 띄운 결과를 사람에게 — 무엇이 붙었는지 그대로. */
function reportOutcome(deps: PcDeps, outcome: PcStartOutcome): number {
  const base = { session: PC_SESSION_NAME, folder: deps.cwd, log: deps.agentLog };
  if (outcome.kind === "connecting") {
    return print(deps, { ...base, connected: false, connecting: true }, pcResultText({ kind: "connecting", log: deps.agentLog }));
  }
  if (outcome.agentMissing) {
    return print(deps, { ...base, connected: true, already: false, agent: false, remote: true },
      pcResultText({ kind: "connected", agentMissing: true, log: deps.agentLog }));
  }
  return print(deps, { ...base, connected: true, already: false },
    pcResultText({ kind: "connected", agentMissing: false, log: deps.agentLog }));
}

/** agent.log 의 마지막 줄 — 이번 시작 뒤에 쓴 것만(옛 실행의 줄로 사유를 꾸미지 않는다). */
async function lastLogLineSince(path: string, since: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  const last = lastLine(text);
  if (!last) return undefined;
  try {
    const ts = (JSON.parse(last) as { ts?: unknown }).ts;
    return typeof ts === "string" && ts >= since ? last : undefined;
  } catch {
    // JSON 이 아닌 줄(쓰다 만 줄) — 사유로 쓰지 않는다.
    return undefined;
  }
}

/** `ainecto stop [--forget]` — pc 세션에 Ctrl+C(서버에 끝을 알린다) · 기한 넘으면 kill · --forget 은 이 서버 주소의 동의·짝지은 키도 지운다. */
export async function executePcStop(deps: PcDeps, argv: string[]): Promise<number> {
  const unknown = argv.filter((arg) => arg !== "--forget");
  if (unknown.length > 0) {
    throw new CliCommandError("USAGE", `Unknown argument for stop: ${unknown[0]}. Usage: ainecto stop [--forget]`);
  }
  const running = deps.termProblem === undefined ? runningPcs(await listed(deps)) : [];
  const lines: string[] = [];
  for (const pc of running) {
    lines.push(await stopPc(deps, pc));
  }
  if (running.length === 0) {
    lines.push("This PC is not connected.");
  }
  const forget = argv.includes("--forget");
  if (forget) {
    await savePcSettings(deps.settingsPath, withoutEndpoint(await loadPcSettings(deps.settingsPath, deps.hostName), deps.endpoint));
    lines.push(`Removed your approval for ${deps.endpoint} on this PC; \`ainecto\` asks again next time.`);
    // ★그 서버(계정 열쇠)의 키만 — 다른 서버의 짝짓기는 그대로(§11-4). 잠금 안에서(§13-2). 지울 것이 없으면 파일을 만들지 않는다.
    let removedKeys = false;
    await updatePcKeys(deps.keysPath, (keys) => {
      const kept = withoutEndpointKeys(keys, deps.endpoint);
      removedKeys = Object.keys(kept.accounts).length !== Object.keys(keys.accounts).length;
      return removedKeys ? kept : undefined;
    });
    if (removedKeys) {
      lines.push("Also removed this PC's terminal key and paired browsers for that server — pair again with `ainecto pair`.");
    }
  }
  return print(deps, { stopped: running.map((pc) => pc.session), forgot: forget }, lines.join("\n"));
}

/** `ainecto remote on|off` — 웹에서 이 PC 의 터미널을 여는 것을 허용·차단(계정별). */
export async function executeRemoteSetting(deps: PcDeps, argv: string[]): Promise<number> {
  const [value, ...rest] = argv;
  if ((value !== "on" && value !== "off") || rest.length > 0) {
    throw new CliCommandError("USAGE", "Usage: ainecto remote on|off");
  }
  const userId = (await deps.account()).userId;
  if (!userId) {
    throw new CliCommandError("PC_ACCOUNT_UNKNOWN", "Could not read your AiNecto account — run `ainecto doctor` to see why.");
  }
  const next = withRemoteTerminal(await loadPcSettings(deps.settingsPath, deps.hostName), accountKey(deps.endpoint, userId), value === "on");
  if (!next) {
    throw new CliCommandError("PC_NOT_APPROVED", "This PC is not connected yet — run `ainecto` in a terminal once to approve.");
  }
  await savePcSettings(deps.settingsPath, next);
  const said = value === "on"
    ? "Terminals from AiNecto on the web are allowed on this PC."
    : "Terminals from AiNecto on the web are blocked on this PC.";
  // ★떠 있는 pc 는 다시 띄운다 — 다리는 시작할 때 pc.json 을 읽으므로, 그래야 바로 반영된다(웹 PC 줄도 그때 바뀐다).
  const running = deps.termProblem === undefined ? runningPcs(await listed(deps)) : [];
  if (running.length === 0) {
    return print(deps, { remoteTerminal: value === "on" }, said);
  }
  if (!deps.json) deps.io.stdout.write(`${said}\n`);
  deps.io.stderr.write("Reconnecting this PC so it takes effect…\n");
  for (const pc of running) {
    await stopPc(deps, pc);
  }
  return await launchPc(deps);
}

/** 지금 떠 있는 PC 연결과 그 프로세스 그룹(`pair --remove` — 설계 terminal-e2e §13-2·§14-6 3). 데몬을 못 쓰거나 그룹을 못 읽으면 던진다. */
export async function runningPcGroups(deps: PcDeps): Promise<PcGroup[]> {
  assertQueryable(deps);
  const groups: PcGroup[] = [];
  for (const session of (await listedToTurnOff(deps)).filter((item) => runningPcs([item]).length > 0)) {
    const pgid = await processGroupOf(session.pid);
    if (pgid === undefined) {
      throw new CliCommandError("PC_STOP_UNCONFIRMED", `Could not read the process group of the PC connection (session ${session.name}, `
        + `pid ${session.pid}), so its end cannot be confirmed.`);
    }
    groups.push({ session: session.name, pid: session.pid, pgid });
  }
  return groups;
}

/**
 * 그 그룹들을 «완전히» 끈다 — 데몬 목록에 그 세션(같은 pid)이 있으면 {@link stopPc}, 그다음 목록에서 빠지고 그 프로세스 그룹에 남은
 * 프로세스가 0 인지를 stopDeadlineMs 안에 확인한다. 이미 목록에 없는 그룹(지난 실행이 끈 것)도 그룹의 소멸까지 확인한다.
 * npx 아래 손자(다리)가 남는 경우도 그룹으로 잡는다. IPC 끊김·kill 응답만으로는 끝났다고 보지 않는다. 확인하지 못하면 PC_STOP_UNCONFIRMED.
 * 다시 띄우지 않는다.
 */
export async function turnOffPcs(deps: PcDeps, groups: readonly PcGroup[]): Promise<void> {
  assertQueryable(deps);
  for (const group of groups) {
    const session = (await listedToTurnOff(deps)).find((item) => item.name === group.session && item.pid === group.pid);
    const [pc] = session ? runningPcs([session]) : [];
    if (pc) await stopPc(deps, pc);
    await confirmEnded(deps, group);
  }
}

/** termProblem 을 «떠 있는 PC 없음»으로 보지 않는다 — 조회 불가는 실패다(§14-6 3). */
function assertQueryable(deps: PcDeps): void {
  if (deps.termProblem !== undefined) {
    throw new CliCommandError("PC_STOP_UNCONFIRMED", `Could not check the PC connection (ainecto term: ${deps.termProblem}).`);
  }
}

/** 종료 확인 간격 100 ms — 사용자 결재 2026-11-21 «이 값으로 승인 (추천)»(설계 §14-7 C-E10). */
const STOP_CONFIRM_POLL_MS = 100;

async function confirmEnded(deps: PcDeps, group: PcGroup): Promise<void> {
  const deadline = Date.now() + deps.stopDeadlineMs;
  for (;;) {
    const stillListed = (await listedToTurnOff(deps)).some((session) => session.name === group.session && session.pid === group.pid);
    const alive = processGroupAlive(group.pgid);
    if (!stillListed && !alive) return;
    if (Date.now() >= deadline) {
      const what = stillListed ? "the session is still running" : `a process in its group ${group.pgid} is still alive`;
      throw new CliCommandError("PC_STOP_UNCONFIRMED", `Could not confirm that the PC connection (session ${group.session}, pid ${group.pid}) ended `
        + `within ${deps.stopDeadlineMs / 1000} s (${what}). See ${deps.agentLog}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, STOP_CONFIRM_POLL_MS));
  }
}

/**
 * 끄기 — 세션을 watch 하고 Ctrl+C 를 보낸 뒤 끝(exit 이벤트)을 기다린다. pc 프로세스는 SIGINT 에 서버에 close 를 보내고 코드 0 으로
 * 끝난다(매니페스트에서도 빠져 restore 가 되살리지 않는다). {@link PcDeps.stopDeadlineMs} 를 넘으면 term kill.
 */
export async function stopPc(deps: PcDeps, pc: RunningPc): Promise<string> {
  const client = await openTermClient(deps.paths, { start: false });
  if (!client) {
    return `Session ${pc.session} is already gone.`;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    // ★아직 연결 줄을 찍지 않았으면(막 띄움 — npx·준비 확인 중) Ctrl+C 처리기가 없을 수 있다: 신호로 죽으면 매니페스트에 남아
    //   재부팅 뒤 restore 가 되살린다. 그래서 바로 kill(명시 kill 은 매니페스트에서 빠진다).
    let ready: boolean;
    try {
      ready = pcOutcome(readLines(await client.request({ op: "read", name: pc.session, scrollback: true })))?.kind === "connected";
    } catch (error) {
      if (error instanceof TermError && error.code === "TERM_NO_SESSION") {
        return `Session ${pc.session} is already gone.`;
      }
      throw error;
    }
    if (!ready) {
      await client.request({ op: "kill", name: pc.session });
      return `Session ${pc.session} was still starting — ended it.`;
    }
    const ended = new Promise<"ended">((resolve) => {
      client.onEvent((event) => {
        if (event.event === "exit") {
          resolve("ended");
        }
      });
      client.onClose(() => resolve("ended"));
    });
    try {
      await client.request({ op: "watch", name: pc.session });
      await client.request({ op: "key", name: pc.session, key: "ctrl-c" });
    } catch (error) {
      if (error instanceof TermError && error.code === "TERM_NO_SESSION") {
        return `Session ${pc.session} is already gone.`;
      }
      throw error;
    }
    const outcome = await Promise.race([ended, new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), deps.stopDeadlineMs);
    })]);
    if (outcome === "ended") {
      return `Disconnected this PC (session ${pc.session}).`;
    }
    await termRequest(deps.paths, { op: "kill", name: pc.session }, { start: false });
    return `Session ${pc.session} did not stop within ${deps.stopDeadlineMs / 1000} s after Ctrl+C — ended it. See ${deps.agentLog}.`;
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

/** 관리 명령을 한 번 돌려 본다(--version) — npx 첫 설치·네트워크 실패를 세션 밖에서 보인다. */
async function prepare(deps: PcDeps): Promise<void> {
  const [command, ...args] = deps.managedCommand(["--version"]);
  if (!command) {
    throw new Error("The PC connection command is empty.");
  }
  const result = await deps.runner(command, args);
  if (result.missing || result.exitCode !== 0) {
    throw new CliCommandError("PC_PREPARE_FAILED", `\`${[command, ...args].join(" ")}\` failed${result.missing ? ` (${command} is not on PATH)` : ""}: `
      + `${lastLine(result.stderr) ?? lastLine(result.stdout) ?? `exit ${result.exitCode}`}`);
  }
}

export async function listed(deps: PcDeps, connect: TermConnectOptions = { start: false }): Promise<ListedSession[]> {
  const result = await termRequest(deps.paths, { op: "ls" }, connect);
  return listedSessions(result.daemon ? result.data : undefined);
}

/** 끄기 확인용 목록(`pair --remove`) — 빈 목록이 곧 «다 꺼졌다»라, 붙다가 끊긴 연결(ECONNRESET)은 «데몬 없음»으로 보지 않고 던진다(§14-6 3). */
async function listedToTurnOff(deps: PcDeps): Promise<ListedSession[]> {
  return await listed(deps, { start: false, resetFails: true });
}

function assertTerm(deps: PcDeps): void {
  if (deps.termProblem !== undefined) {
    throw new CliCommandError("PC_UNSUPPORTED", `Connecting this PC needs ainecto term: ${deps.termProblem}`);
  }
}

function pcView(deps: PcDeps, pc: RunningPc): Record<string, unknown> {
  return { session: pc.session, folder: pc.cwd, version: pcVersionLabel(pc), log: deps.agentLog };
}

/** 빈 답은 기본값. */
function yes(answer: string, byDefault: boolean): boolean {
  const value = answer.trim().toLowerCase();
  return value === "" ? byDefault : value === "y" || value === "yes";
}

function print(deps: PcDeps, data: Record<string, unknown>, human: string): number {
  deps.io.stdout.write(deps.json ? renderSuccess(data, { json: true }) : `${human}\n`);
  return 0;
}
