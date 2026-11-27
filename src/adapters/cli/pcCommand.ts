import { renderSuccess } from "../../core/output/render";
import {
  accountKey,
  loadPcSettings,
  savePcSettings,
  withConsent,
  withoutEndpoint,
  withRemoteTerminal,
} from "../../core/pc/pcSettings";
import { PC_SESSION_NAME } from "../../core/pc/bridgeKind";
import {
  PC_OUTCOME_PATTERN,
  daemonPlan,
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
import { daemonCaps, openTermClient, spawnResident, termRequest, type TermConnectOptions } from "../../core/term/client";
import { readDaemonInfo } from "../../core/term/residentInfo";
import { waitForDaemonLockFree } from "../../core/term/daemonLock";
import { TermError } from "../../core/term/errors";
import { unlinkIfPresent } from "../../core/term/ipc";
import type { TermPaths } from "../../core/term/paths";
import { listedSessions, readLines, sessionInstance, type ListedSession } from "../../core/term/protocol";
import { waitForMatch } from "../../core/term/wait";
import { isNodeError } from "../../core/fs/privateFiles";
import { serveStartLines } from "../../core/agent/log";
import { loadPcKeys, updatePcKeys, withoutBrowser, withoutEndpointKeys, type PcGroup } from "../../core/pc/pcKeys";
import { runPairing, type PairOutcome, type PairTransport } from "../../core/pc/pcPairing";
import {
  generateSigningJwk,
  NONCE_SEED_BYTES,
  randomBytes,
  REGISTER_PATH,
  registerFragment,
  registerKeys,
  registerTag,
  transcriptUserId,
} from "../../core/term/e2e";
import { readFile } from "node:fs/promises";
import type { CliIO } from "./ainectoCli";
import { promptLine } from "./destructiveConfirmation";
import { processGroupAlive, processGroupOf, processGroupUnavailableHint } from "../../core/os/launch";
import { CliCommandError } from "./errors";
import { pinBrowser } from "./pairCommand";
import { pcNotApprovedText, pcResultText, preflightNotes } from "./pcStartText";

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
  /** 브라우저 자동 등록(설계 auto-register-0.15.2) — 없으면 하지 않는다(시험). */
  register?: BrowserRegisterDeps;
}

/** 자동 등록에만 쓰는 것. */
export interface BrowserRegisterDeps {
  /** AiNecto 터미널 세션 안인가(AINECTO_TERM_SESSION) — 웹 원격 화면 안에서는 하지 않는다(pair 와 같은 규칙). */
  insideTermSession: boolean;
  /** ssh 로 들어온 터미널인가(SSH_CONNECTION·SSH_TTY) — 열면 사용자 손의 브라우저가 아니라 이 PC 화면에 뜬다(§4). */
  overSsh: boolean;
  /** 기본 브라우저로 연다 — 운영은 oauth.launchBrowser. 못 열면 거절. */
  openBrowser: (url: string) => Promise<void>;
  /** 서버 중계(이 PC 의 pcId 로) — 운영은 pcPairRelay.createPairRelay. */
  transport: (pcId: string) => PairTransport | Promise<PairTransport>;
  /** 양쪽에서 끝났다 — PC 알림. 던지지 않는다. */
  notifyPaired: (browser: { keyId: string; name: string }) => Promise<void>;
  /** 기한 — 운영은 PAIR_WAIT_MS(C-E1). */
  waitMs: number;
  /** Ctrl+C(건너뛰기) 를 기다린다 — 운영은 SIGINT 한 번. dispose 로 거둔다. */
  interrupt: () => { signal: AbortSignal; dispose: () => void };
  now: () => Date;
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
      throw new CliCommandError("PC_NOT_APPROVED", pcNotApprovedText(deps.hostName));
    }
    note("");
    note(`This connects this PC to AiNecto as ${status.account?.displayName ?? "your account"} (${deps.endpoint}).`);
    note("  · Your AiNecto agent will run work on this PC (Claude Code / Codex / Antigravity).");
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

  await upgradeDaemon(deps, note);
  const action = pcAction(runningPcs(await listed(deps)), deps.cliVersion);
  if (action.kind === "already") {
    // ★웹 «원격 터미널 끊기» 뒤 원격은 그 pc 프로세스가 사는 동안 꺼진 채다 — 같은 판이어도 다시 띄워야 원격이 켜진다(R3).
    if (!remoteOffByWeb(await screenLines(deps, action.pc.session))) {
      return await withRegistration(deps, key, userId, withNotes(deps, later, print(deps, { connected: true, already: true, ...pcView(deps, action.pc) },
        pcResultText({ kind: "already", folder: action.pc.cwd, version: pcVersionLabel(action.pc), log: deps.agentLog }))));
    }
    note("The remote terminal was turned off from the web — reconnecting this PC to turn it back on…");
    await stopPc(deps, action.pc);
    return await withRegistration(deps, key, userId, withNotes(deps, later, await launchPc(deps)));
  }
  await prepare(deps);
  if (action.kind === "replace") {
    for (const pc of action.pcs) {
      note(`Replacing the PC connection ${pcVersionLabel(pc)} (session ${pc.session}) with ${deps.cliVersion}…`);
      await stopPc(deps, pc);
    }
  }
  return await withRegistration(deps, key, userId, withNotes(deps, later, await launchPc(deps)));
}

