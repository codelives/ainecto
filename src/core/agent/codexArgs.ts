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
 *   <li>{@link FEATURES_OFF} — 내장 셸·플러그인·앱·컴퓨터/브라우저 조작·이미지 생성을 끈다.</li>
 *   <li>사용자 설정의 다른 MCP 서버는 thread/start·resume 의 {@code config} 로 끈다({@link codexOtherMcpServersOff}).</li>
 * </ul>
 * 실측(2026-11-13, 증적 {@code evidence/kan1075/codex-mcp-close/}, 모델 호출 0): 끄기 전에는 AiNecto 말고 cua_repl·node_repl·
 * codex_apps·openaiDeveloperDocs 가 떴고, 끈 뒤에는 AiNecto 만 떴다. {@code codex debug prompt-input} 의 도구 목록에서
 * exec_command·write_stdin·cua_repl·request_plugin_install 이 빠졌다.
 * ★못 막은 것: 하위 Agent 도구(collaboration/spawn_agent 등)를 끄는 설정은 찾지 못했다 — 하위 Agent 는 같은 설정을 물려받는다고 보지만
 * 재지 않았다. apply_patch(파일 쓰기)는 목록에 남지만 read-only 샌드박스가 막는다.
 */

export const CODEX = "codex";

/** 스레드·차례 정책 — 프로세스 설정과 같은 값을 thread/start·thread/resume 에도 싣는다(실측 그대로). */
const THREAD_POLICY = { approvalPolicy: "never", sandbox: "read-only" } as const;

/** {@code -c key=value} 의 key 에 넣어도 되는 도구 이름(점·따옴표가 없는 것). 서버 도구 이름은 모두 이 꼴이다. */
const CONFIG_KEY_PART = /^[A-Za-z0-9_-]+$/;

/** 끄는 Codex 기능 — 이름은 {@code codex features list} 그대로. 셸은 shell_tool, cua_repl 같은 플러그인 MCP 는 plugins 로 꺼진다(실측). */
const FEATURES_OFF = ["shell_tool", "plugins", "apps", "computer_use", "browser_use", "image_generation"] as const;

export function codexAppServerArgs(bridge: AinectoBridge, writeTools: Iterable<string>): string[] {
  const server = `mcp_servers.${AINECTO_MCP_SERVER}`;
  const config = [
    `${server}.command=${tomlString(bridge.command)}`,
    `${server}.args=[${bridge.args.map(tomlString).join(",")}]`,
    'approval_policy="never"',
    'sandbox_mode="read-only"',
    ...FEATURES_OFF.map((feature) => `features.${feature}=false`),
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

/**
 * {@code config/read} 결과의 {@code config} → AiNecto 말고 사용자 설정에 있는 MCP 서버를 모두 끄는 덮어쓰기(순수 함수).
 * 점 표기 키({@code mcp_servers.<이름>.enabled})만 듣는다(실측: 중첩 표기는 AiNecto 까지 안 떴다).
 * ★설정 키로 못 쓰는 이름(점·따옴표 등)이 있으면 그 서버를 끌 수 없으므로 오류 — 세션을 시작하지 않는다.
 */
export function codexOtherMcpServersOff(config: unknown): { names: string[]; config: Record<string, boolean> } {
  const servers = config && typeof config === "object" ? (config as { mcp_servers?: unknown }).mcp_servers : undefined;
  const names = servers && typeof servers === "object" ? Object.keys(servers).filter((name) => name !== AINECTO_MCP_SERVER).sort() : [];
  const bad = names.filter((name) => !CONFIG_KEY_PART.test(name));
  if (bad.length > 0) throw new Error(`cannot turn off Codex MCP server(s) ${bad.map((name) => JSON.stringify(name)).join(", ")}`);
  return { names, config: Object.fromEntries(names.map((name) => [`mcp_servers.${name}.enabled`, false] as const)) };
}

export function codexThreadStartParams(cwd: string, serversOff: Record<string, boolean>): Record<string, unknown> {
  return { cwd, ...THREAD_POLICY, config: serversOff };
}

/** {@code excludeTurns} — 지난 차례를 통째로 돌려받지 않는다(서버가 «full-history hydration is deprecated» 를 알렸다). */
export function codexThreadResumeParams(threadId: string, cwd: string, serversOff: Record<string, boolean>): Record<string, unknown> {
  return { threadId, cwd, ...THREAD_POLICY, config: serversOff, excludeTurns: true };
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
  if (account) return { ready: true, mode: method === "apiKey" ? "apiKey" : "subscription", method, plan };
  if (result.requiresOpenaiAuth === false) return { ready: true, method: "none-required" };
  return { ready: false, detail: "not signed in with an API key or ChatGPT (run `codex login`, or `codex login --with-api-key`)" };
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
