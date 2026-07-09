import type { McpRpcClient } from "../../core/mcp/rpcClient";
import type { GeneratedToolDefinition, ToolPresentationEnrichment } from "../../core/catalog/types";
import { enrichments } from "../../core/catalog/enrichments";
import { getGeneratedTools } from "../../core/catalog";
import type { AinectoEnv } from "../../core/config/endpoints";
import { renderSuccess } from "../../core/output/render";
import { renderTable } from "../../core/output/table";
import { parseGeneratedCommandArgs } from "./flagParser";
import { confirmDestructiveCommand, type ConfirmationIO } from "./destructiveConfirmation";
import { BESPOKE_COMMAND_PATHS } from "./bespokeCommands";

export interface GeneratedCommandRoute {
  tool: GeneratedToolDefinition;
  matchedPath: string[];
  rest: string[];
  presentation?: ToolPresentationEnrichment;
  rawContractWarning?: string;
}

export interface GeneratedCommandExecutionOptions {
  env: AinectoEnv;
  argv: string[];
  client: McpRpcClient;
  json: boolean;
  io: ConfirmationIO & { stdout: NodeJS.WriteStream };
}

export function matchGeneratedCommand(env: AinectoEnv, argv: string[]): GeneratedCommandRoute | undefined {
  const commandTokens = argv.filter((arg) => !arg.startsWith("-"));
  const tools = getGeneratedTools(env);
  const entries = buildRouteEntries(tools, enrichments);
  const match = entries
    .filter((entry) => isPrefix(entry.path, commandTokens))
    .sort((a, b) => b.path.length - a.path.length)[0];

  if (!match) {
    return undefined;
  }

  const restStart = findRestStart(argv, match.path);
  return {
    tool: match.tool,
    matchedPath: match.path,
    rest: argv.slice(restStart),
    presentation: match.presentation,
    rawContractWarning: match.tool.payloadMode === "binary-upload"
      ? "This generated command uses the raw MCP argument contract only; local file upload semantics are not implemented here."
      : undefined,
  };
}

export async function executeGeneratedCommand(options: GeneratedCommandExecutionOptions): Promise<number> {
  const route = matchGeneratedCommand(options.env, options.argv);
  if (!route) {
    return 2;
  }

  const parsed = await parseGeneratedCommandArgs(route.tool, route.rest, options.io.stdin);
  await confirmDestructiveCommand({
    tool: route.tool,
    yes: parsed.yes,
    json: options.json,
    io: options.io,
  });

  const result = await options.client.toolsCall(route.tool.mcpName, parsed.args);
  const warnings = [...parsed.warnings, ...(route.rawContractWarning ? [route.rawContractWarning] : [])];
  options.io.stdout.write(renderGeneratedResult(result, {
    json: options.json,
    warnings,
    presentation: route.presentation,
  }));
  return 0;
}

export function assertNoCommandCollisions(env: AinectoEnv): void {
  const entries = buildRouteEntries(getGeneratedTools(env), enrichments);
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const key = entry.path.join(" ");
    const existing = seen.get(key);
    if (existing) {
      throw new Error(`Command collision for "${key}": ${existing} and ${entry.tool.mcpName}`);
    }
    seen.set(key, entry.tool.mcpName);
  }
  for (const commandPath of BESPOKE_COMMAND_PATHS) {
    const command = commandPath.join(" ");
    const existing = seen.get(command);
    if (existing) {
      throw new Error(`Bespoke command "${command}" collides with ${existing}.`);
    }
  }
}

function renderGeneratedResult(
  result: unknown,
  options: {
    json: boolean;
    warnings: string[];
    presentation?: ToolPresentationEnrichment;
  },
): string {
  if (!options.json && options.presentation?.outputHint === "table") {
    const table = renderTable(result, { columns: options.presentation.tableColumns });
    if (table) {
      const warnings = options.warnings.length ? `${options.warnings.map((warning) => `Warning: ${warning}`).join("\n")}\n` : "";
      return `${warnings}${table}\n`;
    }
  }
  return renderSuccess(result, { json: options.json, warnings: options.warnings });
}

function buildRouteEntries(
  tools: readonly GeneratedToolDefinition[],
  presentations: readonly ToolPresentationEnrichment[],
): Array<{ path: string[]; tool: GeneratedToolDefinition; presentation?: ToolPresentationEnrichment }> {
  const byName = new Map(presentations.map((presentation) => [presentation.mcpName, presentation]));
  const entries: Array<{ path: string[]; tool: GeneratedToolDefinition; presentation?: ToolPresentationEnrichment }> = [];
  for (const tool of tools) {
    const presentation = byName.get(tool.mcpName);
    entries.push({ path: tool.commandPath, tool, presentation });
    for (const alias of presentation?.aliases ?? []) {
      entries.push({ path: alias.split(/\s+/).filter(Boolean), tool, presentation });
    }
  }
  return entries;
}

function isPrefix(prefix: string[], values: string[]): boolean {
  return prefix.every((value, index) => values[index] === value);
}

function findRestStart(argv: string[], commandPath: string[]): number {
  let matched = 0;
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index]?.startsWith("-")) {
      if (argv[index] !== commandPath[matched]) {
        return index;
      }
      matched += 1;
      if (matched === commandPath.length) {
        return index + 1;
      }
    }
  }
  return argv.length;
}
