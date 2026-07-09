#!/usr/bin/env node
import { resolveEndpoint, assertEnv } from "../core/config/endpoints";
import { runConnector } from "../adapters/mcp/connector";
import { renderError } from "../core/output/render";

try {
  const args = parseArgs(process.argv.slice(2));
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

function parseArgs(argv: string[]): { env?: "prod" | "dev"; endpoint?: string } {
  const result: { env?: "prod" | "dev"; endpoint?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      result.env = assertEnv(argv[++index]);
    } else if (arg === "--endpoint") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--endpoint requires a value.");
      }
      result.endpoint = value;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write("Usage: mcp [--env prod|dev] [--endpoint URL]\n");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}
