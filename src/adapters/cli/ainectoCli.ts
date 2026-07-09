import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { resolveEndpoint, assertEnv, type AinectoEnv } from "../../core/config/endpoints";
import { parsePayloadSource } from "../../core/input/payloadSource";
import { McpRpcClient } from "../../core/mcp/rpcClient";
import { renderError, renderSuccess } from "../../core/output/render";
import { getGeneratedTools } from "../../core/catalog";
import { runConnector } from "../mcp/connector";
import { executeGeneratedCommand } from "./generatedCommandRouter";

export interface CliIO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

export async function runAinectoCli(argv: string[], io: CliIO): Promise<number> {
  let parsed: GlobalArgs = { json: argv.includes("--json"), help: false, positionals: [] };
  try {
    parsed = parseGlobalArgs(argv);
    if (parsed.help || parsed.positionals.length === 0) {
      io.stdout.write(helpText());
      return 0;
    }

    const resolved = resolveEndpoint({ env: parsed.env, endpoint: parsed.endpoint });
    const tokenStore = new FileTokenStore();
    const auth = new OAuthClient({ endpoint: resolved.endpoint, tokenStore });
    const client = new McpRpcClient({ endpoint: resolved.endpoint, tokenProvider: auth });
    const [domain, action, ...rest] = parsed.positionals;

    if (domain === "mcp") {
      await runConnector({
        endpoint: resolved.endpoint,
        input: io.stdin,
        output: io.stdout,
        errorOutput: io.stderr,
      });
      return 0;
    }

    if (domain === "auth") {
      return handleAuth(action, auth, resolved.endpoint, parsed.json, io);
    }

    const generatedResult = await executeGeneratedCommand({
      env: parsed.env ?? "prod",
      argv: parsed.positionals,
      client,
      json: parsed.json,
      io,
    });
    if (generatedResult !== 2) {
      return generatedResult;
    }

    if (domain === "tools") {
      return handleTools(action, rest, parsed, client, io);
    }

    throw new Error(`Unknown command "${domain}".`);
  } catch (error) {
    io.stderr.write(renderError(error, { json: parsed.json }));
    return 1;
  }
}

async function handleAuth(
  action: string | undefined,
  auth: OAuthClient,
  endpoint: string,
  json: boolean,
  io: CliIO,
): Promise<number> {
  if (action === "login") {
    await auth.login();
    io.stdout.write(renderSuccess({ endpoint, authenticated: true }, { json }));
    return 0;
  }
  if (action === "status") {
    const token = await auth.getAccessToken();
    io.stdout.write(renderSuccess({ endpoint, authenticated: Boolean(token) }, { json }));
    return 0;
  }
  if (action === "logout") {
    await auth.logout();
    io.stdout.write(renderSuccess({ endpoint, authenticated: false }, { json }));
    return 0;
  }
  throw new Error("Expected auth login, auth status, or auth logout.");
}

async function handleTools(
  action: string | undefined,
  rest: string[],
  parsed: GlobalArgs,
  client: McpRpcClient,
  io: CliIO,
): Promise<number> {
  if (action === "list") {
    const tools = await client.toolsList();
    io.stdout.write(renderSuccess(tools, { json: parsed.json }));
    return 0;
  }

  if (action === "call") {
    const toolName = rest[0];
    if (!toolName) {
      throw new Error("Expected MCP tool name after tools call.");
    }
    const toolArgs = rest.slice(1);
    const payloadOptions = parsePayloadArgs(toolArgs);
    const payload = await parsePayloadSource({
      file: payloadOptions.file,
      inline: payloadOptions.inline,
      stdin: io.stdin,
    });
    const result = await client.toolsCall(toolName, payload.value);
    io.stdout.write(renderSuccess(result, { json: parsed.json, warnings: payload.warnings }));
    return 0;
  }

  if (action === "catalog") {
    const catalogEnv = parsed.env ?? "prod";
    io.stdout.write(renderSuccess(getGeneratedTools(parsed.env ?? "prod"), {
      json: parsed.json,
      warnings: [catalogEnv === "dev"
        ? "Local dev catalog is a checked-in live sync snapshot; rerun sync:tools --env dev to refresh it."
        : "Local prod catalog is seed fixture only until authenticated prod live sync updates generated catalogs."],
    }));
    return 0;
  }

  throw new Error("Expected tools list, tools call <mcpName>, or tools catalog.");
}

interface GlobalArgs {
  env?: AinectoEnv;
  endpoint?: string;
  json: boolean;
  help: boolean;
  positionals: string[];
}

function parseGlobalArgs(argv: string[]): GlobalArgs {
  const result: GlobalArgs = { json: false, help: false, positionals: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--env") {
      result.env = assertEnv(requireValue(arg, argv[++index]));
    } else if (arg === "--endpoint") {
      result.endpoint = requireValue(arg, argv[++index]);
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      result.positionals.push(arg);
    }
  }
  return result;
}

function parsePayloadArgs(argv: string[]): { file?: string; inline?: string } {
  const result: { file?: string; inline?: string } = {};
  const inline: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--file" || arg === "-f") {
      result.file = requireValue(arg, argv[++index]);
    } else {
      inline.push(arg);
    }
  }
  if (inline.length > 0) {
    result.inline = inline.join(" ");
  }
  return result;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function helpText(): string {
  return [
    "Ainecto CLI",
    "",
    "Usage:",
    "  ainecto auth login|status|logout [--env prod|dev] [--endpoint URL] [--json]",
    "  ainecto tools list [--env prod|dev] [--endpoint URL] [--json]",
    "  ainecto tools call <mcpName> [-f payload.json|@-] [inline-json] [--json]",
    "  ainecto <generated-command> [flags] [-f payload.json] [--yes] [--json]",
    "  ainecto mcp [--env prod|dev] [--endpoint URL]",
    "",
  ].join("\n");
}
