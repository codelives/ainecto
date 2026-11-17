import { homedir, hostname } from "node:os";
import type { TokenProvider } from "../../core/auth/oauth";
import { ensurePrivateDir } from "../../core/fs/privateFiles";
import { PC_SESSION_NAME } from "../../core/pc/pcSession";
import { accountKey, loadPcSettings, pcSettingsPath } from "../../core/pc/pcSettings";
import type { AccountSummary } from "../../core/setup/accountSummary";
import { termPaths, type TermPaths } from "../../core/term/paths";
import { createRemoteHttp, openRemoteLog, runRemoteBridge, type RemoteResult } from "../../core/term/remote";
import { CLI_VERSION_LABEL } from "../../core/version";
import type { CliIO } from "./ainectoCli";
import { stringEnv } from "./termCommand";

/**
 * pc 프로세스(`ainecto pc run`) = Agent(serve) + 원격 다리(KAN-738 next.10 — PC 데몬 하나가 둘 다 맡는다).
 * ★Agent 가 끝나도(다른 PC 가 Agent 를 가져감·로그인 거절 등) 원격은 계속 — 둘 다 끝나야 끝난다. Agent 가 «던지면»(시작 실패 —
 * Claude·Codex 없음 등) 다리도 멈추고 그 오류를 그대로 던진다(start 가 pc 화면의 오류 줄로 사유를 본다).
 * 종료 코드: Agent 가 0 이 아니면 그것, 아니면 다리 것. 멈춤 신호는 다리에도 간다.
 */
export async function runPcParts(
  agent: Promise<number>,
  remote: (stop: AbortSignal) => Promise<RemoteResult>,
  signal: AbortSignal,
): Promise<number> {
  const stop = new AbortController();
  const onStop = (): void => stop.abort();
  if (signal.aborted) onStop();
  signal.addEventListener("abort", onStop, { once: true });
  const bridge = remote(stop.signal);
  try {
    let agentCode: number;
    try {
      agentCode = await agent;
    } catch (error) {
      stop.abort();
      await bridge;
      throw error;
    }
    const remoteResult = await bridge;
    return agentCode !== 0 ? agentCode : remoteResult.exitCode;
  } finally {
    signal.removeEventListener("abort", onStop);
  }
}

/**
 * pc 프로세스의 원격 다리 — `~/.ainecto/pc.json` 의 pcId 와 이 계정의 원격 허용(remoteTerminal)으로 연다. 허용이 아니거나(막음·동의 없음)
 * 계정을 못 읽으면 remoteEnabled=false 로 연다 — 웹 PC 줄에 «이 PC 에서 막음»이 보인다. 자기 pc 세션은 목록에서 뺀다.
 * 다리가 던지면 한 줄 남기고 1 로 끝낸다(Agent 는 계속).
 */
export async function runPcRemote(input: {
  endpoint: string;
  auth: TokenProvider;
  account: () => Promise<Pick<AccountSummary, "userId">>;
  io: CliIO;
  signal: AbortSignal;
  /** 시험만 바꾼다. */
  settingsPath?: string;
  paths?: TermPaths;
  home?: string;
  hostName?: string;
  env?: Record<string, string>;
}): Promise<RemoteResult> {
  const hostName = input.hostName ?? hostname();
  const paths = input.paths ?? termPaths();
  await ensurePrivateDir(paths.dir);
  const log = openRemoteLog(paths);
  const settings = await loadPcSettings(input.settingsPath ?? pcSettingsPath(), hostName);
  let userId: string | undefined;
  try {
    userId = (await input.account()).userId;
  } catch (error) {
    // 계정을 못 읽으면 원격을 켜지 않는다(모르는 채 열지 않는다) — 이유는 remote.log 에.
    log.write({ event: "remote_stop", pid: process.pid, reason: `account unreadable: ${error instanceof Error ? error.message : String(error)}` });
  }
  const remoteEnabled = userId !== undefined && settings.accounts[accountKey(input.endpoint, userId)]?.remoteTerminal === true;
  log.write({ event: "remote_start", pid: process.pid, version: CLI_VERSION_LABEL, endpoint: input.endpoint, host: hostName,
    pcId: settings.pcId, remote: remoteEnabled ? "on" : "off" });
  let result: RemoteResult;
  try {
    result = await runRemoteBridge({
      paths,
      http: createRemoteHttp({ endpoint: input.endpoint, tokenProvider: input.auth, log }),
      log,
      pcId: settings.pcId,
      hostName,
      cliVersion: CLI_VERSION_LABEL,
      remoteEnabled,
      exclude: [PC_SESSION_NAME],
      sessionEnv: input.env ?? stringEnv(),
      home: input.home ?? homedir(),
      signal: input.signal,
      print: (line) => input.io.stderr.write(`${line}\n`),
    });
  } catch (error) {
    const reason = `error: ${error instanceof Error ? error.message : String(error)}`;
    log.write({ event: "remote_stop", pid: process.pid, reason });
    input.io.stderr.write(`Remote terminal stopped: ${reason}\n`);
    return { exitCode: 1, reason };
  }
  log.write({ event: "remote_stop", pid: process.pid, reason: result.reason, exitCode: result.exitCode });
  if (result.exitCode !== 0 || !input.signal.aborted) {
    input.io.stderr.write(`Remote terminal stopped: ${result.reason}\n`);
  }
  return result;
}
