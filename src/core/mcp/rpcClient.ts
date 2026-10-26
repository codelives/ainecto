import type { TokenProvider } from "../auth/oauth";
import { LEGACY_ROLE_HEADER } from "../harness/legacyRole";
import { CLI_VERSION, PACKAGE_NAME } from "../version";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id?: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: "2.0";
  id?: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * 분석용 요청 헤더(GA4 서버 계측 C23). 서버의 ExecutionChannel.HEADER · AgentTypeResolver.HEADER 와 같아야 한다.
 * 서버는 /mcp 필터에서 한 번만 읽고, 모르는 값이면 요청을 막지 않는다(분석 값일 뿐이다).
 */
export const CHANNEL_HEADER = "X-AiNecto-Channel";
export const AGENT_HEADER = "X-AiNecto-Agent";
/**
 * 에이전트 «이름»(ainecto-root·tester 같은 고정 일꾼) — {@link AGENT_HEADER}(에이전트 «종류»)와 다른 사실이다.
 * 서버 명부가 사람 밑에 이 이름으로 올린다. 이름 규칙의 진실원은 서버다 — 여기서는 앞뒤 공백만 걷어 싣는다.
 * ★이 문자열은 이곳 하나 — {@code .mcp.json}·{@code .codex/config.toml} 에 쓰는 헤더 이름도 이것을 쓴다.
 */
export const AGENT_NAME_HEADER = "X-AiNecto-Agent-Name";
/** 서버 AgentTypeResolver.MAX_NAME_LENGTH 와 같다. */
export const MAX_AGENT_NAME_LENGTH = 100;

/** 이 클라이언트가 서버에 밝히는 길 — 직접 명령(`ainecto tools call …`) = cli, 에이전트의 MCP 브리지 = mcp. */
export type ExecutionChannel = "cli" | "mcp";

export interface McpRpcClientOptions {
  endpoint: string;
  tokenProvider?: TokenProvider;
  fetchImpl?: typeof fetch;
  envVars?: NodeJS.ProcessEnv;
  /**
   * 옛 {@code --role}/{@code AINECTO_ROLE} 값 — ★기록용이다(legacyRole.ts). 있으면 모든 요청의
   * {@code X-AiNecto-Role} 헤더로 실리고, 서버는 판정에 쓰지 않고 로그로만 남긴다.
   */
  legacyRole?: string;
  /**
   * 요청의 길. ★필수다 — 빠뜨리면 서버가 직접 명령을 MCP 로 센다. 그 빠뜨림을 타입이 잡는다.
   * 모든 요청의 {@code X-AiNecto-Channel} 헤더로 실린다.
   */
  channel: ExecutionChannel;
  /**
   * 이 폴더의 에이전트 이름(브리지 {@code --agent} 또는 {@code .ainecto/agent.local}). 있으면 모든 요청의
   * {@link AGENT_NAME_HEADER} 로 실린다. 없으면 이름 없는 연결 — 지금과 같다.
   */
  agentName?: string;
}

export class McpRpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class McpRpcClient {
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;
  private agent: string | undefined;