/**
 * term 데몬을 이 판으로 맞춘다({@link daemonPlan} — 세션 유지 구조 3-4·3-6·5절). 판·구조는 살아 있는 바깥에게 묻는다(G4).
 *   handover — 이 판의 바깥을 띄우면 옛 바깥에게서 넘겨받는다. 세션은 닫히지 않아 묻지 않는다.
 *   retire   — holder 말이 모자라고 사용자 세션 0: PC 연결 세션째 holder 를 끝낸다. 뒤의 pcAction 이 새 판으로 다시 띄운다.
 *   switch   — 옛 구조 첫 전환: 열린 세션이 모두 한 번 닫힌다. 세션이 있으면 사람에게 한 번 묻고(기본 N) 비대화면 그대로 둔다.
 *              세션이 0 이면 닫힐 것이 없어 묻지 않는다. 옛 데몬이 끝나고 잠금이 풀린 뒤 daemon.json 을 지운다.
 */
export async function upgradeDaemon(deps: PcDeps, note: (line: string) => void): Promise<void> {
  const found = await daemonCaps(deps.paths);
  if (!found.daemon) return;
  const plan = daemonPlan({
    structure: found.caps ?? "old",
    cliVersion: deps.cliVersion,
    sessions: await listed(deps),
    insideTermSession: deps.register?.insideTermSession ?? false,
  });
  switch (plan.kind) {
    case "keep":
      return;
    case "handover": {
      // 새 바깥이 넘겨받고 준비를 알린 뒤에 돌아온다 — 넘기기가 안 끝나면 옛 바깥이 그대로 받는다(세션 그대로). 연결은 그대로 이어 간다.
      const readiness = await spawnResident(deps.paths, "daemon");
      if (readiness.status === "ready") note(`Updated the AiNecto terminal service on this PC to ${deps.cliVersion} — open sessions stay open.`);
      // 넘기기가 안 됐다 — 옛 바깥이 그대로 받는다(세션 그대로). 이유는 daemon.log 에 있고, 여기서는 한 줄만.
      if (readiness.status === "error") note(`The AiNecto terminal service was not updated this time (sessions are unchanged): ${readiness.message}`);
      return;
    }
    case "retire": {
      const result = await termRequest(deps.paths, { op: "retire", holder: plan.holder }, { start: false });
      const retired = result.daemon && (result.data as { retired?: unknown }).retired === true;
      if (retired) note("Updating the AiNecto terminal service on this PC (no open terminal sessions)…");
      return;
    }
    case "switch": {
      if (plan.sessions.length > 0) {
        if (!deps.interactive) return;
        const names = plan.sessions.map((session) => (session.kind === "pc-bridge" ? `${session.name} (PC connection)` : session.name));
        note(`The terminal structure on this PC changed, so this one time the ${plan.sessions.length} open terminal session(s) will close: `
          + `${names.join(", ")}. From the next update on they stay open.`);
        if (!yes(await promptLine(deps.io, "Switch now? [y/N]: "), false)) return;
      }
      await endOldDaemon(deps, note);
      return;
    }
  }
}

