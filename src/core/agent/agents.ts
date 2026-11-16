import type { WriteFacts } from "./documents";

/**
 * 내 PC Agent 의 공통 꼴(KAN-1075 단계 3, 증적 `.role/claude-dev/evidence/kan1075/three-agents/interface.md`).
 * ★Agent 종류는 여기 한 곳 — 서버 {@code AgentKind} 의 id 와 같은 글이다(선 위의 계약). 표시 이름은 이 PC 가 쓰는 안내 글에만 쓴다.
 *
 * <p>일곱 동작이 어디에 있는가:
 * <ol>
 *   <li>설치 감지 — {@link AgentAdapter.detect}</li>
 *   <li>인증 확인(모델 호출 0) — {@link AgentAdapter.authStatus}</li>
 *   <li>세션 시작·재개 — {@link AgentAdapter.open}({@code resumeRef} 가 있으면 재개)</li>
 *   <li>요청 전달 → 응답 반환(닫힌 schema 값) — {@link AgentSession.send}</li>
 *   <li>응답 스트리밍 — 세션 안에서 소비한다(쓰기 도구 결과의 문서·카드만 모은다). 서버로 조각을 보내는 길은 없다.</li>
 *   <li>권한 승인 — 묻지 않는다. 세션을 열 때 «AiNecto MCP 도구만 허용, 나머지는 묻지 않고 거절»로 고정한다.</li>
 *   <li>중단 — {@link AgentSession.interrupt}(그 차례만), 내리기는 {@link AgentSession.close}.</li>
 * </ol>
 */
export const AGENT_IDS = ["claude-code", "codex"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/**
 * 그 Agent 가 MCP {@code initialize} 에 싣는 {@code clientInfo.name} — 서버 {@code AgentTypeResolver} 표와 같은 글(선 위의 계약).
 * serve 가 그 Agent 를 대신해 부르는 도구(실행 대화 글)에 {@code X-AiNecto-Agent} 헤더로 싣는다(실제로 도는 Agent 종류를 서버가 안다).
 */
export const AGENT_MCP_CLIENT_NAMES: Readonly<Record<AgentId, string>> = { "claude-code": "claude-code", codex: "codex-mcp-client" };

/** 서버가 Agent 를 밝히지 않은 요청(옛 서버·옛 웹)은 이것 — 서버 {@code AgentKind.LEGACY_DEFAULT} 와 같다. */
export const DEFAULT_AGENT: AgentId = "claude-code";

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

/** Agent 한 차례 결과에서 쓰는 칸 — Claude {@code result} 이벤트 · Codex {@code turn/completed} 를 같은 꼴로. */
export interface AgentTurnResult {
  subtype?: string;
  isError: boolean;
  /** 닫힌 schema 값(Claude {@code structured_output} · Codex 마지막 답 글을 JSON 으로 읽은 것). */
  structuredOutput?: unknown;
  resultText?: string;
  numTurns?: number;
  costUsd?: number;
}

export type TurnOutcome =
  | { kind: "result"; result: AgentTurnResult; facts: WriteFacts }
  | { kind: "timeout" }
  | { kind: "exited"; code: number | null; signal: string | null; stderrTail: string };

/** Agent 가 무엇으로 인증해 도는가 — 과금 주체. 서버 연결 계약의 {@code auth} 칸과 같은 글이다. */
export type AgentAuthMode = "apiKey" | "subscription";

export interface AgentDetection {
  installed: boolean;
  version?: string;
  /** 설치되지 않았다고 본 이유(ENOENT·종료 코드 등). */
  detail?: string;
}

export interface AgentAuthStatus {
  /** 이 PC 에서 로그인까지 확인됨 — 서버 open 의 {@code ready}. */
  ready: boolean;
  /** 무엇으로 도는가 — 준비됐을 때만 있다. */
  mode?: AgentAuthMode;
  /** 로그인 방식(claude.ai · chatgpt · apiKey …) — 과금 주체를 가늠하는 값. 계정 식별값(이메일 등)은 담지 않는다. */
  method?: string;
  plan?: string;
  detail?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  /** 안내 글에 쓰는 제품 이름. */
  readonly displayName: string;
  detect(): Promise<AgentDetection>;
  authStatus(): Promise<AgentAuthStatus>;
  /**
   * 프로세스를 띄운다(동기). 재개할 세션이 있으면 {@code resumeRef}. 준비가 실패하면 첫 {@code send} 가 «exited» 로 답한다.
   * {@code agentName} = 이 세션의 AiNecto 브리지를 그 이름 붙은 에이전트로 붙인다(할 일 차례만 — Chat 차례는 이름 없는 연결).
   */
  open(input: { conversationUuid: string; resumeRef?: string; textMaxCharacters: number; agentName?: string }): AgentSession;
}

export interface AgentSession {
  readonly agent: AgentId;
  readonly conversationUuid: string;
  readonly resumed: boolean;
  readonly pid: number;
  readonly alive: boolean;
  /** 이 세션의 브리지가 붙은 이름 붙은 에이전트(없으면 이름 없는 연결). */
  readonly agentName: string | undefined;
  /** 저장해 두면 재개되는 값(Claude session_id · Codex threadId). 아직 모르면 undefined. */
  readonly sessionRef: string | undefined;
  /** 한 차례 — 기한 안에 끝나지 않으면 «timeout»(세션은 부른 쪽이 멈추고 내린다). */
  send(text: string, timeoutMs: number): Promise<TurnOutcome>;
  /** 진행 중인 차례만 멈춘다(세션은 살아 있다). 진행 중이 아니면 아무것도 하지 않는다. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** 답 schema(설계 1절) — 닫힌 schema. 두 Agent 가 같은 것을 쓴다. 문서는 모델 말이 아니라 쓰기 도구 결과에서 뽑는다. */
export function agentReplySchema(textMaxCharacters: number): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["reply"],
    properties: { reply: { type: "string", minLength: 1, maxLength: textMaxCharacters } },
  };
}

/** Agent 가 쓰는 MCP 서버 이름 — Claude 도구 이름 앞머리({@code mcp__ainecto__})와 Codex {@code mcp_servers.ainecto} 가 이것에서 나온다. */
export const AINECTO_MCP_SERVER = "ainecto";

/** Agent 에 붙이는 AiNecto MCP 서버 = 지금 돌고 있는 이 CLI 의 브리지(같은 node · 같은 스크립트 · 같은 서버 주소 · 같은 로그인). */
export interface AinectoBridge {
  command: string;
  args: string[];
}

/** @param agentName serve 의 이름 붙은 에이전트 — 있으면 브리지 {@code --agent} 로(Agent 의 도구 호출도 serve 와 같은 이름의 연결). */
export function ainectoBridge(nodePath: string, cliScript: string, endpoint: string, agentName?: string): AinectoBridge {
  return { command: nodePath, args: [cliScript, "--endpoint", endpoint, "mcp", ...(agentName ? ["--agent", agentName] : [])] };
}

/** Agent 에 넘기는 환경 — 브리지가 CLI 로그인만 쓰게 {@code AINECTO_TOKEN} 을 뺀다. */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.AINECTO_TOKEN;
  return out;
}
