import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLogRecord } from "../../core/agent/log";
import { runningPcs } from "../../core/pc/pcSession";
import { auditPassed, provenanceWorkflow, reportsVersion, sameWorkflow, type ProvenanceWorkflow } from "../../core/pc/pcUpgrade";
import { lastLine, type CommandResult, type CommandRunner } from "../../core/setup/commandRunner";
import type { DaemonLog } from "../../core/term/daemonLog";
import { listed, startPcSession, stopPc, type PcDeps } from "./pcCommand";

/**
 * 자동 업그레이드 도우미 `ainecto pc swap --from <판> --to <판>`(내부 명령 — KAN-738 next.10, 계획 auto-upgrade-plan.md 3절).
 * pc run 이 «지금 판 코드»로, 세션 밖 독립 프로세스(detached)로 띄운다 — pc run 은 term 세션 안이라 자기를 끄면 그 자식도 죽는다.
 *
 * <pre>
 * 1 받기·실행 확인  `npx … @pkg@V ainecto --version` 이 V 를 낸다 — 아니면 실패(아무것도 끄지 않는다)
 * 2 출처 증명       임시 폴더에 --ignore-scripts 로 받아 `npm audit signatures` 가 verified attestation · registry 증명의 workflow
 *                  (repository·path)가 지금 판의 것과 같다 — 아니면 거절(아무것도 끄지 않는다). 문자열은 박지 않는다(지금 판 증명과 대조)
 * 3 끄기           지금 pc 를 stop 길 그대로(Ctrl+C → 서버 close) — 그 사이 사람이 꺼서 없으면 멈춘다(다시 켜지 않는다)
 * 4 띄우기         start 와 같은 길(startPcSession), 세션 명령은 @pkg@V 로 고정, pcReadyDeadlineMs 동안 «연결됨»을 기다린다
 * 5 4 실패         새 것을 끄고 옛 판을 --skip-upgrade V 로 다시 띄운다(그 목표를 다시 시도하지 않게)
 * </pre>
 * 원격 셸은 term 데몬 안이라 끊기지 않는다 — 데몬은 건드리지 않는다.
 */
export interface SwapDeps {
  from: string;
  to: string;
  packageName: string;
  /** 그 판으로 고정한 pc 입구 — skipUpgrade 면 되돌림(그 목표 건너뛰기 표시를 넘긴다). */
  pc: (version: string, skipUpgrade?: string) => PcDeps;
  /** 그 폴더에서 도는 명령 실행기. */
  runner: (cwd: string) => CommandRunner;
  /** registry 증명 묶음 받기. */
  fetchJson: (url: string) => Promise<unknown>;
  makeTempDir: () => Promise<string>;
  removeDir: (path: string) => Promise<void>;
  /** 첫 단계 명령을 돌릴 폴더(npx). */
  home: string;
  log: DaemonLog<AgentLogRecord>;
}

class Refused extends Error {
  constructor(readonly reason: string, detail: string) {
    super(detail);
  }
}

class Failed extends Error {
  constructor(readonly step: string, detail: string) {
    super(detail);
  }
}

export async function executePcSwap(deps: SwapDeps): Promise<number> {
  const { from, to, log } = deps;
  const started = Date.now();
  log.write({ event: "upgrade_start", from, to });
  try {
    await checkRuns(deps);
    await checkProvenance(deps);
  } catch (error) {
    if (error instanceof Refused) {
      log.write({ event: "upgrade_refused", from, to, reason: error.reason, detail: error.message });
    } else {
      log.write({ event: "upgrade_failed", from, to, step: error instanceof Failed ? error.step : "verify", reason: message(error) });
    }
    return 1;
  }

  // 3 — 지금 pc 끄기. 그 사이 사람이 끈 pc 는 다시 켜지 않는다(업그레이드는 돌던 연결만 갈아탄다).
  const old = deps.pc(from);
  const running = runningPcs(await listed(old));
  if (running.length === 0) {
    log.write({ event: "upgrade_failed", from, to, step: "stop", reason: "the PC connection is no longer running — nothing to upgrade" });
    return 1;
  }
  for (const pc of running) {
    await stopPc(old, pc);
  }
  const fresh = deps.pc(to);
  let failure: string;
  try {
    const outcome = await startPcSession(fresh);
    if (outcome.kind === "connected") {
      log.write({ event: "upgrade_done", from, to, ms: Date.now() - started });
      return 0;
    }
    failure = `${to} did not connect within ${fresh.readyDeadlineMs / 1000} s`;
  } catch (error) {
    failure = message(error);
  }
  // 되돌림 — 새 것을 끄고 옛 판을 그 목표 건너뛰기 표시와 함께 다시 띄운다.
  for (const pc of runningPcs(await listed(fresh))) {
    await stopPc(fresh, pc);
  }
  let rolledBack = false;
  try {
    rolledBack = (await startPcSession(deps.pc(from, to))).kind === "connected";
  } catch (error) {
    failure = `${failure}; rolling back to ${from} also failed: ${message(error)}`;
  }
  log.write({ event: "upgrade_failed", from, to, step: "start", reason: failure, rolledBack });
  return 1;
}