  constructor(private readonly options: McpRpcClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * 브리지 전용 — 호스트 에이전트가 보낸 {@code initialize} 의 {@code clientInfo.name}(프로그램 고정 이름).
   * 이후 모든 요청의 {@code X-AiNecto-Agent} 헤더로 싣는다. 직접 명령은 부르지 않는다(누가 셸을 돌렸는지 모른다).
   */
  useAgent(clientName: unknown): void {
    this.agent = agentHeaderValue(clientName);
  }

  initialize(): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: PACKAGE_NAME, version: CLI_VERSION },
    });
  }

  async toolsList(): Promise<unknown[]> {
    const result = await this.request("tools/list", {});
    if (!isRecord(result) || !Array.isArray(result.tools)) {
      throw new McpRpcError("tools/list response did not include a tools array.", "MCP_PROTOCOL_ERROR", result);
    }
    return result.tools;
  }

  async toolsCall(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args ?? {} });
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const response = await this.sendRaw({
      jsonrpc: "2.0",
      id: this.nextId++,
      method,
      params,
    });
    if (!response) {
      return undefined;
    }
    if ("error" in response) {
      throw new McpRpcError(response.error.message, "MCP_ERROR", response.error);
    }
    return response.result;
  }

  async sendRaw(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const token = await this.options.tokenProvider?.getAccessToken();
    let response = await this.postJson(request, token);
    if (response.status === 401 && this.options.tokenProvider) {
      const refreshed = await this.options.tokenProvider.refreshAfterUnauthorized();
      if (refreshed) {
        response = await this.postJson(request, refreshed);
      }
    }

    if (response.status === 204 || response.status === 202) {
      return undefined;
    }
    const text = await response.text();
    if (!response.ok) {
      // ★서버가 이유를 말했으면({@code {"error","error_description"}}) 그 한 줄을 그대로 보여 준다 — 틀린 에이전트
      //   이름(AGENT_NAME_INVALID)·상한(AGENT_LIMIT)은 사람이 설정을 고쳐야 하는 오류라 상태 코드만으로는 못 고친다.
      const serverError = parseServerError(text);
      throw new McpRpcError(
        `MCP HTTP request failed with HTTP ${response.status}${serverError ? ` — ${describeServerError(serverError)}` : "."}`,
        "MCP_HTTP_ERROR",
        { ...httpErrorDetails(response.status, text, this.options.envVars ?? process.env), ...(serverError ? { error: serverError.error } : {}) },
      );
    }
    if (!text.trim()) {
      return undefined;
    }
    const parsed = JSON.parse(text) as unknown;
    if (!isJsonRpcResponse(parsed)) {
      throw new McpRpcError("MCP response was not a JSON-RPC response.", "MCP_PROTOCOL_ERROR", parsed);
    }
    return parsed;
  }

  private postJson(request: JsonRpcRequest, token: string | undefined): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    const legacyRole = printableHeaderValue(this.options.legacyRole);
    if (legacyRole) {
      headers[LEGACY_ROLE_HEADER.toLowerCase()] = legacyRole;
    }
    headers[CHANNEL_HEADER.toLowerCase()] = this.options.channel;
    if (this.agent) {
      headers[AGENT_HEADER.toLowerCase()] = this.agent;
    }
    if (this.options.agentName) {
      headers[AGENT_NAME_HEADER.toLowerCase()] = this.options.agentName;
    }
    return this.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
  }
}

/**
 * ★MCP 는 «도구가 거부/실패했다»를 JSON-RPC error 가 아니라 결과 안의 {@code isError} 로
 * 알린다(2025-06-18 규격). 그래서 최상위 error 만 보면 실패가 성공으로 보고된다 —
 * 셸 자동화는 exit 0 을 받고 다음 단계로 간다(2026-09-22 독립 리뷰 I9).
 */
export function isToolError(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

/**
 * 헤더에 실을 수 있는 이름 — 인쇄 가능한 ASCII 만(그 밖의 글자는 fetch 가 헤더로 거절한다), 앞뒤 공백 제거,
 * 최대 {@link MAX_AGENT_NAME_LENGTH}자. 남는 것이 없으면 싣지 않는다(서버는 unknown 으로 센다).
 */
export function agentHeaderValue(clientName: unknown): string | undefined {
  return printableHeaderValue(clientName);
}

/** 헤더에 실을 수 있는 모양으로 — 규칙은 {@link agentHeaderValue} 와 같다(이 파일의 헤더 값은 전부 이 길을 지난다). */
function printableHeaderValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const printable = value.replace(/[^\x20-\x7E]/g, "").trim().slice(0, MAX_AGENT_NAME_LENGTH).trim();
  return printable || undefined;
}

/** 서버의 HTTP 오류 본문 — {@code {"error":"AGENT_NAME_INVALID","error_description":"…"}} 꼴(OAuth 오류와 같은 모양). */
export interface ServerError {
  error: string;
  description?: string;
}

/** HTTP 오류 본문에서 서버가 밝힌 오류. 그 꼴이 아니면 undefined. */
export function parseServerError(body: string): ServerError | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.error !== "string" || !parsed.error.trim()) {
    return undefined;
  }
  return {
    error: parsed.error.trim(),
    description: typeof parsed.error_description === "string" && parsed.error_description.trim()
      ? parsed.error_description
      : undefined,
  };
}

/** 사람이 읽을 한 줄 — {@code CODE: 설명}. 줄바꿈은 공백으로 접는다. */
export function describeServerError(serverError: ServerError): string {
  const line = serverError.description ? `${serverError.error}: ${serverError.description}` : serverError.error;
  return line.replace(/\s+/g, " ").trim();
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value)
    && value.jsonrpc === "2.0"
    && ("result" in value || "error" in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpErrorDetails(status: number, body: string, envVars: NodeJS.ProcessEnv): Record<string, unknown> {
  const details: Record<string, unknown> = { status };
  if (envVars.AINECTO_CLI_DEBUG === "1" || envVars.AINECTO_DEBUG === "1") {
    details.body = safeBodyPreview(body);
  }
  return details;
}

export function safeBodyPreview(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}...` : body;
}
