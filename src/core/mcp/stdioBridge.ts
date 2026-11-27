import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { isReadOnlyToolIn, readOnlyToolsResult } from "./readOnlyTools";
import { McpRpcClient, McpRpcError, RateLimitedError, type JsonRpcFailure, type JsonRpcRequest, type JsonRpcResponse } from "./rpcClient";

export interface StdioBridgeOptions {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  client: McpRpcClient;
  /**
   * ★읽기만 세션(Room 차례 — serve 가 브리지를 {@code --read-only} 로 띄운다) — 세 엔진 공통 보장은 여기 한 곳이다.
   * tools/list 는 읽기 도구(서버 {@code readOnlyHint === true})만 보이고, tools/call 은 부를 때마다 ★지금 서버 목록을 다시 읽어
   * 그 이름이 읽기 도구일 때만 서버로 보낸다(표시 없음 = 쓰기 = 막음 · 목록을 못 읽으면 보내지 않는다). 엔진별 인자는 겉옷이다.
   */
  readOnly?: boolean;
}

export async function runStdioBridge(options: StdioBridgeOptions): Promise<void> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let request: JsonRpcRequest;
    try {
      request = parseJsonRpcRequest(line);
    } catch (error) {
      // 요청을 못 읽었다 — 돌려줄 id 를 모르므로 JSON-RPC 규격대로 id null.
      writeLine(options.output, failure(null, error instanceof SyntaxError ? PARSE_ERROR : INVALID_REQUEST, error));
      continue;
    }
    try {
      if (request.method === "initialize") {
        // 호스트 에이전트의 고정 이름 — 이 세션의 모든 요청에 X-AiNecto-Agent 로 실린다(initialize 자신 포함).
        options.client.useAgent(clientInfoName(request.params));
      }
      if (options.readOnly && request.method === "tools/call") {
        const name = toolNameOf(request.params);
        if (!isReadOnlyToolIn(await options.client.request("tools/list", {}), name)) {
          // 서버에 보내지 않는다 — 호스트에는 «이 세션에 없는 도구»(MCP 규격의 모르는 도구 = invalid params) · 오류 출력에 한 줄.
          options.errorOutput.write(`read-only session refused tools/call ${JSON.stringify(name)}\n`);
          if (request.id !== undefined) writeLine(options.output, readOnlyRefusal(request.id, name));
          continue;
        }
      }
      const response = await options.client.sendRaw(request);
      if (response && request.id !== undefined) {
        writeLine(options.output, options.readOnly && request.method === "tools/list" && "result" in response
          ? { ...response, result: readOnlyToolsResult(response.result) }
          : response);
      }
    } catch (error) {
      // ★실패도 원래 요청 id 로 답한다 — id null 이면 호스트가 그 요청(특히 initialize)의 답을 영영 기다린다
      //   (V239 의 400 AGENT_NAME_INVALID · 409 AGENT_LIMIT 에서 실측). 알림(id 없음)에는 답하지 않는다(규격) — 오류 출력에 한 줄.
      if (request.id === undefined) {
        options.errorOutput.write(`${errorMessage(error)}\n`);
        continue;
      }
      // 호출 상한은 서버의 JSON-RPC 429 와 같은 코드로 — 호스트가 «내부 오류»로 읽지 않게(대기는 data.retryAfterSeconds).
      writeLine(options.output, failure(request.id, error instanceof RateLimitedError ? RATE_LIMITED_CODE : INTERNAL_ERROR, error));
    }
  }
}

/** JSON-RPC 2.0 오류 코드. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** 서버가 도구 안 호출 상한에 쓰는 JSON-RPC 코드와 같다. */
const RATE_LIMITED_CODE = 429;

/**
 * 실패 응답 — {@code message} 는 사람이 읽을 한 줄(서버가 밝힌 {@code CODE: 설명} 포함), {@code data} 는 기계가 가를 칸:
 * {@code code}(MCP_HTTP_ERROR 등) + 세부({@code status}·서버 오류 코드 {@code error}).
 */
function failure(id: string | number | null, code: number, error: unknown): JsonRpcFailure {
  const data = error instanceof McpRpcError
    ? { code: error.code, ...(isRecord(error.details) ? error.details : {}) }
    : undefined;
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message: errorMessage(error), ...(data ? { data } : {}) },
  };
}

/** 읽기만 세션이 막은 호출의 답 — 모델이 읽고 «무엇을 바꿔야 하는지 말하기»로 돌아가게 이유를 한 줄로. */
function readOnlyRefusal(id: string | number | null, name: string): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: INVALID_PARAMS, message: `Tool ${JSON.stringify(name)} is not available here: this session can only read AiNecto `
      + "(project room), and AiNecto does not mark this tool as read-only. Say what should be changed instead." },
  };
}

function toolNameOf(params: unknown): string {
  return isRecord(params) && typeof params.name === "string" ? params.name : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeLine(output: Writable, message: JsonRpcResponse): void {
  output.write(`${JSON.stringify(message)}\n`);
}

function parseJsonRpcRequest(line: string): JsonRpcRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
    throw new Error("Invalid JSON-RPC request.");
  }
  return {
    jsonrpc: "2.0",
    id: typeof parsed.id === "string" || typeof parsed.id === "number" || parsed.id === null ? parsed.id : undefined,
    method: parsed.method,
    params: parsed.params,
  };
}

function clientInfoName(params: unknown): unknown {
  return isRecord(params) && isRecord(params.clientInfo) ? params.clientInfo.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
