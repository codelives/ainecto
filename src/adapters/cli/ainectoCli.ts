import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient } from "../../core/auth/oauth";
import { resolveEndpoint, assertEnv, type AinectoEnv } from "../../core/config/endpoints";
import { parsePayloadSource } from "../../core/input/payloadSource";
import { McpRpcClient, isToolError } from "../../core/mcp/rpcClient";
import { renderError, renderSuccess } from "../../core/output/render";
import { getGeneratedTools, loadLiveTools } from "../../core/catalog";
import type { GeneratedToolDefinition } from "../../core/catalog/types";
import { runConnector } from "../mcp/connector";
import { executeGeneratedCommand, matchGeneratedCommand } from "./generatedCommandRouter";
import { executeAttachmentsUploadCommand, isAttachmentsUploadCommand } from "./attachmentsUploadCommand";
import { executeInitCommand } from "./initCommand";
import { createReadlinePrompter, isInteractive } from "./prompter";
import { CLI_VERSION, PACKAGE_NAME } from "../../core/version";
import { assertRole, resolveRole, ROLE_ENV_VAR, type HarnessRole, type ResolvedRole } from "../../core/harness/role";
import { askTheUserToFixRole, findRepositoryRole } from "../../core/harness/repositoryRole";

export interface CliIO {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

export async function runAinectoCli(argv: string[], io: CliIO): Promise<number> {
  let parsed: GlobalArgs = { json: argv.includes("--json"), help: false, version: false, positionals: [] };
  try {
    parsed = parseGlobalArgs(argv);
    // ★에이전트는 설치 직후 버전부터 확인한다 — «Unknown command»로 답하면 도움말까지 못 간다(2026-09-29, Codex).
    if (parsed.version || parsed.positionals[0] === "version") {
      io.stdout.write(renderSuccess({ version: CLI_VERSION }, { json: parsed.json }));
      return 0;
    }
    if (parsed.help || parsed.positionals.length === 0) {
      io.stdout.write(helpText());
      return 0;
    }

    const resolved = resolveEndpoint({ env: parsed.env, endpoint: parsed.endpoint });
    // 플래그·환경변수로 «명시한» 역할. ★auth 는 이것을 읽지 않는다 — 잘못된 AINECTO_ROLE 이 로그인을
    //   막지 않게(0.4.2 리뷰 P2). 저장소 역할과의 판정은 아래 한 곳에서 한다.
    const explicitRole = () => resolveRole({ role: parsed.role });
    const tokenStore = new FileTokenStore();
    /**
     * 인증·RPC 클라이언트. ★토큰은 서버마다 한 칸이고(역할 없음), 역할은 RPC 헤더로만 실린다
     * (설계 0.4.2 §2-3·§2-4). init 은 역할을 «물어서» 정할 수 있으므로 역할이 정해진 뒤 이것을 부른다.
     */
    const connect = (role: HarnessRole | null) => {
      const auth = new OAuthClient({
        endpoint: resolved.endpoint,
        tokenStore,
        // ★init --dry-run 은 토큰을 갱신하지도 않는다 — 「아무것도 바꾸지 않는다」에 로그인 상태도 든다.
        //   (init 의 플래그는 positional 로 흘러온다.)
        readOnly: parsed.positionals[0] === "init" && parsed.positionals.includes("--dry-run"),
        // ★URL 을 «브라우저를 열기 전에» 알린다. stdout 은 결과 전용이라 stderr 에 쓴다.
        //   --json 이면 JSON 한 줄이다(설계 §21-3 (가)). 로그인이 역할과 무관해져 role 칸은 없다(0.4.2 §2-5).
        onAuthorizeUrl: (url) => {
          io.stderr.write(parsed.json
            ? `${JSON.stringify({ event: "login_url", url })}\n`
            : `Opening your browser to sign in to AiNecto. If it does not open, visit:\n  ${url}\n`);
        },
      });
      const client = new McpRpcClient({ endpoint: resolved.endpoint, tokenProvider: auth, role });
      return { auth, client };
    };
    const [domain, action, ...rest] = parsed.positionals;

    if (domain === "mcp") {
      await runConnector({
        endpoint: resolved.endpoint,
        // 브리지의 역할은 인자·환경변수에서만 온다 — bin/mcp.ts 와 같은 규칙. 저장소를 적용하지 않는다.
        role: explicitRole().role ?? null,
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
        role: explicitRole().role,
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
            // 로그인한다 — `ainecto auth login` 과 같은 함수다. 서버마다 한 번이다(0.4.2).
            login: async () => {
              await auth.login();
            },
          };
        },
        // ★대화형일 때만 묻는다(판정은 isInteractive 한 곳). 에이전트·CI 는 TTY 가 아니다.
        prompter: isInteractive(io, parsed.json) ? createReadlinePrompter(io) : undefined,
        endpoint: resolved.endpoint,
        env: resolved.env,
        cliVersion: `${PACKAGE_NAME} ${CLI_VERSION}`,
        cwd: process.cwd(),
        json: parsed.json,
        io,
      });
    }

