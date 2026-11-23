import { DaemonLog } from "../term/daemonLog";
import type { AgentPaths } from "./paths";

/**
 * `agent.log` 레코드(설계 K6). ★서버 호출은 {@code agent_call} 요청 1줄 + {@code agent_call_response} 응답 1줄(같은 callId),
 * Agent 한 차례는 {@code agent_request} + {@code agent_response}(같은 turnUuid), Codex JSON-RPC 는 {@code agent_rpc} + {@code agent_rpc_response}
 * (같은 pid·id), 서버 MCP 도구는 {@code agent_call}·{@code agent_call_response} 의 {@code op: "tool"}, 준비 확인은 {@code agent_probe} + {@code agent_probe_response}(같은 callId). 실패해도 응답 줄은 반드시 — 이유 포함.
 * ★남기지 않는 것: 요청 글·답 글·토큰·계정 식별값(이메일 등)(길이·수만).
 */
export type AgentLogRecord =
  | { event: "serve_start"; pid: number; version: string; endpoint: string; host: string;
      agents: Array<{ id: string; installed: boolean; ready: boolean; auth?: string; version?: string }> }
  | { event: "serve_stop"; pid: number; reason: string }
  /** {@code op: "tool"} = 서버 MCP 도구(tools.ts) — {@code tool} 은 앞머리 없는 도구 이름. */
  | { event: "agent_call"; callId: string; op: string; tool?: string; agent?: string; agentName?: string; turnUuid?: string; bytes: number }
  | { event: "agent_call_response"; callId: string; op: string; tool?: string; ok: boolean; status?: number; code?: string; error?: string; ms: number; offers?: number }
  | { event: "agent_probe"; callId: string; agent: string; probe: "detect" | "auth" }
  | { event: "agent_probe_response"; callId: string; agent: string; probe: "detect" | "auth"; ok: boolean; installed?: boolean;
      version?: string; ready?: boolean; mode?: string; method?: string; plan?: string; detail?: string; ms: number }
  | { event: "offer"; turnUuid: string; conversationUuid: string; agent: string; duplicate: boolean }
  | { event: "stop_request"; turnUuid: string; running: boolean; queued: boolean }
  | { event: "open_without_features"; features: string[] }
  /** 서버가 이 link 를 잊었다(api 재시작 — link 는 서버 메모리) → 같은 프로세스에서 다시 열었다. */
  | { event: "agent_reopened"; reason: string; previousLinkId: string; linkId: string; attempts: number }
  | { event: "process_start"; pid: number; agent: string; conversationUuid: string; resume: boolean }
  | { event: "process_exit"; pid: number; agent: string; conversationUuid: string; code: number | null; signal: string | null }
  /** stdin 을 닫아도 안 끝나 강제로 껐다(launch.ts killTree) — 직계가 끝났는지 · 트리(Windows taskkill /T) 결과. */
  | { event: "process_kill"; pid: number; agent: string; directExited: boolean; tree: string; detail?: string }
  | { event: "agent_rpc"; pid: number; agent: string; id: number; method: string }
  | { event: "agent_rpc_response"; pid: number; agent: string; id: number; method: string; ok: boolean; error?: string; ms: number }
  /** Agent 가 우리에게 물어 온 것(승인 등) — 묻지 않는 설정이라 오면 거절하고 남긴다. */
  | { event: "agent_server_request"; pid: number; agent: string; method: string; answer: string }
  /** Codex 가 띄운 MCP 서버 상태 — AiNecto 밖의 서버(사용자 기본 설정)도 뜨는지 여기서 본다. */
  | { event: "agent_mcp_server"; pid: number; agent: string; name: string; status: string; error?: string }
  /** Codex: 이 대화에서 끈 사용자 설정의 MCP 서버 이름. */
  | { event: "agent_mcp_servers_off"; pid: number; agent: string; names: string[] }
  /** Claude: 이 프로세스가 실제로 무엇으로 도는지(init 의 출처 이름 — 구독이면 none). 키 값은 남기지 않는다. */
  | { event: "agent_auth_source"; pid: number; agent: string; apiKeySource: string }
  /** Antigravity: 차례를 돌리지 않았다 — 이 PC 의 agy 설정을 다 확인하지 못했다(설계 r3 §2-2). 설정 내용은 싣지 않는다(이유·경로만). */
  | { event: "agent_policy_unverified"; agent: string; conversationUuid: string; reason: string; path?: string }
  /** Antigravity: 거절했어야 할 브리지 밖 서버의 도구가 실제로 돌았다(사후 대조) — 그 차례는 실패. 서버·도구 이름만. */
  | { event: "agent_policy_violation"; pid: number; agent: string; conversationUuid: string; server: string; tool: string }
  /** Antigravity: 앞 차례 agy -p 를 끄지 못해 이번 차례를 돌리지 않았다(그 pid 들). */
  | { event: "agent_previous_running"; agent: string; conversationUuid: string; pids: number[] }
  /** 설치된 판이 검증한 판과 다르다 — 막지 않고 알린다. */
  | { event: "agent_version_unverified"; agent: string; version: string; verified: string }
  /** Antigravity: 한 차례의 토큰 수(비용 칸이 없다 — 로그로만). */
  | { event: "agent_usage"; pid: number; agent: string; conversationUuid: string; inputTokens?: number; outputTokens?: number }
  /** Agent 한 차례 — Chat 요청은 {@code turnUuid}, 에이전트 할 일(자동 실행)은 {@code todoId}. */
  | { event: "agent_request"; turnUuid?: string; todoId?: string; agent: string; conversationUuid: string; pid: number; textLength: number }
  | { event: "agent_response"; turnUuid?: string; todoId?: string; agent: string; ms: number; outcome: string; status: string; errorCode?: string; subtype?: string;
      sessionId?: string; documents: number; createdDocuments: number; foundDocuments: number; cards: number; numTurns?: number; costUsd?: number }
  | { event: "bad_line"; pid: number; agent: string; length: number }
  /** 에이전트 할 일 한 건 처리(todoRun.ts) — 시작 1줄 + 끝 1줄(같은 todoId). 끝 줄은 실패해도 반드시(실패한 도구·코드). */
  | { event: "todo_run"; todoId: string; kind: string; cardUuid: string }
  | { event: "todo_run_result"; todoId: string; kind: string; cardUuid: string; outcome: string; warning?: string; tool?: string; code?: string;
      workId?: string; conversationUuid?: string; runDropped?: boolean; ms: number }
  /** runs.json 읽기 — 없음(missing)·깨짐(unreadable → 비움)도 이 한 줄. */
  | { event: "runs_load"; entries: number; reason?: string }
  /** 가져간 할 일의 임대 — 연장 실패·놓기 등(도구 호출 줄과 별개로, serve 가 그 결과로 무엇을 했나). */
  | { event: "todo_lease"; todoId: string; action: string; ok: boolean; error?: string; next?: string }
  /**
   * 자동 업그레이드(KAN-738 next.10) — pc run 이 도우미를 띄움(launch) · 도우미의 시작·끝·실패(어느 단계·사유·되돌림)·거절(증명 없음·
   * workflow 다름·audit 실패). 도우미가 부르는 바깥 명령·registry 는 upgrade_call 1줄 + upgrade_call_response 1줄(같은 callId).
   */
  | { event: "upgrade_launch"; from: string; to: string; pid?: number; error?: string }
  | { event: "upgrade_start"; from: string; to: string }
  | { event: "upgrade_call"; callId: string; step: string; command: string }
  | { event: "upgrade_call_response"; callId: string; step: string; ok: boolean; exitCode?: number | null; ms: number; detail?: string }
  | { event: "upgrade_done"; from: string; to: string; ms: number }
  | { event: "upgrade_failed"; from: string; to: string; step: string; reason: string; rolledBack?: boolean }
  | { event: "upgrade_refused"; from: string; to: string; reason: string; detail?: string };

