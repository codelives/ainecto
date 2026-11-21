import { generatedTools as prodTools } from "./generated.prod";
import { generatedTools as devTools } from "./generated.dev";
import { generateCatalog, normalizeTool } from "./generator";
import { listAllOperations } from "../mcp/operations";
import type { GeneratedToolDefinition } from "./types";
import type { AinectoEnv } from "../config/endpoints";
import type { McpRpcClient } from "../mcp/rpcClient";

/** 이 CLI 판을 빌드할 때 받아 둔 스냅샷 — 서버를 못 부를 때의 대체본이다. */
export function getGeneratedTools(env: AinectoEnv) {
  return env === "dev" ? devTools : prodTools;
}

/**
 * ★서버의 지금 operation 목록 — 진실원은 서버다. 스냅샷만 보여 주면 서버에 새 문서 유형(html)이 열려도
 * 에이전트는 «CLI 에 없다»고 판단했다(2026-10-10). 유형·도구가 늘 때마다 CLI 를 다시 배포하지 않으려고 실행할 때 받는다.
 * 공개면이 search + execute_* 7개라(2026-11-21) tools/list 가 아니라 search 목록에서 만든다 — 이름·한 줄뿐이라 inputSchema 는 비어 있다.
 * 명령 하나를 실제로 부를 때는 {@link loadLiveTool} 로 그 operation 의 상세(inputSchema·힌트)를 받는다. 실패는 호출처가 스냅샷으로 대체한다.
 */
export async function loadLiveTools(env: AinectoEnv, client: McpRpcClient): Promise<GeneratedToolDefinition[]> {
  const lines = await listAllOperations({ toolsList: () => client.toolsList(), callPublic: (tool, args) => client.toolsCall(tool, args) });
  return generateCatalog(lines.map((line) => ({ name: line.operation, description: line.summary })), env);
}

/** operation 하나의 정의 — search 상세(inputSchema·annotations)에서. */
export async function loadLiveTool(env: AinectoEnv, client: McpRpcClient, operation: string): Promise<GeneratedToolDefinition> {
  const detail = await client.operations.detail(operation);
  return normalizeTool({ name: detail.operation, description: detail.summary, inputSchema: detail.inputSchema, annotations: detail.annotations }, env);
}
