import { renderSuccess } from "../../core/output/render";
import {
  accountKey,
  loadPcSettings,
  savePcSettings,
  withConsent,
  withoutEndpoint,
  withRemoteTerminal,
} from "../../core/pc/pcSettings";
import { PC_SESSION_NAME, pcAction, pcRunArgs, pcVersionLabel, runningPcs, type LaunchFlags, type RunningPc } from "../../core/pc/pcSession";
import type { AccountSummary } from "../../core/setup/accountSummary";
import { lastLine, type CommandRunner } from "../../core/setup/commandRunner";
import { doctorChecks } from "../../core/setup/doctorChecks";
import type { MachineStatus } from "../../core/setup/machineStatus";
import { openTermClient, termRequest } from "../../core/term/client";
import { TermError } from "../../core/term/errors";
import type { TermPaths } from "../../core/term/paths";
import { listedSessions, type ListedSession } from "../../core/term/protocol";
import type { CliIO } from "./ainectoCli";
import { promptLine } from "./destructiveConfirmation";
import { CliCommandError } from "./errors";

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
  for (const check of doctorChecks(status).filter((item) => item.level !== "ok")) {
    note(`  ${check.level === "fail" ? "✗" : "!"} ${check.item}: ${check.detail}${check.fix ? ` — fix: ${check.fix}` : ""}`);
  }
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
    return print(deps, { connected: true, already: true, ...pcView(deps, action.pc) },
      `Already connected (session ${action.pc.session}, folder ${action.pc.cwd}, version ${pcVersionLabel(action.pc)}). Log: ${deps.agentLog}`);
  }
  await prepare(deps);
  if (action.kind === "replace") {
    for (const pc of action.pcs) {
      note(`Replacing the PC connection ${pcVersionLabel(pc)} (session ${pc.session}) with ${deps.cliVersion}…`);
      await stopPc(deps, pc);
    }
  }
  await termRequest(deps.paths, {
    op: "new",
    name: PC_SESSION_NAME,
    cwd: deps.cwd,
    command: deps.managedCommand(pcRunArgs(deps.flags)),
    env: deps.sessionEnv,
  }, { start: true });
  return print(deps, { connected: true, already: false, session: PC_SESSION_NAME, folder: deps.cwd, log: deps.agentLog },
    `Connected this PC to AiNecto (session ${PC_SESSION_NAME}). It keeps running after you close this window. Log: ${deps.agentLog}`);
}

/** `ainecto stop [--forget]` — pc 세션에 Ctrl+C(서버에 끝을 알린다) · 기한 넘으면 kill · --forget 은 이 서버 주소의 동의도 지운다. */
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
  return print(deps, { remoteTerminal: value === "on" }, value === "on"
    ? "Terminals from AiNecto on the web are allowed on this PC."
    : "Terminals from AiNecto on the web are blocked on this PC.");
}

/**
 * 끄기 — 세션을 watch 하고 Ctrl+C 를 보낸 뒤 끝(exit 이벤트)을 기다린다. pc 프로세스는 SIGINT 에 서버에 close 를 보내고 코드 0 으로
 * 끝난다(매니페스트에서도 빠져 restore 가 되살리지 않는다). {@link PcDeps.stopDeadlineMs} 를 넘으면 term kill.
 */
async function stopPc(deps: PcDeps, pc: RunningPc): Promise<string> {
  const client = await openTermClient(deps.paths, { start: false });
  if (!client) {
    return `Session ${pc.session} is already gone.`;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
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

async function listed(deps: PcDeps): Promise<ListedSession[]> {
  const result = await termRequest(deps.paths, { op: "ls" }, { start: false });
  return listedSessions(result.daemon ? result.data : undefined);
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