/** 옛 구조 데몬(0.16.x)을 끝낸다 — kill-server(칸 없이 — 옛 데몬은 holder uuid 를 모른다) → 잠금이 풀릴 때까지 → daemon.json 을 지운다. */
async function endOldDaemon(deps: PcDeps, note: (line: string) => void): Promise<void> {
  const info = readDaemonInfo(deps.paths);
  note("Switching the AiNecto terminal service on this PC to the new structure…");
  // 이미 끝난 데몬이면 받을 쪽이 없다 — 그래도 판정은 아래 잠금 하나로 한다.
  await termRequest(deps.paths, { op: "kill-server" }, { start: false });
  if (!(await waitForDaemonLockFree(deps.paths, deps.stopDeadlineMs))) {
    const pid = info ? ` (${info.version ?? "unknown version"}, started as pid ${info.pid})` : "";
    throw new CliCommandError("PC_START_FAILED", `The old AiNecto terminal service${pid} is still running and did not stop `
      + `within ${Math.round(deps.stopDeadlineMs / 1000)} s. End it — on Windows: Task Manager › Details › the node.exe whose command line has `
      + `"term daemon"; on macOS/Linux: \`kill ${info?.pid ?? "<pid>"}\` if that pid is still the daemon — or restart this PC, then run \`npx -y ainecto@latest\` again.`);
  }
  // ★옛 데몬이 끝나고 잠금이 풀린 «뒤»에만 — 구판 CLI 가 남은 파일의 판으로 업데이트 길에 들어가지 않게(설계 3-4).
  await unlinkIfPresent(deps.paths.daemonInfo);
}

/** 연결 결과를 찍은 «뒤» 브라우저 자동 등록 — 종료 코드는 그대로(등록이 안 돼도 연결은 이미 됐다). */
async function withRegistration(deps: PcDeps, key: string, userId: string, code: number): Promise<number> {
  if (code === 0) await registerBrowserOnStart(deps, { key, userId });
  return code;
}

/**
 * 브라우저 자동 등록(설계 auto-register-0.15.2 §1·§1-1·§2·§4·§11) — 대화형 · 터미널 세션 밖 · 원격 허용일 때. 이 PC 에 등록한 브라우저가 0 일 때만.
 * 이미 있으면 묻지 않고 안내 한 줄(«다른 브라우저는 등록된 브라우저에서 허용») — KAN-1615, Ryan 11-27 «묻지 않고 안내»
 * (0.15.3 결재 c8558683 의 «[y/N] 기본 N» 질문을 바꿈).
 * ssh 처럼 브라우저를 못 여는 곳에서는 등록한 브라우저가 0 일 때만 안내 한 줄(이미 있으면 조용히 끝낸다).
 * 일회용 비밀 S(32바이트)를 만들어 `https://<엔드포인트 origin>/api/v1/public/term-register#1.<pcId>.<tag>.<S>` 를 기본 브라우저로 열고
 * (분석 도구 없는 api 페이지 — S 를 앱 주소에 싣지 않는다), 같은 S 로
 * macB 를 검증 → 핀 → reveal(macP) → done. ★S 는 메모리에만 — 주소는 여는 명령의 인자로만 넘기고 stdout·stderr·로그·파일에 쓰지 않는다.
 * ★origin 은 CLI 엔드포인트에서만 정한다(서버가 준 주소를 열지 않는다). 실패·시간 초과·건너뛰기는 안내 한 줄만 — 던지지 않는다.
 */