export function openAgentLog(paths: AgentPaths): DaemonLog<AgentLogRecord> {
  const log = new DaemonLog<AgentLogRecord>(paths.log, paths.previousLog);
  log.enableRotation();
  return log;
}

/** serve_stop 사유 — Claude Code·Codex 가 둘 다 없어 Agent 부분을 시작하지 않았다. */
export const NO_AGENTS_REASON = "no_agents";

/** agent.log 글을 끝에서부터 — 받아들인 첫 레코드. 쓰다 만 줄(회전·동시 쓰기)은 건너뛴다. 순수 함수. */
type LoggedRecord = { event?: unknown; ts?: unknown; reason?: unknown; from?: unknown; to?: unknown };

function lastRecord<T>(text: string, accept: (record: LoggedRecord) => T | undefined): T | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{")) continue;
    let record: LoggedRecord;
    try {
      record = JSON.parse(line) as LoggedRecord;
    } catch {
      continue;
    }
    const accepted = accept(record);
    if (accepted !== undefined) return accepted;
  }
  return undefined;
}

/** agent.log 글 → 마지막 serve_stop(언제·사유) — `ainecto status` 가 «왜 끊겼나»를 보인다. 없으면 undefined. 순수 함수. */
export function lastServeStop(text: string): { at: string; reason: string } | undefined {
  return lastRecord(text, (record) => record.event === "serve_stop" && typeof record.reason === "string"
    ? { at: typeof record.ts === "string" ? record.ts : "", reason: record.reason }
    : undefined);
}

/** 자동 업그레이드 결과 — agent.log 의 갈아타기 끝 이벤트 → `ainecto status` 의 한 줄. */
export const UPGRADE_RESULTS = { upgrade_done: "upgraded", upgrade_failed: "failed", upgrade_refused: "refused" } as const;

export interface LastUpgrade {
  at: string;
  result: (typeof UPGRADE_RESULTS)[keyof typeof UPGRADE_RESULTS];
  from: string;
  to: string;
  reason?: string;
}

/** agent.log 글 → 마지막 갈아타기(끝·실패·거절). 없으면 undefined. 순수 함수. */
export function lastUpgrade(text: string): LastUpgrade | undefined {
  return lastRecord(text, (record) => {
    const event = record.event;
    if (event !== "upgrade_done" && event !== "upgrade_failed" && event !== "upgrade_refused") return undefined;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    return {
      at: text(record.ts), result: UPGRADE_RESULTS[event], from: text(record.from), to: text(record.to),
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
    };
  });
}

/** 이번 pc 실행에 Agent 가 없나 — 마지막 serve 기록(serve_start·serve_stop)이 «no_agents» 로 멈춘 것인가. 순수 함수. */
export function agentMissing(text: string): boolean {
  return lastRecord(text, (record) => record.event === "serve_start" || record.event === "serve_stop"
    ? record.event === "serve_stop" && record.reason === NO_AGENTS_REASON
    : undefined) ?? false;
}