    if (domain === "auth") {
      // 로그인은 서버마다 한 번이다 — 역할과 무관하다. 옛 문서를 따라 친 --role 은 알리고 넘어간다.
      if (parsed.role !== undefined) {
        io.stderr.write("Sign-in is one per machine; --role is not used by auth.\n");
      }
      // ★await 를 빼면 이 try 가 실패를 «못 본다» — 거부 사유가 renderError 를 지나치고
      //   날것의 스택 트레이스로 나간다(2026-09-23 실물 실행에서 발견).
      return await handleAuth(action, connect(null).auth, resolved.endpoint, parsed.json, io);
    }

    const env = parsed.env ?? "prod";
    // ★카탈로그는 서버의 지금 목록이다. 역할 판정이 실패해도(깨진 저장소) 막지 않고 스냅샷으로 답한다
    //   (0.4.2 리뷰 P2 — 깨진 저장소 안에서도 카탈로그를 볼 수 있다).
    if (domain === "tools" && action === "catalog") {
      return await printCatalog(parsed, io, resolved.endpoint, async () => {
        const explicit = explicitRole();
        return connect(await commandRole(explicit, process.cwd())).client;
      });
    }
    // 스냅샷에 없는 명령은 서버의 지금 목록에서 찾는다 — 서버에 새로 열린 도구를 CLI 재배포 없이 쓴다.
    //   ★역할 없이 묻는다: 모르는 명령은 «역할을 못 읽음»이 아니라 «모르는 명령»으로 답해야 한다(0.4.2 리뷰 P2).
    //   역할은 아래 실제 호출에 실리고, 강제는 서버가 한다.
    let routeTools: readonly GeneratedToolDefinition[] = getGeneratedTools(env);
    let remote = isAttachmentsUploadCommand(domain, action)
      || (domain === "tools" && (action === "list" || action === "call"))
      || matchGeneratedCommand(routeTools, parsed.positionals) !== undefined;
    if (!remote) {
      const live = await loadLiveTools(env, connect(null).client).catch(() => undefined);
      if (live && matchGeneratedCommand(live, parsed.positionals)) {
        routeTools = live;
        remote = true;
      }
    }
    if (!remote) {
      throw new Error(domain === "tools"
        ? "Expected tools list, tools call <mcpName>, or tools catalog."
        : `Unknown command "${domain}".`);
    }

    // ★여기부터 원격을 부르는 명령은 «저장소 역할»로 간다(설계 0.4.2 §2-2). mcp·init·auth 는 위에서
    //   끝났다 — 역할이 어긋난 저장소 안에서도 로그인·브리지·init 은 막히지 않는다.
    const explicit = explicitRole();
    const { client } = connect(await commandRole(explicit, process.cwd()));

    if (isAttachmentsUploadCommand(domain, action)) {
      return await executeAttachmentsUploadCommand({
        argv: rest,
        client,
        json: parsed.json,
        io,
      });
    }

