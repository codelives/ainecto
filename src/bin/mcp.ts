#!/usr/bin/env node
import { resolveEndpoint } from "../core/config/endpoints";
import { runConnector } from "../adapters/mcp/connector";
import { renderError } from "../core/output/render";
import { parseMcpArgs } from "../adapters/mcp/args";
import { resolveRole, HARNESS_ROLES } from "../core/harness/role";

try {
  const args = parseMcpArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      `Usage: mcp [--env prod|dev] [--endpoint URL] [--role ${HARNESS_ROLES.join("|")}]\n`,
    );
    process.exit(0);
  }
  const resolved = resolveEndpoint({ env: args.env, endpoint: args.endpoint });
  // 플래그가 없으면 환경변수 — Codex 처럼 MCP 설정이 전역뿐인 에이전트를 위한 길이다.
  const resolvedRole = resolveRole({ role: args.role });
  await runConnector({
    endpoint: resolved.endpoint,
    role: resolvedRole.role ?? null,
    input: process.stdin,
    output: process.stdout,
    errorOutput: process.stderr,
  });
} catch (error) {
  process.stderr.write(renderError(error));
  process.exitCode = 1;
}
