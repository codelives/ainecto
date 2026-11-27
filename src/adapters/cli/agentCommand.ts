import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { onStopSignals } from "../../core/async/stopSignals";
import type { TokenProvider } from "../../core/auth/oauth";
import { ensurePrivateDir } from "../../core/fs/privateFiles";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { AGENT_MCP_CLIENT_NAMES, agentEnv, agentReplySchema, ainectoBridge, type AgentAdapter, type AgentId } from "../../core/agent/agents";
import type { AinectoEnv } from "../../core/config/endpoints";
import { antigravityAdapter } from "../../core/agent/antigravity";
import { antigravityMcpConfig } from "../../core/agent/antigravityArgs";
import { spawnAgent } from "../../core/agent/child";
import { claudeAgentArgs, claudeMcpConfig } from "../../core/agent/claudeArgs";
import { claudeCodeAdapter } from "../../core/agent/claudeCode";
import { codexAdapter } from "../../core/agent/codex";
import { codexAppServerArgs } from "../../core/agent/codexArgs";
import { writeToolNames } from "../../core/agent/documents";
import { createAgentHttp } from "../../core/agent/http";
import { createAgentTools } from "../../core/agent/tools";
import { NO_AGENTS_REASON, openAgentLog } from "../../core/agent/log";
import { agentPaths } from "../../core/agent/paths";
import { AgentRunLog } from "../../core/agent/runs";
import { agentStartRecords, checkAgents, openAgents } from "../../core/agent/readiness";
import { AGENT_MISSING_LINE, runAgentServe } from "../../core/agent/serve";
import { agentOwner, AgentSessionMap } from "../../core/agent/sessions";
import { CLI_BUILD, CLI_RELEASE, CLI_VERSION, CLI_VERSION_LABEL } from "../../core/version";
import type { LaunchFlags } from "../../core/pc/pcSession";
import { launchSwapHelper, upgradeWatch } from "./pcAutoUpgrade";
import type { CliIO } from "./ainectoCli";
import { pcPlan, pcRemoteSetup, runPcParts, runPcRemote } from "./pcRemote";
import { readAccount } from "../../core/setup/accountSummary";

export const AGENT_HELP_LINES: readonly string[] = [
  "  ainecto                       in a terminal, with no arguments: check sign-in, ask once, then connect this PC in the background (same as ainecto start)",
  "  ainecto start [--env prod|dev]   connect this PC in the background — keeps running after you close the window (log: ~/.ainecto/agent/agent.log)",
  "  ainecto stop [--forget]          disconnect this PC now (--forget also removes your approval and registered browsers on this PC)",
  "  ainecto remote on|off            allow or block terminals from AiNecto on the web on this PC",
];

/** 내부 명령 `ainecto pc run` — «이 PC 연결» 세션(ainecto-pc)이 돌린다. 사람은 `ainecto start` 를 친다. */
export function isPcRunCommand(domain: string | undefined, action: string | undefined): boolean {
  return domain === "pc" && action === "run";
}

/**
 * `ainecto pc run`(«이 PC 연결» 세션이 돌린다 — 옛 `ainecto agent serve`) — 이 기기의 Claude Code·Codex 를 «내 Agent»로 띄워 두고(KAN-1075),
 * 같은 프로세스에서 원격 터미널 다리(이 PC 의 term 세션 전부를 웹에 — KAN-738 next.10)를 함께 돌린다. 로그인은 CLI 로그인(OAuth) 하나.
 * 설치·로그인은 시작할 때 한 번 본다(모델 호출 0) — 나중에 로그인했으면 serve 를 다시 띄운다.
 */
/** serve 시작 안내 — Agent 마다 과금 주체. */
const BILLED_TO: Readonly<Record<AgentId, string>> = { "claude-code": "Anthropic", codex: "OpenAI", antigravity: "Google" };