    const generatedResult = await executeGeneratedCommand({
      tools: routeTools,
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

/**
 * ★셸 명령의 역할 — 한 곳(설계 0.4.2 §2-2).
 *
 * <p>저장소(cwd 에서 위로, 우리 브리지 항목이 있는 첫 폴더)에 역할 R 이 있으면 R 로 간다. 명시한 역할이 R 과
 * 다르면 거절한다 — 역할을 바꾸는 길은 `ainecto init --role` 하나이고 사용자가 고른다. 저장소를 못
 * 읽으면(어긋남·읽기 문제) 멈추고 사용자에게 물으라고 한다 — 모르는 채로 «제한 없음»으로 가지 않는다.
 * 저장소 밖이면 명시한 역할(없으면 역할 없음 = 제한 없음, 현행).
 */
export async function commandRole(explicit: ResolvedRole, cwd: string): Promise<HarnessRole | null> {
  const explicitRole = explicit.role ?? null;
  const found = await findRepositoryRole(cwd);
  if (found.kind === "conflict") {
    throw new Error(await askTheUserToFixRole(found.dir, found.reason));
  }
  if (found.kind === "none") {
    return explicitRole;
  }
  if (explicitRole !== null && explicitRole !== found.role) {
    const given = explicit.source === "env" ? `${ROLE_ENV_VAR}=${explicitRole}` : `--role ${explicitRole}`;
    throw new Error(
      `This repository's AI sessions have the role ${found.role} (set in ${found.dir}). `
      + `${given} does not match — the role changes only with \`ainecto init --role <role>\`, after asking the user.`,
    );
  }
  return found.role;
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
    io.stdout.write(renderSuccess({ ...await nextStep(), endpoint, authenticated: true }, { json }));
    return 0;
  }
  if (action === "status") {
    const token = await auth.getAccessToken();
    io.stdout.write(renderSuccess({ ...await nextStep(), endpoint, authenticated: Boolean(token) }, { json }));
    return 0;
  }
  if (action === "logout") {
    await auth.logout();
    io.stdout.write(renderSuccess({ endpoint, authenticated: false }, { json }));
    return 0;
  }
  throw new Error("Expected auth login, auth status, or auth logout.");
}

/**
 * `tools catalog` — ★서버의 지금 목록을 먼저 보여 준다. 스냅샷만 보여 주면 서버에 열린 새 문서 유형(html)을
 * 에이전트가 «CLI 에 없다»고 읽었다(2026-10-10). 못 받으면(로그인 전·오프라인·깨진 저장소) 스냅샷으로
 * 답하되 «낡았을 수 있다»와 그 이유를 같이 싣는다 — 조용히 대체하지 않는다.
 */
async function printCatalog(
  parsed: GlobalArgs,
  io: CliIO,
  endpoint: string,
  liveClient: () => Promise<McpRpcClient>,
): Promise<number> {
  const catalogEnv = parsed.env ?? "prod";
  try {
    const tools = await loadLiveTools(catalogEnv, await liveClient());
    io.stdout.write(renderSuccess(tools, { json: parsed.json }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    io.stdout.write(renderSuccess(getGeneratedTools(catalogEnv), {
      json: parsed.json,
      warnings: [`Could not read the live tool list from ${endpoint} (${reason}). `
        + `Showing the ${catalogEnv} catalog checked in when this CLI version was built — a snapshot of that `
        + "server's tools/list that may miss newer document types and tools. Run `ainecto auth login`, then retry."],
    }));
  }
  return 0;
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

  throw new Error("Expected tools list, tools call <mcpName>, or tools catalog.");
}

interface GlobalArgs {
  env?: AinectoEnv;
  endpoint?: string;
  role?: HarnessRole;
  json: boolean;
  help: boolean;
  version: boolean;
  positionals: string[];
}

function parseGlobalArgs(argv: string[]): GlobalArgs {
  const result: GlobalArgs = { json: false, help: false, version: false, positionals: [] };
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
    } else if (arg === "--version" || arg === "-v" || arg === "-V") {
      result.version = true;
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

/**
 * ★로그인은 설치의 끝이 아니다. 에이전트가 `auth status --json` 의 authenticated:true 를 보고 «설치 완료»로
 * 닫은 실측(2026-09-29, Codex)이 있다. 이 저장소에 역할이 없으면 결과에 다음 단계를 싣는다 — --json 에도.
 */
async function nextStep(): Promise<{ setup?: "incomplete"; next?: string }> {
  const found = await findRepositoryRole(process.cwd());
  return found.kind === "none" ? { setup: "incomplete", next: NEXT_STEP_INIT } : {};
}

/** 설치·로그인 뒤 «다음에 할 일». 도움말과 auth 결과가 같은 문장을 쓴다. */
// ★«참고»로 읽히면 넘긴다 — Codex 가 `next` 를 받고도 «업데이트 완료»만 말했다(2026-09-30 실측).
//   그래서 «사용자가 설치·업데이트·로그인만 부탁했어도 지금 알려라»를 지시문으로 적는다.
const NEXT_STEP_INIT = [
  "AiNecto setup is not finished until `npx -y ainecto@latest init` runs in the repository.",
  "AI agents: tell the user this now, even if they only asked to install, update, or sign in. Then ask",
  "which role this repository's AI sessions should have — Design, Development, Test, or Validation —",
  "never pick one yourself, and run `npx -y ainecto@latest init --role <role>` from the repository root.",
  "In a terminal: `npx -y ainecto@latest init` asks for the role and the project.",
].join("\n");

function helpText(): string {
  return [
    "AiNecto CLI",
    "",
    NEXT_STEP_INIT,
    "",
    "Usage:",
    "  ainecto auth login|status|logout [--env prod|dev] [--json]   (one sign-in per machine)",
    "  ainecto tools list [--env prod|dev] [--endpoint URL] [--json]",
    "  ainecto tools call <mcpName> [-f payload.json|@-] [inline-json] [--json]",
    "  ainecto attachments upload --document-uuid <uuid> <file...> [--json]",
    "  ainecto <generated-command> [flags] [-f payload.json] [--yes] [--json]",
    "  ainecto mcp [--env prod|dev] [--endpoint URL] [--role design|development|test|validation]",
    "",
    "Harness:",
    "  ainecto init [--role <design|development|test|validation>] [--project <uuid>] [--dry-run]",
    "      In a terminal, asks for the role and project when they are not given.",
    "  ainecto init --undo",
    "",
  ].join("\n");
}
