import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { resolveEndpoint, assertEnv, type AinectoEnv } from "../../core/config/endpoints";
import { parsePayloadSource } from "../../core/input/payloadSource";
import { McpRpcClient, isToolError } from "../../core/mcp/rpcClient";
import { renderError, renderSuccess } from "../../core/output/render";
import { getGeneratedTools } from "../../core/catalog";
import { runConnector } from "../mcp/connector";
import { executeGeneratedCommand } from "./generatedCommandRouter";
import { executeAttachmentsUploadCommand, isAttachmentsUploadCommand } from "./attachmentsUploadCommand";
import { executeInitCommand, readRepositoryRole } from "./initCommand";
import { CLI_VERSION } from "../../core/version";
import { assertRole, resolveRole, type HarnessRole } from "../../core/harness/role";

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
    // ★역할을 «한 번» 정하고 모든 경로가 그것을 쓴다.
    //   예전에는 stdio 브리지만 역할을 실어, 같은 토큰을 쓰는 `tools call` 경로가
    //   역할 없이 서버에 닿았다 — 제한을 우회하는 두 번째 문이었다(독립 리뷰 C1).
    let sessionRole = resolveRole({ role: parsed.role }).role;
    // ★init 은 저장소에 «이미 걸린» 역할을 이어받는다. 그 결정이 클라이언트보다 늦으면,
    //   파일에 쓸 역할과 서버에 보내는 역할이 서로 다른 시점에 정해진다(독립 재리뷰 I10).
    if (parsed.positionals[0] === "init" && sessionRole === undefined) {
      sessionRole = await readRepositoryRole(process.cwd());
    }
    const tokenStore = new FileTokenStore();
    const auth = new OAuthClient({ endpoint: resolved.endpoint, tokenStore, role: sessionRole });
    const client = new McpRpcClient({
      endpoint: resolved.endpoint,
      tokenProvider: auth,
      role: sessionRole,
    });
    const [domain, action, ...rest] = parsed.positionals;

    if (domain === "mcp") {
      await runConnector({
        endpoint: resolved.endpoint,
        // `ai-erd mcp` 로 붙는 경로도 같은 역할을 쓴다 — bin/mcp.ts 와 같은 규칙.
        role: sessionRole,
        input: io.stdin,
        output: io.stdout,
        errorOutput: io.stderr,
      });
      return 0;
    }

    if (domain === "init") {
      // ⚠init 의 플래그(--role 등)는 전역 파서가 positional 로 흘려보낸다. 그대로 넘긴다.
      return await executeInitCommand({
        argv: parsed.positionals.slice(1),
        role: sessionRole,
        // 문서는 인증 후에 받는다 — 토큰이 없으면 패키지 기본값으로 가고, 그 사실을 보고한다.
        // ★«필요할 때» 가져온다. --undo 는 로컬 작업이라 토큰을 건드릴 이유가 없다(S1).
        accessToken: () => auth.getAccessToken().catch(() => undefined),
        client,
        endpoint: resolved.endpoint,
        env: resolved.env,
        cliVersion: `@ai-erd/mcp ${CLI_VERSION}`,
        cwd: process.cwd(),
        json: parsed.json,
        io,
      });
    }

    if (domain === "auth") {
      // ★await 를 빼면 이 try 가 실패를 «못 본다» — 거부 사유가 renderError 를 지나치고
      //   날것의 스택 트레이스로 나간다(2026-09-23 실물 실행에서 발견).
      return await handleAuth(action, auth, resolved.endpoint, parsed.json, io);
    }

    if (isAttachmentsUploadCommand(domain, action)) {
      return await executeAttachmentsUploadCommand({
        argv: rest,
        client,
        json: parsed.json,
        io,
      });
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
      // ★위와 같은 이유로 await 가 필요하다. 이쪽이 실제로 스택을 뱉고 있었다.
      return await handleTools(action, rest, parsed, client, io);
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
    // 거부 문구는 그대로 보여 주되, 종료 코드로는 «실패»라고 말한다.
    return isToolError(result) ? 1 : 0;
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
  role?: HarnessRole;
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
    } else if (arg === "--role") {
      // ★전역 플래그다. 브리지·도구 호출·로그인·init 이 모두 같은 역할을 본다.
      result.role = assertRole(requireValue(arg, argv[++index]));
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
    "  ainecto auth login --role <design|development|test|validation> [--env prod|dev] [--json]",
    "  ainecto auth status|logout [--role <role>] [--env prod|dev] [--json]",
    "  ainecto tools list [--env prod|dev] [--endpoint URL] [--json]",
    "  ainecto tools call <mcpName> [-f payload.json|@-] [inline-json] [--json]",
    "  ainecto attachments upload --document-uuid <uuid> <file...> [--json]",
    "  ainecto <generated-command> [flags] [-f payload.json] [--yes] [--json]",
    "  ainecto mcp [--env prod|dev] [--endpoint URL] [--role design|development|test|validation]",
    "",
    "Harness:",
    "  ai-erd init --role <design|development|test|validation> [--project <uuid>] [--dry-run]",
    "  ai-erd init --undo",
    "",
  ].join("\n");
}
