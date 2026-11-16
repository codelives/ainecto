import { hostname } from "node:os";
import type { TokenProvider } from "../../core/auth/oauth";
import { ensurePrivateDir } from "../../core/fs/privateFiles";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { AGENT_MCP_CLIENT_NAMES, agentEnv, agentReplySchema, ainectoBridge, type AgentAdapter, type AgentId } from "../../core/agent/agents";
import type { AinectoEnv } from "../../core/config/endpoints";
import { spawnAgent } from "../../core/agent/child";
import { claudeAgentArgs, claudeMcpConfig } from "../../core/agent/claudeArgs";
import { claudeCodeAdapter } from "../../core/agent/claudeCode";
import { codexAdapter } from "../../core/agent/codex";
import { codexAppServerArgs } from "../../core/agent/codexArgs";
import { writeToolNames } from "../../core/agent/documents";
import { createAgentHttp } from "../../core/agent/http";
import { createAgentTools } from "../../core/agent/tools";
import { openAgentLog } from "../../core/agent/log";
import { agentPaths } from "../../core/agent/paths";
import { AgentRunLog } from "../../core/agent/runs";
import { checkAgents, openAgents } from "../../core/agent/readiness";
import { runAgentServe } from "../../core/agent/serve";
import { AgentSessionMap } from "../../core/agent/sessions";
import { CLI_VERSION } from "../../core/version";
import type { CliIO } from "./ainectoCli";

export const AGENT_HELP_LINES: readonly string[] = [
  "  ainecto agent serve [--env prod|dev]   answer «My agent» requests from AiNecto Chat with Claude Code or Codex on this machine, and run the auto-run cards handed to this folder's agent (ainecto init --agent NAME) (Ctrl+C to stop; log: ~/.ainecto/agent/agent.log)",
];

export function isAgentCommand(domain: string | undefined, action: string | undefined): boolean {
  return domain === "agent" && action === "serve";
}

/**
 * `ainecto agent serve` — 이 기기의 Claude Code·Codex 를 «내 Agent»로 띄워 둔다(KAN-1075). 로그인은 CLI 로그인(OAuth) 하나.
 * 설치·로그인은 시작할 때 한 번 본다(모델 호출 0) — 나중에 로그인했으면 serve 를 다시 띄운다.
 */
/** serve 시작 안내 — Agent 마다 과금 주체. */
const BILLED_TO: Readonly<Record<AgentId, string>> = { "claude-code": "Anthropic", codex: "OpenAI" };

/**
 * @param agentName 이 폴더의 에이전트 이름({@code .ainecto/agent.local}) — 있으면 serve 의 도구 호출과 Agent 브리지가 그 이름으로 붙고,
 *                  그 에이전트에게 넘긴 자동 실행 카드(할 일)도 받는다.
 */
export async function executeAgentServe(input: { endpoint: string; env: AinectoEnv; auth: TokenProvider; io: CliIO; agentName?: string }): Promise<number> {
  const paths = agentPaths();
  await ensurePrivateDir(paths.dir);
  await ensurePrivateDir(paths.work);
  const log = openAgentLog(paths);
  const host = hostname();

  // 쓰기 도구 = 서버 표시(readOnlyHint) — 문서 줄은 그 결과에서만 뽑는다.
  // ★serve 의 서버 MCP 도구 호출은 이 한 입구(로그 요청 1줄 + 응답 1줄) — 도구 목록·할 일·카드 동작 모두.
  const client = () => new McpRpcClient({ endpoint: input.endpoint, tokenProvider: input.auth, channel: "cli", agentName: input.agentName });
  const tools = createAgentTools({
    client: client(),
    // 그 Agent 를 대신해 부르는 도구(실행 대화 글)는 그 Agent 의 종류 헤더로 — 서버가 실제로 도는 Agent 를 안다.
    clientAs: (agent) => {
      const as = client();
      as.useAgent(AGENT_MCP_CLIENT_NAMES[agent]);
      return as;
    },
    log,
  });
  const writeTools = writeToolNames((await tools.list()) as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>);

  // 브리지 = 지금 돌고 있는 이 CLI 그대로(같은 node · 같은 스크립트 · 같은 서버 주소).
  const cliScript = process.argv[1];
  if (!cliScript) throw new Error("Cannot find the path of this CLI to start the AiNecto bridge for the agents.");
  // Chat 차례 = 이름 없는 연결(지금과 같다) · 할 일 차례 = 이 serve 의 이름(세션을 열 때 agentName).
  const bridge = (agentName: string | undefined) => ainectoBridge(process.execPath, cliScript, input.endpoint, agentName);
  const shared = { spawnImpl: spawnAgent, cwd: paths.work, env: agentEnv(process.env), log, writeTools };
  const all: AgentAdapter[] = [
    claudeCodeAdapter({ ...shared, args: ({ textMaxCharacters, resumeSessionId, agentName }) =>
      claudeAgentArgs({ schema: agentReplySchema(textMaxCharacters), mcpConfig: claudeMcpConfig(bridge(agentName)), resumeSessionId }) }),
    codexAdapter({ ...shared, appServerArgs: (agentName) => codexAppServerArgs(bridge(agentName), writeTools), clientVersion: CLI_VERSION }),
  ];
  const checks = await checkAgents(all, log);
  log.write({ event: "serve_start", pid: process.pid, version: CLI_VERSION, endpoint: input.endpoint, host,
    agents: checks.map(({ id, installed, ready, auth, version }) =>
      ({ id, installed, ready, ...(auth ? { auth } : {}), ...(version ? { version } : {}) })) });
  const agents = openAgents(checks);
  if (agents.length === 0) {
    throw new Error("Neither Claude Code (`claude`) nor Codex (`codex`) is on PATH. Install one and sign in, then run `ainecto agent serve` again.");
  }
  for (const check of checks) {
    const name = all.find((adapter) => adapter.id === check.id)?.displayName ?? check.id;
    if (!check.installed) continue;
    if (check.ready) {
      input.io.stderr.write(check.auth === "apiKey"
        ? `${name}: runs on your own API key (billed to your ${BILLED_TO[check.id]} API account; AiNecto credits are not used).\n`
        : `${name}: runs on your subscription login (uses your plan's limits; AiNecto credits are not used).\n`);
    } else {
      input.io.stderr.write(`${name} is installed but not signed in${check.detail ? ` (${check.detail})` : ""}. `
        + `Requests to ${name} will be refused until you sign in and run \`ainecto agent serve\` again.\n`);
    }
  }
  const adapters = new Map<AgentId, AgentAdapter>(all.filter((adapter) => agents.some((a) => a.id === adapter.id))
    .map((adapter) => [adapter.id, adapter]));

  const sessions = new AgentSessionMap(paths.sessions);
  await sessions.load();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const result = await runAgentServe({
      http: createAgentHttp({ endpoint: input.endpoint, tokenProvider: input.auth, log }),
      log,
      sessions,
      adapters,
      agents,
      hostName: host,
      cliVersion: CLI_VERSION,
      print: (line) => input.io.stderr.write(`${line}\n`),
      signal: controller.signal,
      todos: { tools, agentName: input.agentName, runs: new AgentRunLog(paths.runs, log) },
    });
    log.write({ event: "serve_stop", pid: process.pid, reason: result.reason });
    return result.exitCode;
  } catch (error) {
    log.write({ event: "serve_stop", pid: process.pid, reason: `error: ${error instanceof Error ? error.message : String(error)}` });
    throw error;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
