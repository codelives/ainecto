import { profileSettingsUrl } from "../../core/config/endpoints";
import { renderSuccess } from "../../core/output/render";
import type { McpRpcClient } from "../../core/mcp/rpcClient";
import { readAccount, type AccountSummary } from "../../core/setup/accountSummary";
import {
  connectAgent,
  desiredEntry,
  disconnectAgent,
  inspectAgents,
  type AgentContext,
  type ConnectionOutcome,
} from "../../core/setup/agentConnections";
import { recordingRunner, type CommandLog, type CommandRunner } from "../../core/setup/commandRunner";

export interface SetupCommandOptions {
  argv: string[];
  endpoint: string;
  env: "prod" | "dev";
  /** `ainecto auth login` 과 같은 함수들. */
  auth: { getAccessToken(): Promise<string | undefined>; login(): Promise<unknown> };
  client: McpRpcClient;
  /** 외부 명령 실행기 — setup 은 이것으로만 `claude`·`codex` 를 부른다. */
  runner: CommandRunner;
  /** 사용자 홈(Cursor 전역 설정의 자리). */
  home: string;
  json: boolean;
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };
}

/**
 * {@code ainecto setup} — ★기기 1회(설계 §4-1). 로그인 → 연결 확인(읽기) → 에이전트 연결.
 *
 * <ul>
 *   <li>Claude Code(사용자 범위)·Cursor(전역)·Codex 를 각각 따로 연결하고, 결과를 클라이언트마다
 *       {@code connected / updated / kept / not installed / failed} 로 말한다. 하나라도 실패하면 «부분 완료», 종료 1.</li>
 *   <li>남의 {@code ainecto} 항목은 건드리지 않는다. 소유 판정은 {@code isOurBridge} 하나.</li>
 *   <li>{@code --dry-run}: 로그인하지 않고 아무것도 쓰지 않는다 — 할 일만 보인다.</li>
 *   <li>{@code --undo}: 우리 브리지 항목만 지운다. 로그인은 {@code ainecto auth logout} 이 따로 한다.</li>
 * </ul>
 */
export async function executeSetupCommand(options: SetupCommandOptions): Promise<number> {
  const args = parseSetupArgs(options.argv);
  const commands: CommandLog[] = [];
  const context: AgentContext = { runner: recordingRunner(options.runner, commands), home: options.home };

  if (args.undo) {
    const states = await inspectAgents(context);
    const agents: ConnectionOutcome[] = [];
    for (const state of states) {
      agents.push(await disconnectAgent(state, context, args.dryRun));
    }
    const failed = agents.some((agent) => agent.status === "failed");
    options.io.stdout.write(renderSuccess({
      action: args.dryRun ? "setup --undo (dry-run)" : "setup --undo",
      agents,
      commands,
      notes: ["Your sign-in is kept — sign out with `ainecto auth logout`."],
    }, { json: options.json }));
    return failed ? 1 : 0;
  }

  // ① 로그인 — 쓸 수 있는 토큰이 없으면 브라우저 1회. dry-run 은 로그인하지 않는다.
  let signedIn = Boolean(await options.auth.getAccessToken());
  if (!signedIn && !args.dryRun) {
    await options.auth.login();
    options.io.stderr.write("Signed in.\n");
    signedIn = true;
  }

  // ② 연결 확인(읽기만).
  const account = signedIn ? await readAccount(options.client) : undefined;

  // ③ 에이전트 연결 — 클라이언트마다 따로. 실패는 그 클라이언트만의 결과다.
  const desired = desiredEntry({ env: options.env, endpoint: options.endpoint });
  const agents: ConnectionOutcome[] = [];
  for (const state of await inspectAgents(context)) {
    agents.push(await connectAgent(state, desired, context, args.dryRun));
  }

  const failed = agents.some((agent) => agent.status === "failed") || account?.problem !== undefined;
  options.io.stdout.write(renderSuccess({
    action: args.dryRun ? "setup (dry-run)" : "setup",
    setup: failed ? "partial" : "complete",
    endpoint: options.endpoint,
    account: accountView(account, signedIn, options.endpoint),
    agents,
    commands,
    next: nextSteps(account, agents, options.endpoint),
  }, { json: options.json }));
  return failed ? 1 : 0;
}

/**
 * 사람이 읽는 계정 칸. ★이메일은 없다. 직무는 «Your AiNecto role» — 권한이 아니라 AI 설명 방식에만 쓰인다.
 */
export function accountView(account: AccountSummary | undefined, signedIn: boolean, endpoint: string): Record<string, unknown> {
  if (!signedIn) {
    return { signedIn: false, note: "sign-in required — `ainecto setup` (without --dry-run) opens the browser once" };
  }
  const view: Record<string, unknown> = { signedIn: true };
  if (account?.userId) view.userId = account.userId;
  if (account?.displayName) view.name = account.displayName;
  if (account?.jobTitle !== undefined) {
    view.jobTitle = account.jobTitle ?? `not set — set it at ${profileSettingsUrl(endpoint)}`;
  }
  if (account?.projectCount !== undefined) view.projects = account.projectCount;
  if (account?.problem) view.problem = `${account.problem.kind}: ${account.problem.message}`;
  return view;
}

function nextSteps(account: AccountSummary | undefined, agents: ConnectionOutcome[], endpoint: string): string[] {
  const next: string[] = [];
  if (agents.some((agent) => agent.status === "connected" || agent.status === "updated")) {
    next.push("Start a new agent session to load the AiNecto tools. Every session sees the same tools; your AiNecto permissions decide what they may change.");
  }
  if (account?.jobTitle === null) {
    next.push(`Set your AiNecto role (your job) at ${profileSettingsUrl(endpoint)} — AI uses it to pitch explanations; it does not change permissions.`);
  }
  next.push("To add AiNecto's working rules to a repository, run `ainecto init` from its root.");
  next.push("`ainecto doctor` shows anything still missing.");
  return next;
}

function parseSetupArgs(argv: string[]): { dryRun: boolean; undo: boolean } {
  const args = { dryRun: false, undo: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--undo") {
      args.undo = true;
    } else if (arg === "--json") {
      // 전역 플래그.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}
