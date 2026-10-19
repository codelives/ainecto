import { McpRpcError, type McpRpcClient } from "../mcp/rpcClient";
import { extractProjects, unwrapMcpToolPayload } from "../mcp/toolPayload";

/**
 * 로그인한 계정의 요약 — setup·status·doctor 가 같은 함수로 읽는다(읽기만).
 * {@code initialize} → {@code identity_get_self}(userId·표시 이름·직무) → {@code list_projects}(개수만).
 *
 * <p>★이메일은 받지도 내지도 않는다(서버 identity_get_self 도 주지 않는다). 직무는 표시명({@code jobProfile.title})만
 * 쓴다 — 직무 코드 표를 CLI 에 복사하지 않는다.
 */
export interface AccountSummary {
  userId?: string;
  displayName?: string;
  /** 직무 표시명. 미설정이면 null. 서버가 칸을 안 주면(옛 서버) undefined. */
  jobTitle?: string | null;
  projectCount?: number;
  /** 못 읽은 이유 — 있으면 위 칸은 읽은 데까지만. */
  problem?: AccountProblem;
}

export interface AccountProblem {
  /** network = 서버에 못 닿음 · unauthorized = 401 · forbidden = 403(요금제에 MCP 없음 또는 계정 정지) · other */
  kind: "network" | "unauthorized" | "forbidden" | "other";
  message: string;
}

export async function readAccount(client: McpRpcClient): Promise<AccountSummary> {
  const summary: AccountSummary = {};
  try {
    await client.initialize();
    const self = unwrapMcpToolPayload(await client.toolsCall("identity_get_self", {})) as Record<string, unknown>;
    if (typeof self?.userId === "string") summary.userId = self.userId;
    if (typeof self?.displayName === "string") summary.displayName = self.displayName;
    if ("jobProfile" in (self ?? {})) {
      const profile = self.jobProfile as { title?: unknown } | null;
      summary.jobTitle = profile && typeof profile.title === "string" ? profile.title : null;
    }
    summary.projectCount = extractProjects(unwrapMcpToolPayload(await client.toolsCall("list_projects", {}))).length;
  } catch (error) {
    summary.problem = classify(error);
  }
  return summary;
}

function classify(error: unknown): AccountProblem {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof McpRpcError && error.code === "MCP_HTTP_ERROR") {
    const status = (error.details as { status?: number } | undefined)?.status;
    if (status === 401) return { kind: "unauthorized", message };
    if (status === 403) return { kind: "forbidden", message };
    return { kind: "other", message };
  }
  if (error instanceof McpRpcError) {
    return { kind: "other", message };
  }
  // fetch 자체가 던진 것 — 연결 실패(DNS·TLS·오프라인).
  return { kind: "network", message };
}
