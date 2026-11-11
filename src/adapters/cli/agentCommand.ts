import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import type { TokenProvider } from "../../core/auth/oauth";
import { ensurePrivateDir } from "../../core/fs/privateFiles";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { agentMcpConfig, agentReplySchema, claudeAgentArgs, claudeAgentEnv } from "../../core/agent/claudeArgs";
import { spawnClaude } from "../../core/agent/claudeProcess";
import { writeToolNames } from "../../core/agent/documents";
import { createAgentHttp } from "../../core/agent/http";
import { openAgentLog } from "../../core/agent/log";
import { agentPaths } from "../../core/agent/paths";
import { runAgentServe } from "../../core/agent/serve";
import { AgentSessionMap } from "../../core/agent/sessions";
import { CLI_VERSION } from "../../core/version";
import type { CliIO } from "./ainectoCli";

export const AGENT_HELP_LINES: readonly string[] = [
  "  ainecto agent serve [--env prod|dev]   answer «My agent» requests from AiNecto Chat with Claude Code on this machine (Ctrl+C to stop; log: ~/.ainecto/agent/agent.log)",
];

export function isAgentCommand(domain: string | undefined, action: string | undefined): boolean {
  return domain === "agent" && action === "serve";
}

/**
 * `ainecto agent serve` — 이 기기의 Claude Code 를 «내 Agent»로 띄워 둔다(KAN-1075). 로그인은 CLI 로그인(OAuth) 하나.
 */
export async function executeAgentServe(input: { endpoint: string; auth: TokenProvider; io: CliIO }): Promise<number> {
  const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (claude.error || claude.status !== 0) {
    throw new Error("Claude Code (`claude`) is not on PATH. Install Claude Code and sign in, then run `ainecto agent serve` again.");
  }
  const paths = agentPaths();
  await ensurePrivateDir(paths.dir);
  await ensurePrivateDir(paths.work);
  const log = openAgentLog(paths);
  const host = hostname();
  log.write({ event: "serve_start", pid: process.pid, version: CLI_VERSION, endpoint: input.endpoint, host, claude: claude.stdout.trim() });

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

  const sessions = new AgentSessionMap(paths.sessions);
  await sessions.load();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // 브리지 = 지금 돌고 있는 이 CLI 그대로(같은 node · 같은 스크립트 · 같은 서버 주소).
  const cliScript = process.argv[1];
  if (!cliScript) throw new Error("Cannot find the path of this CLI to start the AiNecto bridge for Claude Code.");
  const mcpConfig = agentMcpConfig(process.execPath, cliScript, input.endpoint);
  try {
    const result = await runAgentServe({
      http: createAgentHttp({ endpoint: input.endpoint, tokenProvider: input.auth, log }),
      log,
      sessions,
      writeTools,
      claudeArgs: ({ textMaxCharacters, resumeSessionId }) =>
        claudeAgentArgs({ schema: agentReplySchema(textMaxCharacters), mcpConfig, resumeSessionId }),
      spawnImpl: spawnClaude,
      cwd: paths.work,
      env: claudeAgentEnv(process.env),
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