/** 1 — 새 판을 받아 실제로 돌려 본다. */
async function checkRuns(deps: SwapDeps): Promise<void> {
  const [command, ...args] = deps.pc(deps.to).managedCommand(["--version"]);
  if (!command) throw new Failed("install", "The PC connection command is empty.");
  const result = await call(deps, "install", deps.runner(deps.home), command, args);
  if (result.exitCode !== 0 || !reportsVersion(result.stdout, deps.to)) {
    throw new Failed("install", `\`${[command, ...args].join(" ")}\` did not report ${deps.to}: ${summary(result)}`);
  }
}

/** 2 — 출처 증명: audit signatures + registry 증명의 workflow 가 지금 판의 것과 같다. */
async function checkProvenance(deps: SwapDeps): Promise<void> {
  const dir = await deps.makeTempDir();
  try {
    await writeFile(join(dir, "package.json"), `${JSON.stringify({ name: "ainecto-upgrade-check", private: true })}\n`);
    const run = deps.runner(dir);
    const spec = `${deps.packageName}@${deps.to}`;
    const installed = await call(deps, "verify", run, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", spec]);
    if (installed.exitCode !== 0) throw new Failed("verify", `npm install ${spec} failed: ${summary(installed)}`);
    const audit = await call(deps, "verify", run, "npm", ["audit", "signatures"]);
    if (!auditPassed(audit.exitCode, `${audit.stdout}\n${audit.stderr}`)) {
      throw new Refused("audit-failed", `npm audit signatures did not verify an attestation: ${summary(audit)}`);
    }
    const target = await workflowOf(deps, run, deps.to);
    const current = await workflowOf(deps, run, deps.from);
    if (!target) throw new Refused("no-attestation", `${spec} has no provenance attestation from a GitHub workflow.`);
    if (!current) throw new Refused("no-attestation", `The running ${deps.from} has no provenance attestation to compare with.`);
    if (!sameWorkflow(target, current)) {
      throw new Refused("workflow-differs", `${spec} was built by ${target.repository} ${target.path}, not ${current.repository} ${current.path}.`);
    }
  } finally {
    await deps.removeDir(dir);
  }
}

/** registry 의 그 판 증명 → workflow. 증명이 없으면 undefined. */
async function workflowOf(deps: SwapDeps, run: CommandRunner, version: string): Promise<ProvenanceWorkflow | undefined> {
  const view = await call(deps, "verify", run, "npm", ["view", `${deps.packageName}@${version}`, "dist.attestations.url"]);
  const url = view.exitCode === 0 ? view.stdout.trim() : "";
  if (url === "") return undefined;
  const callId = randomUUID();
  const started = Date.now();
  deps.log.write({ event: "upgrade_call", callId, step: "verify", command: `GET ${url}` });
  let ok = false;
  let detail: string | undefined;
  try {
    const workflow = provenanceWorkflow(await deps.fetchJson(url), deps.packageName, version);
    ok = workflow !== undefined;
    detail = workflow ? `${workflow.repository} ${workflow.path}` : "no SLSA workflow for this version";
    return workflow;
  } catch (error) {
    detail = message(error);
    throw new Failed("verify", `Could not read the attestation of ${version}: ${detail}`);
  } finally {
    deps.log.write({ event: "upgrade_call_response", callId, step: "verify", ok, ms: Date.now() - started, ...(detail ? { detail } : {}) });
  }
}

/** 바깥 명령 하나 — 요청 1줄 + 응답 1줄(같은 callId). */
async function call(deps: SwapDeps, step: string, run: CommandRunner, command: string, args: readonly string[]): Promise<CommandResult> {
  const callId = randomUUID();
  const started = Date.now();
  deps.log.write({ event: "upgrade_call", callId, step, command: [command, ...args].join(" ") });
  let result: CommandResult = { exitCode: null, stdout: "", stderr: "no result", missing: false };
  try {
    result = await run(command, args);
    return result;
  } finally {
    deps.log.write({ event: "upgrade_call_response", callId, step, ok: result.exitCode === 0, exitCode: result.exitCode,
      ms: Date.now() - started, ...(result.exitCode !== 0 ? { detail: summary(result) } : {}) });
  }
}

function summary(result: CommandResult): string {
  return result.missing ? "not on PATH" : lastLine(result.stderr) ?? lastLine(result.stdout) ?? `exit ${result.exitCode}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
