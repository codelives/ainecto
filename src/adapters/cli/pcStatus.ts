import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { agentMissing, lastServeStop } from "../../core/agent/log";
import { isNodeError } from "../../core/fs/privateFiles";
import { agentPaths } from "../../core/agent/paths";
import { pcStatusView } from "../../core/pc/pcSession";
import { accountKey, loadPcSettings, pcSettingsPath } from "../../core/pc/pcSettings";
import type { MachineStatus } from "../../core/setup/machineStatus";
import { termRequest } from "../../core/term/client";
import { termRuntimeProblem } from "../../core/term/daemonLock";
import { termPaths } from "../../core/term/paths";
import { listedSessions } from "../../core/term/protocol";

/** `ainecto status` 의 «이 PC 연결» 칸 — status 가 이미 읽은 계정으로 이 PC 의 동의를 찾는다. */
export async function pcStatus(status: MachineStatus, endpoint: string): Promise<Record<string, unknown>> {
  const termProblem = termRuntimeProblem();
  const sessions = termProblem === undefined
    ? await termRequest(termPaths(), { op: "ls" }, { start: false }).then((result) => listedSessions(result.daemon ? result.data : undefined))
    : [];
  const userId = status.account?.userId;
  const settings = await loadPcSettings(pcSettingsPath(), hostname());
  const agentLog = agentPaths().log;
  const logText = await readFile(agentLog, "utf8").catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return "";
    throw error;
  });
  const lastStop = lastServeStop(logText);
  return pcStatusView({
    sessions,
    approval: userId ? settings.accounts[accountKey(endpoint, userId)] : undefined,
    agentLog,
    termProblem,
    ...(lastStop ? { lastStop } : {}),
    agentMissing: agentMissing(logText),
  });
}
