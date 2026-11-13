import { AINECTO_MCP_SERVER, type AgentAuthStatus, type AgentTurnResult, type AinectoBridge } from "./agents";

/**
 * ★Codex app-server 고정 설정 — 한 곳(순수 함수). 실측(2026-11-12, 증적 `.role/claude-dev/evidence/kan1075/three-agents/`
 * {@code run_three.py} CODEX_CFG · {@code summary.md})에서 문서 조회·생성·수정·카드 생성·변경·{@code thread/resume} 이 된 그대로다.
 *
 * <ul>
 *   <li>AiNecto MCP = 이 CLI 브리지({@code -c mcp_servers.ainecto.*}).</li>
 *   <li>{@code approval_policy="never"} — 묻지 않는다. 승인이 필요한 일은 묻지 않고 거절된다(실측: 쓰기 도구도 거절 → 아래 도구별 승인).</li>
 *   <li>{@code sandbox_mode="read-only"} — 명령 실행은 읽기만(파일 쓰기·네트워크 막힘).</li>
 *   <li>쓰기 도구마다 {@code tools.<이름>.approval_mode="approve"} — 서버 readOnlyHint 가 진실원({@code writeToolNames}).</li>
 * </ul>
 * ★막지 못한 것(실측·확인 범위 밖): 내장 셸 도구 자체를 끄는 설정, 사용자 기본 설정의 다른 MCP 서버·플러그인을 닫는 설정.
 * 읽기 전용 셸 명령(파일 읽기)은 돈다. 다른 MCP 서버는 {@code agent_mcp_server} 로그 줄로 보인다.
 */

export const CODEX = "codex";

/** 스레드·차례 정책 — 프로세스 설정과 같은 값을 thread/start·thread/resume 에도 싣는다(실측 그대로). */
const THREAD_POLICY = { approvalPolicy: "never", sandbox: "read-only" } as const;

/** {@code -c key=value} 의 key 에 넣어도 되는 도구 이름(점·따옴표가 없는 것). 서버 도구 이름은 모두 이 꼴이다. */
const CONFIG_KEY_PART = /^[A-Za-z0-9_-]+$/;

export function codexAppServerArgs(bridge: AinectoBridge, writeTools: Iterable<string>): string[] {
  const server = `mcp_servers.${AINECTO_MCP_SERVER}`;
  const config = [
    `${server}.command=${tomlString(bridge.command)}`,
    `${server}.args=[${bridge.args.map(tomlString).join(",")}]`,
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    ...[...writeTools].filter((tool) => CONFIG_KEY_PART.test(tool)).sort()
      .map((tool) => `${server}.tools.${tool}.approval_mode="approve"`),
  ];
  return ["app-server", ...config.flatMap((entry) => ["-c", entry])];
}

/** TOML 기본 문자열 — JSON 문자열 표기는 TOML 기본 문자열로도 읽힌다(\" \\ \uXXXX). */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function codexInitializeParams(clientVersion: string): Record<string, unknown> {
  return { clientInfo: { name: "ainecto-cli", title: "AiNecto CLI", version: clientVersion } };
}

export function codexThreadStartParams(cwd: string): Record<string, unknown> {
  return { cwd, ...THREAD_POLICY };
}

/** {@code excludeTurns} — 지난 차례를 통째로 돌려받지 않는다(서버가 «full-history hydration is deprecated» 를 알렸다). */
export function codexThreadResumeParams(threadId: string, cwd: string): Record<string, unknown> {
  return { threadId, cwd, ...THREAD_POLICY, excludeTurns: true };
}

export function codexTurnStartParams(threadId: string, text: string, outputSchema: Record<string, unknown>): Record<string, unknown> {
  return { threadId, input: [{ type: "text", text }], outputSchema };
}

/**
 * Codex 가 우리에게 묻는 것(서버→클라이언트 요청)에 대한 답 — ★전부 거절. 묻지 않는 설정이라 오지 않아야 하지만,
 * 오면 기다리게 두지 않는다(헤드리스에서 묻기 = 멈춤). 답 모양은 {@code codex app-server generate-json-schema} 그대로.
 */
export function codexServerRequestAnswer(method: string): { result: Record<string, unknown> } | { error: { code: number; message: string } } {
  switch (method) {
    case "mcpServer/elicitation/request":
      return { result: { action: "decline" } };
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { result: { decision: "decline" } };
    case "applyPatchApproval":
    case "execCommandApproval":
      return { result: { decision: "denied" } };
    default:
      return { error: { code: -32601, message: `ainecto agent serve does not answer ${method}` } };
  }
}

/** {@code account/read} 결과 → 준비 여부(순수 함수). 계정이 있거나, OpenAI 로그인이 필요 없는 설정이면 준비됨. */
export function codexAuthFromAccount(result: Record<string, unknown>): AgentAuthStatus {
  const account = result.account && typeof result.account === "object" ? (result.account as Record<string, unknown>) : undefined;
  const method = typeof account?.type === "string" ? account.type : undefined;
  const plan = typeof account?.planType === "string" ? account.planType : undefined;
  if (account) return { ready: true, method, plan };
  if (result.requiresOpenaiAuth === false) return { ready: true, method: "none-required" };
  return { ready: false, detail: "not signed in (run `codex login`)" };
}

/**
 * {@code turn/completed} 의 turn + 마지막 답 글 → 공통 결과(순수 함수). ★Codex 는 답 글 자체가 schema JSON 이다 —
 * JSON 으로 읽히면 그 값을, 아니면 원문을 싣는다(판정은 {@code replyForOutcome} 한 곳).
 */
export function codexTurnResult(turn: Record<string, unknown>, lastMessage: string | undefined): AgentTurnResult {
  const status = typeof turn.status === "string" ? turn.status : "unknown";
  const text = lastMessage ?? lastAgentMessageIn(turn.items);
  if (status !== "completed") {
    return { subtype: status, isError: true, resultText: errorMessage(turn.error) ?? text };
  }
  if (text === undefined) return { subtype: status, isError: false };
  try {
    return { subtype: status, isError: false, structuredOutput: JSON.parse(text) as unknown };
  } catch {
    return { subtype: status, isError: false, resultText: text };
  }
}

function lastAgentMessageIn(items: unknown): string | undefined {
  if (!Array.isArray(items)) return undefined;
  let text: string | undefined;
  for (const item of items as Array<Record<string, unknown> | null>) {
    if (item?.type === "agentMessage" && typeof item.text === "string") text = item.text;
  }
  return text;
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return JSON.stringify(error);
}
