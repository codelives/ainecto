import { hostname } from "node:os";
import { agentPaths } from "../../core/agent/paths";
import { pcStatusView } from "../../core/pc/pcSession";
import { accountKey, loadPcSettings, pcSettingsPath } from "../../core/pc/pcSettings";
import type { AccountSummary } from "../../core/setup/accountSummary";
import type { MachineStatus } from "../../core/setup/machineStatus";
import { termRequest } from "../../core/term/client";
import { termRuntimeProblem } from "../../core/term/daemonLock";
import { termPaths } from "../../core/term/paths";
import { listedSessions } from "../../core/term/protocol";
import { CliCommandError } from "./errors";

/** `ainecto status` 의 «이 PC 연결» 칸 — status 가 이미 읽은 계정으로 이 PC 의 동의를 찾는다. */
export async function pcStatus(status: MachineStatus, endpoint: string): Promise<Record<string, unknown>> {
  const termProblem = termRuntimeProblem();
  const sessions = termProblem === undefined
    ? await termRequest(termPaths(), { op: "ls" }, { start: false }).then((result) => listedSessions(result.daemon ? result.data : undefined))
    : [];
  const userId = status.account?.userId;
  const settings = await loadPcSettings(pcSettingsPath(), hostname());
  return pcStatusView({
    sessions,
    approval: userId ? settings.accounts[accountKey(endpoint, userId)] : undefined,
    agentLog: agentPaths().log,
    termProblem,
  });
}

/**
 * `term remote <세션>` 을 시작해도 되나 — 이 계정이 이 PC 에서 원격 터미널을 껐으면(`ainecto remote off`) 거절한다.
 * 아직 동의 기록이 없으면(옛 사용) 막지 않는다. 계정을 못 읽으면 그 이유로 멈춘다(모르는 채 열지 않는다).
 */
export async function assertRemoteAllowed(endpoint: string, account: () => Promise<AccountSummary>): Promise<void> {
  const summary = await account();
  if (!summary.userId) {
    throw new CliCommandError("PC_ACCOUNT_UNKNOWN", `Could not read your AiNecto account${summary.problem ? ` (${summary.problem.message})` : ""} — run \`ainecto doctor\` to see why.`);
  }
  const approval = (await loadPcSettings(pcSettingsPath(), hostname())).accounts[accountKey(endpoint, summary.userId)];
  if (approval && !approval.remoteTerminal) {
    throw new CliCommandError("REMOTE_OFF", "Terminals from AiNecto on the web are blocked on this PC. Allow them with `ainecto remote on`.");
  }
}
