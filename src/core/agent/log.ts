import { DaemonLog } from "../term/daemonLog";
import type { AgentPaths } from "./paths";

/**
 * `agent.log` 레코드(설계 K6). ★서버 호출은 {@code agent_call} 요청 1줄 + {@code agent_call_response} 응답 1줄(같은 callId),
 * Claude 한 차례는 {@code agent_request} + {@code agent_response}(같은 turnUuid). 실패해도 응답 줄은 반드시 — 이유 포함.
 * ★남기지 않는 것: 요청 글·답 글·토큰(길이·수만).
 */
export type AgentLogRecord =
  | { event: "serve_start"; pid: number; version: string; endpoint: string; host: string; claude: string }
  | { event: "serve_stop"; pid: number; reason: string }
  | { event: "agent_call"; callId: string; op: string; turnUuid?: string; bytes: number }
  | { event: "agent_call_response"; callId: string; op: string; ok: boolean; status?: number; code?: string; error?: string; ms: number; offers?: number }
  | { event: "offer"; turnUuid: string; conversationUuid: string; duplicate: boolean }
  | { event: "process_start"; pid: number; conversationUuid: string; resume: boolean }
  | { event: "process_exit"; pid: number; conversationUuid: string; code: number | null; signal: string | null }
  | { event: "agent_request"; turnUuid: string; conversationUuid: string; pid: number; textLength: number }
  | { event: "agent_response"; turnUuid: string; ms: number; outcome: string; status: string; errorCode?: string; subtype?: string; sessionId?: string; documents: number; numTurns?: number; costUsd?: number }
  | { event: "bad_line"; pid: number; length: number };

export function openAgentLog(paths: AgentPaths): DaemonLog<AgentLogRecord> {
  const log = new DaemonLog<AgentLogRecord>(paths.log, paths.previousLog);
  log.enableRotation();
  return log;
}
