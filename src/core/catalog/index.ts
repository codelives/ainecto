import { generatedTools as prodTools } from "./generated.prod";
import { generatedTools as devTools } from "./generated.dev";
import { generateCatalog } from "./generator";
import type { GeneratedToolDefinition, McpToolListItem } from "./types";
import type { AinectoEnv } from "../config/endpoints";
import type { McpRpcClient } from "../mcp/rpcClient";

/** 이 CLI 판을 빌드할 때 받아 둔 스냅샷 — 서버를 못 부를 때의 대체본이다. */
export function getGeneratedTools(env: AinectoEnv) {
  return env === "dev" ? devTools : prodTools;
}

/**
 * ★서버의 지금 도구 목록 — 진실원은 서버다. 스냅샷만 보여 주면 서버에 새 문서 유형(html)이 열려도
 * 에이전트는 «CLI 에 없다»고 판단했다(2026-10-10). 유형·도구가 늘 때마다 CLI 를 다시 배포하지 않으려고
 * 실행할 때 받는다. 실패는 호출처가 스냅샷으로 대체하며 이유를 알린다.
 */
export async function loadLiveTools(env: AinectoEnv, client: McpRpcClient): Promise<GeneratedToolDefinition[]> {
  return generateCatalog(await client.toolsList() as McpToolListItem[], env);
}
