import type { TokenProvider } from "../auth/oauth";

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

export interface McpRpcClientOptions {
  endpoint: string;
  tokenProvider?: TokenProvider;
  fetchImpl?: typeof fetch;
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

  constructor(private readonly options: McpRpcClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  initialize(): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "@ainecto/mcp", version: "0.1.0" },
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
      throw new McpRpcError(`MCP HTTP request failed with HTTP ${response.status}.`, "MCP_HTTP_ERROR", {
        status: response.status,
        body: safeBodyPreview(text),
      });
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
    return this.fetchImpl(this.options.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
    });
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value)
    && value.jsonrpc === "2.0"
    && ("result" in value || "error" in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeBodyPreview(body: string): string {
  return body.length > 500 ? `${body.slice(0, 500)}...` : body;
}
