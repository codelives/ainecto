import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { McpRpcClient, McpRpcError, type JsonRpcFailure, type JsonRpcRequest, type JsonRpcResponse } from "./rpcClient";

export interface StdioBridgeOptions {
  input: Readable;
  output: Writable;
  errorOutput: Writable;
  client: McpRpcClient;
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
      const response = await options.client.sendRaw(request);
      if (response && request.id !== undefined) {
        writeLine(options.output, response);
      }
    } catch (error) {
      // ★실패도 원래 요청 id 로 답한다 — id null 이면 호스트가 그 요청(특히 initialize)의 답을 영영 기다린다
      //   (V239 의 400 AGENT_NAME_INVALID · 409 AGENT_LIMIT 에서 실측). 알림(id 없음)에는 답하지 않는다(규격) — 오류 출력에 한 줄.
      if (request.id === undefined) {
        options.errorOutput.write(`${errorMessage(error)}\n`);
        continue;
      }
      writeLine(options.output, failure(request.id, INTERNAL_ERROR, error));
    }
  }
}

/** JSON-RPC 2.0 오류 코드. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

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
