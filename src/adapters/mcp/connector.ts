import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { runStdioBridge } from "../../core/mcp/stdioBridge";
import type { HarnessRole } from "../../core/harness/role";
import type { Readable, Writable } from "node:stream";

export interface ConnectorOptions {
  endpoint: string;
  /** 브리지의 역할 — MCP 설정의 `--role` 인자나 `AI_ERD_ROLE` 에서만 온다. 없으면 null. */
  role: HarnessRole | null;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
}

export async function runConnector(options: ConnectorOptions): Promise<void> {
  // ★토큰은 서버마다 한 칸이다(설계 0.4.2 §2-4). 역할은 토큰이 아니라 요청 헤더로 실린다 —
  //   브리지의 역할은 시작할 때 인자로 정해지고 세션 동안 바뀌지 않는다.
  const auth = new OAuthClient({ endpoint: options.endpoint, tokenStore: new FileTokenStore() });
  const client = new McpRpcClient({
    endpoint: options.endpoint,
    tokenProvider: auth,
    role: options.role,
  });
  await runStdioBridge({
    input: options.input,
    output: options.output,
    errorOutput: options.errorOutput,
    client,
  });
}
