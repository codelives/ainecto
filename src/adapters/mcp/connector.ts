import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { runStdioBridge } from "../../core/mcp/stdioBridge";
import { findRepositoryRole } from "../../core/harness/repositoryRole";
import type { HarnessRole } from "../../core/harness/role";
import type { Readable, Writable } from "node:stream";

export interface ConnectorOptions {
  endpoint: string;
  /** 브리지의 역할 — MCP 설정의 `--role` 인자나 `AI_ERD_ROLE` 에서만 온다. 없으면 null. */
  role: HarnessRole | null;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  /** 역할 없는 브리지의 가림 진단에 쓸 폴더. 기본은 프로세스의 cwd. */
  cwd?: string;
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
  if (options.role === null) {
    await warnIfRepositoryHasRole(options.cwd ?? process.cwd(), options.errorOutput);
  }
  await runStdioBridge({
    input: options.input,
    output: options.output,
    errorOutput: options.errorOutput,
    client,
  });
}

/**
 * ★역할 없는 브리지가 «역할이 걸린 저장소 안»에서 붙으면 한 줄 경고한다(설계 0.4.2 §2-6, 리뷰 P1-b).
 *
 * <p>0.4.1 까지는 역할 없는 토큰이 없으면 이 브리지가 401 로 막혔다. 이제 토큰이 한 칸이라 조용히
 * «제한 없음»으로 붙는다. 흔한 원인은 같은 이름의 다른 항목(Claude Code 의 local scope 등)이
 * init 이 쓴 {@code .mcp.json} 을 가린 것이다. 역할을 «적용»하지는 않는다 — 출처를 늘리지 않는다.
 * 저장소 역할을 못 읽어도(어긋남 등) 브리지는 그대로 뜬다 — 진단일 뿐이다.
 */
async function warnIfRepositoryHasRole(cwd: string, errorOutput: Writable): Promise<void> {
  const found = await findRepositoryRole(cwd).catch(() => undefined);
  if (found?.kind !== "role") {
    return;
  }
  errorOutput.write(
    `ai-erd: this MCP connection has no role, but ${found.dir} sets the role ${found.role} for AI sessions. `
    + 'Another "ai-erd" entry may be hiding .mcp.json (Claude Code: `claude mcp get ai-erd`).\n',
  );
}
