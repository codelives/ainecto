#!/usr/bin/env node
import { resolveEndpoint } from "../core/config/endpoints";
import { runConnector } from "../adapters/mcp/connector";
import { renderError } from "../core/output/render";
import { parseMcpArgs } from "../adapters/mcp/args";

try {
  const args = parseMcpArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: mcp [--env prod|dev] [--endpoint URL]\n");
    process.exit(0);
  }
  const resolved = resolveEndpoint({ env: args.env, endpoint: args.endpoint });
  await runConnector({
    endpoint: resolved.endpoint,
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
  });
} catch (error) {
  process.stderr.write(renderError(error));
  process.exitCode = 1;
}