/**
 * @param agentName 이 폴더의 에이전트 이름({@code .ainecto/agent.local}, 선택) — 있으면 할 일을 돌리는 한 종류의 신원 이름으로 open 에 싣는다.
 *                  없어도 할 일은 받는다(신원 이름 = 종류 id — 서버가 정한다).
 */
export async function executeAgentServe(input: {
  endpoint: string;
  env: AinectoEnv;
  auth: TokenProvider;
  io: CliIO;
  agentName?: string;
  /** 이 pc 를 띄운 전역 플래그 — 자동 업그레이드 도우미가 새 pc 를 같은 서버로 띄운다. */
  launchFlags: LaunchFlags;
  /** 자동 업그레이드에서 되돌려 띄웠으면 그 목표(이 프로세스에서 다시 시도하지 않는다). */
  skipUpgrade?: string;
}): Promise<number> {
  const paths = agentPaths();
  await ensurePrivateDir(paths.dir);
  await ensurePrivateDir(paths.work);
  const log = openAgentLog(paths);
  const host = hostname();

  // 쓰기 도구 = 서버 표시(readOnlyHint) — 문서 줄은 그 결과에서만 뽑는다.
  // ★serve 의 서버 MCP 도구 호출은 이 한 입구(로그 요청 1줄 + 응답 1줄) — 도구 목록·할 일·카드 동작 모두.
  //   serve 자신(도구 목록)은 이름 없는 연결 · 할 일은 서버가 종류마다 이어 준 신원으로(이름 + 그 종류의 Agent 헤더).
  const client = (agentName?: string) =>
    new McpRpcClient({ endpoint: input.endpoint, tokenProvider: input.auth, channel: "cli", ...(agentName ? { agentName } : {}) });
  const tools = createAgentTools({
    client: client(),
    clientAs: (identity) => {
      const as = client(identity.name);
      as.useAgent(AGENT_MCP_CLIENT_NAMES[identity.agent]);
      return as;
    },
    log,
  });
  const serverTools = (await tools.list()) as Array<{ name: string; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }>;
  const writeTools = writeToolNames(serverTools);

  // 브리지 = 지금 돌고 있는 이 CLI 그대로(같은 node · 같은 스크립트 · 같은 서버 주소).
  const cliScript = process.argv[1];
  if (!cliScript) throw new Error("Cannot find the path of this CLI to start the AiNecto bridge for the agents.");
  // Chat 차례 = 이름 없는 연결(지금과 같다) · 할 일 차례 = 이 serve 의 이름(세션을 열 때 agentName).
  const bridge = (agentName: string | undefined) => ainectoBridge(process.execPath, cliScript, input.endpoint, agentName);
  const shared = { spawnImpl: spawnAgent, cwd: paths.work, env: agentEnv(process.env), log, writeTools };
  const all: AgentAdapter[] = [
    claudeCodeAdapter({ ...shared, args: ({ textMaxCharacters, documentsMax, resumeSessionId, agentName }) =>
      claudeAgentArgs({ schema: agentReplySchema(textMaxCharacters, documentsMax), mcpConfig: claudeMcpConfig(bridge(agentName)), resumeSessionId }) }),
    codexAdapter({ ...shared, appServerArgs: (agentName) => codexAppServerArgs(bridge(agentName), writeTools), clientVersion: CLI_VERSION }),
    antigravityAdapter({ spawnImpl: spawnAgent, env: shared.env, home: homedir(), log, writeTools,
      tools: serverTools,
      // 연결 이름마다 한 폴더 — 이름 글자를 폴더 이름에 쓰지 않는다(해시).
      workDir: (agentName) => join(paths.antigravity,
        agentName ? `agent-${createHash("sha256").update(agentName).digest("hex").slice(0, 16)}` : "chat"),
      mcpConfig: (agentName) => antigravityMcpConfig(bridge(agentName)),
      schema: agentReplySchema }),
  ];
  const checks = await checkAgents(all, log);
  const started = agentStartRecords(checks, (id) => all.find((adapter) => adapter.id === id)?.displayName ?? id, (id) => BILLED_TO[id]);
  log.write({ event: "serve_start", pid: process.pid, version: CLI_VERSION_LABEL, endpoint: input.endpoint, host, agents: started });
  // Agent 마다 한 줄 — 어느 길(Agent·다리만·아무것도 없음)로 가든 먼저 찍는다. `ainecto start` 를 친 터미널은 serve_start 의 같은 줄을 옮긴다.
  for (const agent of started) input.io.stderr.write(`${agent.line}\n`);
  const agents = openAgents(checks);
  // ★Agent 가 없어도 원격이 허용이면 다리만 돈다(KAN-738 next.10) — 둘 다 없을 때만 시작하지 않는다(pcPlan).
  const remote = await pcRemoteSetup({ endpoint: input.endpoint, auth: input.auth, account: () => readAccount(client()), io: input.io });
  const plan = pcPlan({ agents: agents.length, remoteEnabled: remote.remoteEnabled });
  if (plan === "nothing") {
    throw new Error("None of Claude Code (`claude`), Codex (`codex`) or Antigravity (`agy`) is on PATH, and terminals from the web are off on this PC. "
      + "Install one and sign in, or allow terminals from the web with `ainecto remote on`, then run `ainecto` again.");
  }
  // ★자동 업그레이드(KAN-738 next.10) — 다리의 서버 응답마다 목표·한가를 보고, 한가할 때 도우미를 띄운다. 로컬 빌드는 절대 안 함.
  let agentBusy: () => boolean = () => false;
  const upgrades = upgradeWatch({
    current: CLI_VERSION,
    release: CLI_RELEASE,
    skip: input.skipUpgrade,
    agentBusy: () => agentBusy(),
    launch: (target) => launchSwapHelper({ from: CLI_VERSION, to: target, flags: input.launchFlags, log }),
  });
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  // ★SIGHUP 도(term kill·데몬 끝) · 두 번 와도(npx 아래 Ctrl+C) 처리기가 남는다 — onStopSignals 한 곳.
  const offSignals = onStopSignals(onSignal);
  try {
    if (plan === "remote-only") {
      log.write({ event: "serve_stop", pid: process.pid, reason: NO_AGENTS_REASON });
      input.io.stderr.write(`${AGENT_MISSING_LINE}\n`);
      return await runPcParts(Promise.resolve(0), (stop) => runPcRemote(remote, stop, upgrades), controller.signal);
    }
    const adapters = new Map<AgentId, AgentAdapter>(all.filter((adapter) => agents.some((a) => a.id === adapter.id))
      .map((adapter) => [adapter.id, adapter]));
    const sessions = new AgentSessionMap(paths.sessions);
    // ★pc 프로세스 = Agent + 원격 다리(KAN-738 next.10) — Agent 가 끝나도 원격은 계속, Agent 가 시작부터 던지면 다리도 멈춘다(runPcParts).
    const agent = runAgentServe({
      http: createAgentHttp({ endpoint: input.endpoint, tokenProvider: input.auth, log }),
      log,
      sessions,
      owner: async () => agentOwner(input.endpoint, await input.auth.getAccessToken()),
      adapters,
      agents,
      hostName: host,
      cliVersion: CLI_VERSION_LABEL,
      ...(CLI_BUILD ? { cliBuild: CLI_BUILD } : {}),
      print: (line) => input.io.stderr.write(`${line}\n`),
      signal: controller.signal,
      todos: { tools, agentName: input.agentName, runs: new AgentRunLog(paths.runs, log) },
      onBusyProbe: (busy) => {
        agentBusy = busy;
      },
    }).then((result) => {
      log.write({ event: "serve_stop", pid: process.pid, reason: result.reason });
      return result.exitCode;
    }, (error: unknown) => {
      log.write({ event: "serve_stop", pid: process.pid, reason: `error: ${error instanceof Error ? error.message : String(error)}` });
      throw error;
    });
    return await runPcParts(agent, (stop) => runPcRemote(remote, stop, upgrades), controller.signal);
  } finally {
    offSignals();
  }
}
