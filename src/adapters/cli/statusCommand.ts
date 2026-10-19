import { renderSuccess } from "../../core/output/render";
import { AGENT_CLIENT_LABELS } from "../../core/setup/agentConnections";
import { doctorChecks } from "../../core/setup/doctorChecks";
import { collectStatus, type CollectInput, type MachineStatus } from "../../core/setup/machineStatus";
import { accountView } from "./setupCommand";

export interface StatusCommandOptions {
  argv: string[];
  collect: CollectInput;
  json: boolean;
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };
}

/**
 * {@code ainecto status} — 읽기 전용 한 화면(설계 §4-3). 토큰 값·이메일은 내지 않는다.
 */
export async function executeStatusCommand(options: StatusCommandOptions): Promise<number> {
  assertNoArgs("status", options.argv);
  const status = await collectStatus(options.collect);
  options.io.stdout.write(renderSuccess(statusView(status), { json: options.json }));
  return 0;
}

/**
 * {@code ainecto doctor} — status 와 «같은 수집»을 보고 항목마다 ok/warn/fail + 고칠 명령(설계 §4-4).
 * fail 이 하나라도 있으면 종료 1. {@code --fix} 는 없다 — 고치는 길은 setup·init 재실행이다.
 */
export async function executeDoctorCommand(options: StatusCommandOptions): Promise<number> {
  assertNoArgs("doctor", options.argv);
  const status = await collectStatus(options.collect);
  const checks = doctorChecks(status);
  const failed = checks.filter((check) => check.level === "fail").length;
  const warned = checks.filter((check) => check.level === "warn").length;
  options.io.stdout.write(renderSuccess({
    summary: failed > 0 ? `${failed} problem(s) to fix` : warned > 0 ? `working — ${warned} suggestion(s)` : "all good",
    checks,
  }, { json: options.json }));
  return failed > 0 ? 1 : 0;
}

function statusView(status: MachineStatus): Record<string, unknown> {
  const signedIn = status.token.state === "env" || status.token.state === "signed-in";
  return {
    cli: status.cliVersion,
    endpoint: status.endpoint,
    env: status.env,
    signIn: status.token,
    account: accountView(status.account, signedIn, status.endpoint),
    agents: status.agents.map((agent) => ({
      client: AGENT_CLIENT_LABELS[agent.client],
      state: !agent.installed ? "not installed"
        : agent.problem ? `unknown (${agent.problem})`
          : !agent.entry ? "not connected"
            : agent.ours ? `connected${agent.scope ? ` (${agent.scope})` : ""}` : `someone else's entry${agent.scope ? ` (${agent.scope})` : ""}`,
      ...(agent.pinnedVersion ? { bridge: `@ainecto/mcp@${agent.pinnedVersion}` } : {}),
      ...(agent.carriesRole ? { legacyRole: true } : {}),
    })),
    ...(status.claudeHere?.entry ? { claudeCodeHere: { scope: status.claudeHere.scope, ours: status.claudeHere.ours } } : {}),
    repository: status.repository,
    ...(status.globalCliVersion ? { globalAinecto: status.globalCliVersion } : {}),
  };
}

function assertNoArgs(command: string, argv: string[]): void {
  const unknown = argv.filter((arg) => arg !== "--json");
  if (unknown.length > 0) {
    throw new Error(`Unknown argument for ${command}: ${unknown[0]}`);
  }
}