export async function registerBrowserOnStart(
  deps: Pick<PcDeps, "io" | "json" | "interactive" | "settingsPath" | "hostName" | "keysPath" | "endpoint" | "register">,
  account: { key: string; userId: string },
): Promise<void> {
  const register = deps.register;
  if (!register || !deps.interactive || deps.json || register.insideTermSession) return;
  const settings = await loadPcSettings(deps.settingsPath, deps.hostName);
  if (settings.accounts[account.key]?.remoteTerminal !== true) return;
  const stored = (await loadPcKeys(deps.keysPath)).accounts[account.key];
  const registered = stored?.browsers.length ?? 0;
  const note = (line: string): void => {
    deps.io.stderr.write(`${line}\n`);
  };
  // ★웹에는 코드 비교(수동) 등록이 없다(KAN-1348 반려 — 수동 탭이 자동 등록 시도를 가로챘다). PC 화면의 터미널에서 다시 실행하는 길 하나.
  const noBrowser = "This PC can't open a browser here (for example over ssh). Run `npx -y ainecto@latest` in a terminal on this PC's own screen to register your browser.";
  if (register.overSsh) {
    if (registered === 0) note(noBrowser);
    return;
  }
  if (registered > 0) {
    note(`This PC trusts ${registered} browser${registered === 1 ? "" : "s"}. To use another browser, allow it from a registered browser.`);
    return;
  }
  const userId = transcriptUserId(account.userId);
  const secret = randomBytes(NONCE_SEED_BYTES);
  const interrupt = register.interrupt();
  let outcome: PairOutcome;
  /** 이 시도가 쓴 핀의 시각 — 되돌릴 때 이 항목만 거둔다(그 사이 새 기기 허용으로 다시 쓰인 같은 키는 남긴다). */
  let writtenAt = "";
  try {
    const tag = await registerTag((await registerKeys(secret)).account, userId);
    const url = `${new URL(deps.endpoint).origin}${REGISTER_PATH}#${registerFragment({ pcId: settings.pcId, tag, secret })}`;
    try {
      await register.openBrowser(url);
    } catch {
      note(noBrowser);
      return;
    }
    note("");
    note(`Finish in the browser that just opened (up to ${Math.round(register.waitMs / 60_000)} min · Ctrl+C to skip)`);
    const pcKey = stored?.pcKey ?? await generateSigningJwk();
    const pinnedAt = register.now();
    writtenAt = pinnedAt.toISOString();
    outcome = await runPairing({
      userId,
      pcId: settings.pcId,
      pcKey,
      transport: await register.transport(settings.pcId),
      confirm: { kind: "secret", secret },
      pin: (browser) => pinBrowser({ keysPath: deps.keysPath, key: account.key, pcKey, browser, now: pinnedAt }),
      waitMs: register.waitMs,
      cancel: interrupt.signal,
    });
  } catch (error) {
    note(`Browser registration did not finish (${error instanceof Error ? error.message : String(error)}). ${REGISTER_AGAIN}`);
    return;
  } finally {
    interrupt.dispose();
    secret.fill(0);
  }
  if (outcome.kind !== "paired") {
    const why = outcome.kind === "timeout" ? "timed out" : outcome.kind === "cancelled" ? "skipped" : "the browser could not be verified";
    note(`Browser registration did not finish (${why}). Nothing was saved. ${REGISTER_AGAIN}`);
    return;
  }
  const { browser, doneError } = outcome;
  if (doneError !== undefined) {
    // ★핀을 거둔다 — 남기면 등록 브라우저가 1 로 남아 `ainecto` 를 다시 실행해도 자동 등록이 돌지 않는다(그 브라우저는 PC 를 믿지 않는다).
    await updatePcKeys(deps.keysPath, (keys) => {
      const current = keys.accounts[account.key];
      if (!current?.browsers.some((item) => item.keyId === browser.keyId && item.pairedAt === writtenAt)) return undefined;
      return { accounts: { ...keys.accounts, [account.key]: { ...current,
        browsers: current.browsers.filter((item) => !(item.keyId === browser.keyId && item.pairedAt === writtenAt)) } } };
    });
    note(`The browser "${browser.name}" did not get the confirmation (${doneError}), so nothing was kept. ${REGISTER_AGAIN}`);
    return;
  }
  await register.notifyPaired({ keyId: browser.keyId, name: browser.name });
  deps.io.stdout.write(`Registered "${browser.name}" with this PC.\n`);
}

