import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { runStdioBridge } from "../../core/mcp/stdioBridge";
import type { Readable, Writable } from "node:stream";

export interface ConnectorOptions {
  endpoint: string;
  input: Readable;
  output: Writable;
  errorOutput: Writable;
}

export async function runConnector(options: ConnectorOptions): Promise<void> {
  const tokenStore = new FileTokenStore();
  const auth = new OAuthClient({ endpoint: options.endpoint, tokenStore });
  const client = new McpRpcClient({ endpoint: options.endpoint, tokenProvider: auth });
  await runStdioBridge({
    input: options.input,
    output: options.output,
    errorOutput: options.errorOutput,
    client,
  });
}
