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
import { executeInitCommand } from "./initCommand";
import { createReadlinePrompter, isInteractive } from "./prompter";
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
    const sessionRole = resolveRole({ role: parsed.role }).role;
    const tokenStore = new FileTokenStore();
    /**
     * 이 역할의 인증·RPC 클라이언트. ★init 은 역할을 «물어서» 정할 수 있으므로, 역할이 정해진 뒤 init 이
     * 이 함수를 부른다(설계 §21-4). 저장소에 이미 걸린 역할도 init 이 읽는다 — 그래서 «역할이 클라이언트보다
     * 먼저 정해진다»(독립 재리뷰 I10)가 init 안의 한 자리에서 지켜진다.
     */
    const connect = (role: HarnessRole | undefined) => {
      const auth = new OAuthClient({
        endpoint: resolved.endpoint,
        tokenStore,
        role,
        // ★init --dry-run 은 토큰을 갱신하지도 않는다 — 「아무것도 바꾸지 않는다」에 로그인 상태도 든다.
        //   (init 의 플래그는 positional 로 흘러온다.)
        readOnly: parsed.positionals[0] === "init" && parsed.positionals.includes("--dry-run"),
        // ★URL 을 «브라우저를 열기 전에» 알린다. 에이전트가 실행했다면 명령이 끝날 때 이 줄이 닿는다.
        //   stdout 은 결과 전용이라 stderr 에 쓴다.
        //   ★--json 이면 사람용 문장 대신 JSON 한 줄이다 — stderr 를 JSON 으로 읽는 호출자가 첫 줄에서
        //   깨지지 않고, 에이전트는 문장을 파싱하지 않고 URL 을 옮긴다(설계 §21-3 결정 (가)).
        onAuthorizeUrl: (url) => {
          io.stderr.write(parsed.json
            ? `${JSON.stringify({ event: "login_url", url, role: role ?? null })}\n`
            : `Opening your browser to sign in${role ? ` (role: ${role})` : ""}. `
              + `If it does not open, visit:\n  ${url}\n`);
        },
      });
      const client = new McpRpcClient({
        endpoint: resolved.endpoint,
        tokenProvider: auth,
        role,
      });
      return { auth, client };
    };
    // init 밖의 경로는 역할이 지금 정해져 있다(플래그·환경변수).
    const { auth, client } = connect(sessionRole);
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
        connect: (role) => {
          const { auth, client } = connect(role);
          return {
            client,
            // 문서는 인증 후에 받는다 — 토큰이 없으면 패키지 기본값으로 가고, 그 사실을 보고한다.
            // ★«필요할 때» 가져온다. --undo 는 로컬 작업이라 토큰을 건드릴 이유가 없다(S1) — undo 는
            //   connect 자체를 부르지 않는다.
            // ★갱신 실패는 «토큰 없음»(→ 로그인)이지만, AINECTO_TOKEN 을 못 쓰는 주소라는 거절은 삼키지 않는다 —
            //   삼키면 그 설정 오류가 브라우저 로그인으로 둔갑한다.
            accessToken: async () => {
              try {
                return await auth.getAccessToken();
              } catch (error) {
                if (process.env.AINECTO_TOKEN) {
                  throw error;
                }
                return undefined;
              }
            },
            // 이 역할로 로그인한다 — `ai-erd auth login` 과 같은 함수다(설계 §8-1).
            login: async () => {
              await auth.login();
            },
          };
        },
        // ★대화형일 때만 묻는다(판정은 isInteractive 한 곳). 에이전트·CI 는 TTY 가 아니다.
        prompter: isInteractive(io, parsed.json) ? createReadlinePrompter(io) : undefined,
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
    // ★두 카탈로그 다 «그 서버의 tools/list 를 받아 저장소에 넣은 스냅샷»이다. 예전 문구는 prod 를
    //   「seed fixture」라고 했는데, prod 도 운영에서 받아 온 것이다(0.4.1 에서 다시 받음, 리뷰 P2).
    const catalogEnv = parsed.env ?? "prod";
    io.stdout.write(renderSuccess(getGeneratedTools(catalogEnv), {
      json: parsed.json,
      warnings: [`Local ${catalogEnv} catalog is a checked-in snapshot of that server's tools/list, `
        + `taken when this CLI version was built; rerun sync:tools --env ${catalogEnv} to refresh it.`],
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
    "AI-ERD CLI",
    "",
    "Usage:",
    "  ai-erd auth login --role <design|development|test|validation> [--env prod|dev] [--json]",
    "  ai-erd auth status|logout [--role <role>] [--env prod|dev] [--json]",
    "  ai-erd tools list [--env prod|dev] [--endpoint URL] [--json]",
    "  ai-erd tools call <mcpName> [-f payload.json|@-] [inline-json] [--json]",
    "  ai-erd attachments upload --document-uuid <uuid> <file...> [--json]",
    "  ai-erd <generated-command> [flags] [-f payload.json] [--yes] [--json]",
    "  ai-erd mcp [--env prod|dev] [--endpoint URL] [--role design|development|test|validation]",
    "",
    "Harness:",
    "  ai-erd init --role <design|development|test|validation> [--project <uuid>] [--dry-run]",
    "  ai-erd init --undo",
    "",
  ].join("\n");
}