/** 자동 등록이 끝나지 않았을 때 덧붙이는 안내(§1-1). */
const REGISTER_AGAIN = "Try again: `npx -y ainecto@latest`.";

/** 결과를 찍은 «뒤» 알릴 것(stderr) — 종료 코드는 그대로. */
function withNotes(deps: PcDeps, notes: readonly string[], code: number): number {
  for (const line of notes) deps.io.stderr.write(`${line}\n`);
  return code;
}

/** pc 세션을 띄우고 «연결됨»을 기다린다 — start·갈아끼우기·원격 설정 반영이 같은 길. */
async function launchPc(deps: PcDeps): Promise<number> {
  return reportOutcome(deps, await startPcSession(deps));
}

/**
 * 띄운 pc 세션의 결과 — 연결됨(다리만이면 agentMissing) · 기한 안에 아직(connecting). 끝남·오류 줄이면 PC_START_FAILED 로 던진다.
 * agents = pc 세션이 이번 시작에 찍은 Agent 마다의 줄(serve_start — 못 찾음·준비 안 됨의 이유) — 이 터미널에도 옮긴다(KAN-1613 리뷰 r1 P0-1).
 */
export type PcStartOutcome = { kind: "connected"; agentMissing: boolean; agents: AgentDiagnostics } | { kind: "connecting"; agents: AgentDiagnostics };

/**
 * 이번 시작의 Agent 진단(agent.log 의 serve_start 줄). ★진단일 뿐이다 — 읽지 못하면(EACCES 등) unreadable 로만 알리고,
 * 연결 판정·종료 코드·교체 여부는 PTY 로 확인한 결과를 따른다(리뷰 r2 P0-1: 읽기 오류가 성공한 start·업그레이드를 실패로 바꿨다).
 * ⚠한계(리뷰 r2 P0-2, 루트 판정 «한계»): 홈 공용 로그에서 시작 시각 뒤의 마지막 serve_start 를 고른다 — 같은 홈에서 두 시작이 겹치거나
 *   시계가 뒤로 가면 다른 실행의 진단 줄이 보일 수 있다(드묾 · 진단 표시뿐). 자식 PID 로 거르지 않는 까닭: 세션 프로세스는 npx·셸이라
 *   serve 의 PID 를 호출자가 모른다.
 */
export type AgentDiagnostics = { lines: string[]; unreadable?: string };

