import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { runStdioBridge } from "../../core/mcp/stdioBridge";
import type { HarnessRole } from "../../core/harness/role";
import type { Readable, Writable } from "node:stream";

export interface ConnectorOptions {
  endpoint: string;
  role?: HarnessRole;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
}

export async function runConnector(options: ConnectorOptions): Promise<void> {
  const tokenStore = new FileTokenStore();
  // ★브리지도 «역할별» 토큰을 써야 한다. 여기에 역할을 안 넘기면 역할별로 로그인해 둔
  //   자격증명을 못 찾고, 남아 있는 무역할 토큰을 집는다 — 제한이 조용히 풀린다
  //   (2026-09-23 독립 재리뷰 C2. RPC 클라이언트에는 넘기고 여기만 빠뜨렸다).
  const auth = new OAuthClient({ endpoint: options.endpoint, tokenStore, role: options.role });
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
