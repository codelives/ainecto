import { usableAccessToken } from "../../core/auth/oauth";
import { profileSettingsUrl } from "../../core/config/endpoints";
import { renderSuccess } from "../../core/output/render";
import type { McpRpcClient } from "../../core/mcp/rpcClient";
import { readAccount, type AccountSummary } from "../../core/setup/accountSummary";
import {
  connectAgent,
  disconnectAgent,
  inspectAgents,
  type AgentContext,
  type ConnectionOutcome,
} from "../../core/setup/agentConnections";
import { recordingRunner, type CommandLog, type CommandRunner } from "../../core/setup/commandRunner";
import { desiredServerEntry, REMOTE_SIGN_IN, type AgentClientId } from "../../core/harness/agentTargets";

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
 *   <li>Claude Code(사용자 범위)·Cursor(전역)·Codex 에 ★서버 주소(원격 MCP)를 각각 따로 등록하고, 결과를 클라이언트마다
 *       {@code connected / updated / kept / not installed / failed} 로 말한다. 하나라도 실패하면 «부분 완료», 종료 1.</li>
 *   <li>우리 옛 항목(로컬 중계 {@code npx -y @ainecto/mcp@판})은 원격으로 바꿔 쓴다(updated). 남의 {@code ainecto}
 *       항목은 건드리지 않는다. 소유 판정은 {@code agentConnections} 하나.</li>
 *   <li>{@code --local}: 원격 대신 로컬 중계로 등록한다(이 기기의 로그인 하나를 모든 에이전트가 같이 쓴다).</li>
 *   <li>{@code --dry-run}: 로그인하지 않고 아무것도 쓰지 않는다 — 할 일만 보인다.</li>
 *   <li>{@code --undo}: 우리 항목(원격·로컬 중계)만 지운다. 로그인은 {@code ainecto auth logout} 이 따로 한다.</li>
 * </ul>
 */
export async function executeSetupCommand(options: SetupCommandOptions): Promise<number> {
  const args = parseSetupArgs(options.argv);
  const commands: CommandLog[] = [];
  const context: AgentContext = {
    runner: recordingRunner(options.runner, commands),
    home: options.home,
    endpoint: options.endpoint,
    // Codex 의 원격 add 는 그 자리에서 로그인한다 — 그 출력(로그인 링크)을 사용자에게 흘린다(stdout 결과는 깨끗하게).
    show: (text) => { options.io.stderr.write(text); },
  };

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

  // ① 로그인 — 쓸 수 있는 토큰이 없으면(서버가 저장 로그인을 거절한 경우 포함) 브라우저 1회.
  //   dry-run 은 로그인하지 않는다. ★판정은 init 과 같은 {@link usableAccessToken} 하나다.
  let signedIn = Boolean(await usableAccessToken(options.auth));
  if (!signedIn && !args.dryRun) {
    await options.auth.login();
    options.io.stderr.write("Signed in.\n");
    signedIn = true;
  }

  // ② 연결 확인(읽기만).
  const account = signedIn ? await readAccount(options.client) : undefined;

  // ③ 에이전트 연결 — 클라이언트마다 따로. 실패는 그 클라이언트만의 결과다.
  const agents: ConnectionOutcome[] = [];
  const remote: AgentClientId[] = [];
  for (const state of await inspectAgents(context)) {
    const desired = desiredServerEntry({ client: state.client, env: options.env, endpoint: options.endpoint, local: args.local });
    const outcome = await connectAgent(state, desired, context, args.dryRun);
    agents.push(outcome);
    // failed 도 싣는다 — 항목은 들어갔는데 로그인이 못 끝난 경우(Codex 한도 초과)가 있다. 재실행(already connected)도 다시 싣는다.
    if ("url" in desired && (outcome.status === "connected" || outcome.status === "updated" || outcome.status === "failed")) {
      remote.push(state.client);
    }
  }

  const failed = agents.some((agent) => agent.status === "failed") || account?.problem !== undefined;
  options.io.stdout.write(renderSuccess({
    action: args.dryRun ? "setup (dry-run)" : "setup",
    setup: failed ? "partial" : "complete",
    endpoint: options.endpoint,
    account: accountView(account, signedIn, options.endpoint),
    agents,
    commands,
    next: nextSteps(account, agents, remote, options.endpoint),
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

function nextSteps(account: AccountSummary | undefined, agents: ConnectionOutcome[], remote: AgentClientId[], endpoint: string): string[] {
  const next: string[] = [];
  if (agents.some((agent) => agent.status === "connected" || agent.status === "updated")) {
    next.push("Start a new agent session to load the AiNecto tools. Every session sees the same tools; your AiNecto permissions decide what they may change.");
  }
  if (remote.length > 0) {
    // 원격 등록은 에이전트마다 자기 OAuth 로 한 번 로그인한다 — 이 CLI 의 로그인과 별개다.
    next.push(`Each agent signs in to AiNecto by itself the first time it connects: ${remote.map((client) => REMOTE_SIGN_IN[client]).join("; ")}.`);
  }
  if (account?.jobTitle === null) {
    next.push(`Set your AiNecto role (your job) at ${profileSettingsUrl(endpoint)} — AI uses it to pitch explanations; it does not change permissions.`);
  }
  next.push("To add AiNecto's working rules to a repository, run `ainecto init` from its root.");
  next.push("`ainecto doctor` shows anything still missing.");
  return next;
}

function parseSetupArgs(argv: string[]): { dryRun: boolean; undo: boolean; local: boolean } {
  const args = { dryRun: false, undo: false, local: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--local") {
      args.local = true;
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
