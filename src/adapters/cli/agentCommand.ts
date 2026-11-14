import { hostname } from "node:os";
import type { TokenProvider } from "../../core/auth/oauth";
import { ensurePrivateDir } from "../../core/fs/privateFiles";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { agentEnv, agentReplySchema, ainectoBridge, type AgentAdapter, type AgentId } from "../../core/agent/agents";
import type { AinectoEnv } from "../../core/config/endpoints";
import { spawnAgent } from "../../core/agent/child";
import { claudeAgentArgs, claudeMcpConfig } from "../../core/agent/claudeArgs";
import { claudeCodeAdapter } from "../../core/agent/claudeCode";
import { codexAdapter } from "../../core/agent/codex";
import { codexAppServerArgs } from "../../core/agent/codexArgs";
import { writeToolNames } from "../../core/agent/documents";
import { createAgentHttp } from "../../core/agent/http";
import { openAgentLog } from "../../core/agent/log";
import { agentPaths } from "../../core/agent/paths";
import { checkAgents, openAgents } from "../../core/agent/readiness";
import { runAgentServe } from "../../core/agent/serve";
import { AgentSessionMap } from "../../core/agent/sessions";
import { CLI_VERSION } from "../../core/version";
import type { CliIO } from "./ainectoCli";

export const AGENT_HELP_LINES: readonly string[] = [
  "  ainecto agent serve [--env prod|dev]   answer «My agent» requests from AiNecto Chat with Claude Code or Codex on this machine (Ctrl+C to stop; log: ~/.ainecto/agent/agent.log)",
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

export async function executeAgentServe(input: { endpoint: string; env: AinectoEnv; auth: TokenProvider; io: CliIO }): Promise<number> {
  const paths = agentPaths();
  await ensurePrivateDir(paths.dir);
  await ensurePrivateDir(paths.work);
  const log = openAgentLog(paths);
  const host = hostname();

  // 쓰기 도구 = 서버 표시(readOnlyHint) — 문서 줄은 그 결과에서만 뽑는다.
  const rpc = new McpRpcClient({ endpoint: input.endpoint, tokenProvider: input.auth, channel: "cli" });
  const started = Date.now();
  log.write({ event: "agent_call", callId: `tools-list-${started}`, op: "tools_list", bytes: 0 });
  let writeTools: Set<string>;
  try {
    writeTools = writeToolNames((await rpc.toolsList()) as Array<{ name: string; annotations?: { readOnlyHint?: boolean } }>);
    log.write({ event: "agent_call_response", callId: `tools-list-${started}`, op: "tools_list", ok: true, ms: Date.now() - started });
  } catch (error) {
    log.write({ event: "agent_call_response", callId: `tools-list-${started}`, op: "tools_list", ok: false,
      error: error instanceof Error ? error.message : String(error), ms: Date.now() - started });
    throw error;
  }

  // 브리지 = 지금 돌고 있는 이 CLI 그대로(같은 node · 같은 스크립트 · 같은 서버 주소).
  const cliScript = process.argv[1];
  if (!cliScript) throw new Error("Cannot find the path of this CLI to start the AiNecto bridge for the agents.");
  const bridge = ainectoBridge(process.execPath, cliScript, input.endpoint);
  const shared = { spawnImpl: spawnAgent, cwd: paths.work, env: agentEnv(process.env), log, writeTools };
  const mcpConfig = claudeMcpConfig(bridge);
  const all: AgentAdapter[] = [
    claudeCodeAdapter({ ...shared, args: ({ textMaxCharacters, resumeSessionId }) =>
      claudeAgentArgs({ schema: agentReplySchema(textMaxCharacters), mcpConfig, resumeSessionId }) }),
    codexAdapter({ ...shared, appServerArgs: codexAppServerArgs(bridge, writeTools), clientVersion: CLI_VERSION }),
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