async function agentDiagnosticsSince(path: string, since: string): Promise<AgentDiagnostics> {
  try {
    return { lines: serveStartLines(await readFile(path, "utf8"), since) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { lines: [] };
    const code = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    return { lines: [], unreadable: code };
  }
}

/** 사람에게 보일 진단 줄 — 읽지 못했으면 그 사실 한 줄. */
function agentDiagnosticLines(deps: PcDeps, agents: AgentDiagnostics): string[] {
  return agents.unreadable === undefined ? agents.lines
    : [`Agent details could not be read from ${deps.agentLog} (${agents.unreadable}).`];
}

/** JSON 칸 — 성공 결과와 실패 오류의 details 가 같은 모양. */
function agentDiagnosticData(agents: AgentDiagnostics): Record<string, unknown> {
  return { agents: agents.lines, ...(agents.unreadable === undefined ? {} : { agentsUnreadable: agents.unreadable }) };
}

/**
 * 실패로 끝날 때 — 사람용이면 Agent 줄을 오류 줄보다 먼저(stderr), --json 이면 오류 JSON 의 details 에만(리뷰 r2 P1-1).
 */
function startFailed(deps: PcDeps, agents: AgentDiagnostics, message: string): CliCommandError {
  if (!deps.json) for (const line of agentDiagnosticLines(deps, agents)) deps.io.stderr.write(`${line}\n`);
  return new CliCommandError("PC_START_FAILED", message, agentDiagnosticData(agents));
}

/**
 * pc 세션을 띄우고 «연결됨»을 기다린다(★틀린 «Connected» 를 찍지 않으려고) — start·갈아끼우기·원격 설정 반영·자동 업그레이드가 같은 길.
 * 연결됨 → connected · 기한(pcReadyDeadlineMs) 안에 없음 → connecting(실패가 아니다) · 오류 줄로 끝남·세션이 끝남 → 사유와 함께 던진다.
 */
export async function startPcSession(deps: PcDeps): Promise<PcStartOutcome> {
  const startedAt = new Date().toISOString();
  // ★종류는 여기 한 곳에서 찍는다 — 시작·갈아끼우기·원격 설정 반영·자동 업그레이드·되돌림이 모두 이 함수를 지난다(P1-1 입구 ②).
  const created = await termRequest(deps.paths, {
    op: "new",
    name: PC_SESSION_NAME,
    cwd: deps.cwd,
    command: deps.managedCommand(pcRunArgs(deps.flags)),
    env: deps.sessionEnv,
    // 사람 입력을 받지 않는다 — Windows 에서 stop·swap 의 ^C 뒤 cmd «일괄 작업» 확인이 기다리지 않게(launch.ts LaunchInput).
    input: "none",
    kind: "pc-bridge",
  }, { start: true });
  // 준비 증거는 «방금 만든 그 인스턴스»의 화면만 — 그 사이 같은 이름으로 다시 만든 세션의 줄로 «연결됨»을 찍지 않는다(옛 데몬은 칸 없음 → 이름만).
  const instance = created.daemon ? sessionInstance(created.data) : undefined;
  let line: string;
  try {
    line = (await waitForMatch(deps.paths, PC_SESSION_NAME, PC_OUTCOME_PATTERN, { scrollback: true }, deps.readyDeadlineMs, instance)).line;
  } catch (error) {
    if (error instanceof TermError && error.code === "TERM_WAIT_TIMEOUT") {
      return { kind: "connecting", agents: await agentDiagnosticsSince(deps.agentLog, startedAt) };
    }
    // 끝남 — 기다리는 동안(SESSION_ENDED) 또는 기다리기 전에 이미(NO_SESSION: 바로 끝나 데몬 표에서 빠졌다) · 같은 이름의 다른 세션으로 바뀜(SESSION_REPLACED).
    if (error instanceof TermError && (error.code === "TERM_SESSION_ENDED" || error.code === "TERM_NO_SESSION" || error.code === "SESSION_REPLACED")) {
      const agents = await agentDiagnosticsSince(deps.agentLog, startedAt);
      const last = await lastLogLineSince(deps.agentLog, startedAt);
      throw startFailed(deps, agents, `The PC connection stopped right after it started (${error.message})`
        + `${last ? ` Last log line: ${last}` : ""} Log: ${deps.agentLog}`);
    }
    throw error;
  }
  const outcome = pcOutcome([line]);
  const agents = await agentDiagnosticsSince(deps.agentLog, startedAt);
  if (outcome?.kind === "failed") {
    // 아무 Agent 도 없고 원격도 꺼져 끝남 — 왜 Agent 가 없는지(종류마다)를 먼저 알린다.
    throw startFailed(deps, agents, `The PC connection could not start — ${outcome.line} Log: ${deps.agentLog}`);
  }
  // 무엇이 붙었는지 그대로 — 화면 전체로 본다(Agent 없음 줄은 다리 연결 줄보다 앞에 찍힌다).
  const screen = pcOutcome(await screenLines(deps, PC_SESSION_NAME));
  return { kind: "connected", agentMissing: screen?.kind === "connected" && screen.agentMissing === true, agents };
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
  // Agent 마다 한 줄(pc 세션 화면과 같은 글)은 결과 단락 바로 뒤에 — 이 터미널에서 왜 Agent 가 안 붙었는지 보인다.
  const base = { session: PC_SESSION_NAME, folder: deps.cwd, log: deps.agentLog, ...agentDiagnosticData(outcome.agents) };
  const human = (result: string) => [result, ...agentDiagnosticLines(deps, outcome.agents)].join("\n");
  if (outcome.kind === "connecting") {
    return print(deps, { ...base, connected: false, connecting: true }, human(pcResultText({ kind: "connecting", log: deps.agentLog })));
  }
  if (outcome.agentMissing) {
    return print(deps, { ...base, connected: true, already: false, agent: false, remote: true },
      human(pcResultText({ kind: "connected", agentMissing: true, log: deps.agentLog })));
  }
  return print(deps, { ...base, connected: true, already: false },
    human(pcResultText({ kind: "connected", agentMissing: false, log: deps.agentLog })));
}

/** agent.log 의 마지막 줄 — 이번 시작 뒤에 쓴 것만(옛 실행의 줄로 사유를 꾸미지 않는다). */
async function lastLogLineSince(path: string, since: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    // 없거나 읽지 못함(EACCES 등) — 사유를 꾸밀 줄이 없을 뿐, 실패 판정은 PTY 결과 그대로(리뷰 r2 P0-1 과 같은 원칙).
    return undefined;
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
      lines.push("Also removed this PC's terminal key and registered browsers for that server — register them again by running `npx -y ainecto@latest`.");
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
    throw new CliCommandError("PC_NOT_APPROVED", pcNotApprovedText(deps.hostName));
  }
  await savePcSettings(deps.settingsPath, next);
  const said = value === "on"
    ? "Terminals from AiNecto on the web are allowed on this PC."
    : "Terminals from AiNecto on the web are blocked on this PC.";
  // ★떠 있는 pc 는 다시 띄운다 — 다리는 시작할 때 pc.json 을 읽으므로, 그래야 바로 반영된다(웹 PC 줄도 그때 바뀐다).
  const running = deps.termProblem === undefined ? runningPcs(await listed(deps)) : [];
  const key = accountKey(deps.endpoint, userId);
  if (running.length === 0) {
    return await withRegistration(deps, key, userId, print(deps, { remoteTerminal: value === "on" }, said));
  }
  if (!deps.json) deps.io.stdout.write(`${said}\n`);
  deps.io.stderr.write("Reconnecting this PC so it takes effect…\n");
  for (const pc of running) {
    await stopPc(deps, pc);
  }
  return await withRegistration(deps, key, userId, await launchPc(deps));
}

/** 지금 떠 있는 PC 연결과 그 프로세스 그룹(`pair --remove` — 설계 terminal-e2e §13-2·§14-6 3). 데몬을 못 쓰거나 그룹을 못 읽으면 던진다. */
export async function runningPcGroups(deps: PcDeps): Promise<PcGroup[]> {
  assertQueryable(deps);
  const groups: PcGroup[] = [];
  for (const session of (await listedToTurnOff(deps)).filter((item) => runningPcs([item]).length > 0)) {
    const pgid = await processGroupOf(session.pid);
    if (pgid === undefined) {
      throw new CliCommandError("PC_STOP_UNCONFIRMED", `Could not read the process group of the PC connection (session ${session.name}, `
        + `pid ${session.pid}), so its end cannot be confirmed.${processGroupUnavailableHint()}`);
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
