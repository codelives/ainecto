import { DaemonLog } from "../term/daemonLog";
import type { AgentPaths } from "./paths";

/**
 * `agent.log` 레코드(설계 K6). ★서버 호출은 {@code agent_call} 요청 1줄 + {@code agent_call_response} 응답 1줄(같은 callId),
 * Agent 한 차례는 {@code agent_request} + {@code agent_response}(같은 turnUuid), Codex JSON-RPC 는 {@code agent_rpc} + {@code agent_rpc_response}
 * (같은 pid·id), 준비 확인은 {@code agent_probe} + {@code agent_probe_response}(같은 callId). 실패해도 응답 줄은 반드시 — 이유 포함.
 * ★남기지 않는 것: 요청 글·답 글·토큰·계정 식별값(이메일 등)(길이·수만).
 */
export type AgentLogRecord =
  | { event: "serve_start"; pid: number; version: string; endpoint: string; host: string;
      agents: Array<{ id: string; installed: boolean; ready: boolean; auth?: string; version?: string }> }
  | { event: "serve_stop"; pid: number; reason: string }
  | { event: "agent_call"; callId: string; op: string; turnUuid?: string; bytes: number }
  | { event: "agent_call_response"; callId: string; op: string; ok: boolean; status?: number; code?: string; error?: string; ms: number; offers?: number }
  | { event: "agent_probe"; callId: string; agent: string; probe: "detect" | "auth" }
  | { event: "agent_probe_response"; callId: string; agent: string; probe: "detect" | "auth"; ok: boolean; installed?: boolean;
      version?: string; ready?: boolean; mode?: string; method?: string; plan?: string; detail?: string; ms: number }
  | { event: "offer"; turnUuid: string; conversationUuid: string; agent: string; duplicate: boolean }
  | { event: "process_start"; pid: number; agent: string; conversationUuid: string; resume: boolean }
  | { event: "process_exit"; pid: number; agent: string; conversationUuid: string; code: number | null; signal: string | null }
  | { event: "agent_rpc"; pid: number; agent: string; id: number; method: string }
  | { event: "agent_rpc_response"; pid: number; agent: string; id: number; method: string; ok: boolean; error?: string; ms: number }
  /** Agent 가 우리에게 물어 온 것(승인 등) — 묻지 않는 설정이라 오면 거절하고 남긴다. */
  | { event: "agent_server_request"; pid: number; agent: string; method: string; answer: string }
  /** Codex 가 띄운 MCP 서버 상태 — AiNecto 밖의 서버(사용자 기본 설정)도 뜨는지 여기서 본다. */
  | { event: "agent_mcp_server"; pid: number; agent: string; name: string; status: string; error?: string }
  /** Codex: 이 대화에서 끈 사용자 설정의 MCP 서버 이름. */
  | { event: "agent_mcp_servers_off"; pid: number; agent: string; names: string[] }
  /** 운영인데 구독 로그인으로 돌려 해서 그 차례를 멈췄다(키 값은 남기지 않는다 — 출처 이름만). */
  | { event: "agent_auth_blocked"; pid: number; agent: string; apiKeySource: string }
  | { event: "agent_request"; turnUuid: string; agent: string; conversationUuid: string; pid: number; textLength: number }
  | { event: "agent_response"; turnUuid: string; agent: string; ms: number; outcome: string; status: string; errorCode?: string; subtype?: string;
      sessionId?: string; documents: number; createdDocuments: number; cards: number; numTurns?: number; costUsd?: number }
  | { event: "bad_line"; pid: number; agent: string; length: number };

export function openAgentLog(paths: AgentPaths): DaemonLog<AgentLogRecord> {
  const log = new DaemonLog<AgentLogRecord>(paths.log, paths.previousLog);
  log.enableRotation();
  return log;
}
