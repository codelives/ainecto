import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { runStdioBridge } from "../../core/mcp/stdioBridge";
import { LEGACY_ROLE_NOTICE, legacyRoleInput } from "../../core/harness/legacyRole";
import { readAgentName } from "../../core/harness/agentName";
import type { Readable, Writable } from "node:stream";

export interface ConnectorOptions {
  endpoint: string;
  /** 옛 MCP 설정의 {@code --role} 값(검사하지 않는다). 없으면 {@code AINECTO_ROLE} 를 본다 — 기록용. */
  legacyRoleFlag?: string;
  /** 브리지 인자 {@code --agent}. ★우선한다 — 없을 때만 {@code cwd} 폴더의 {@code .ainecto/agent.local} 을 읽는다. */
  agentFlag?: string;
  /** agent.local 을 찾을 폴더. 기본은 프로세스 cwd(에이전트가 브리지를 띄운 저장소). */
  cwd?: string;
  envVars?: NodeJS.ProcessEnv;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
}

export async function runConnector(options: ConnectorOptions): Promise<void> {
  // ★토큰은 서버마다 한 칸이다. 세션 역할은 없다 — 도구 목록·권한은 서버가 사용자 권한으로 정한다.
  const legacyRole = legacyRoleInput(options.legacyRoleFlag, options.envVars);
  if (legacyRole !== undefined) {
    // stdout 은 JSON-RPC 전용이다 — 안내는 stderr 로만.
    options.errorOutput.write(`${LEGACY_ROLE_NOTICE}\n`);
  }
  const auth = new OAuthClient({ endpoint: options.endpoint, tokenStore: new FileTokenStore() });
  const client = new McpRpcClient({
    endpoint: options.endpoint,
    tokenProvider: auth,
    legacyRole,
    agentName: options.agentFlag ?? await readAgentName(options.cwd ?? process.cwd()),
    // 에이전트의 MCP 연결 — 에이전트 «종류»는 브리지가 호스트의 initialize 에서 읽어 싣는다(«이름»은 위 agentName).
    channel: "mcp",
  });
  await runStdioBridge({
    input: options.input,
    output: options.output,
    errorOutput: options.errorOutput,
    client,
  });
}
