import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient, usableAccessToken } from "../../core/auth/oauth";
import { resolveEndpoint, assertEnv, type AinectoEnv } from "../../core/config/endpoints";
import { parsePayloadSource } from "../../core/input/payloadSource";
import { McpRpcClient, isToolError } from "../../core/mcp/rpcClient";
import { renderError, renderSuccess } from "../../core/output/render";
import { getGeneratedTools, loadLiveTools } from "../../core/catalog";
import type { GeneratedToolDefinition } from "../../core/catalog/types";
import { runConnector } from "../mcp/connector";
import { parseMcpArgs } from "../mcp/args";
import { readAgentName } from "../../core/harness/agentName";
import { executeGeneratedCommand, matchGeneratedCommand } from "./generatedCommandRouter";
import { executeAttachmentsUploadCommand, isAttachmentsUploadCommand } from "./attachmentsUploadCommand";
import { executeInboxPollCommand, isInboxPollCommand } from "./inboxPollCommands";
import { executeInitCommand } from "./initCommand";
import { executeSetupCommand } from "./setupCommand";
import { executeDoctorCommand, executeStatusCommand } from "./statusCommand";
import { systemCommandRunner } from "../../core/setup/commandRunner";
import { homedir } from "node:os";
import { CLI_VERSION, PACKAGE_NAME } from "../../core/version";
import { LEGACY_ROLE_NOTICE, legacyRoleInput } from "../../core/harness/legacyRole";

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
    const [domain, action, ...rest] = parsed.positionals;
    // ★옛 --role / AINECTO_ROLE — 세션 역할은 없어졌다(0.8.0). 값을 검사하지 않고 받아 안내 한 줄을
    //   남기고, 원격 요청에 기록용 헤더로만 싣는다(legacyRole.ts). 브리지는 connector 가 같은 일을 한다.
    const legacyRole = legacyRoleInput(parsed.legacyRole);
    if (legacyRole !== undefined && domain !== "mcp") {
      // --json 이면 stderr 도 JSON 한 줄이다(login_url 과 같은 규칙).
      io.stderr.write(parsed.json
        ? `${JSON.stringify({ event: "legacy_role_ignored", message: LEGACY_ROLE_NOTICE })}\n`
        : `${LEGACY_ROLE_NOTICE}\n`);
    }
    const tokenStore = new FileTokenStore();
    // ★이 폴더의 에이전트 이름(`init --agent` 가 쓴 .ainecto/agent.local) — 직접 명령도 브리지와 같은 파일을 읽는다.
    //   없으면 이름 없는 연결(지금과 같다). 브리지는 connector 가 --agent 를 먼저 보고 같은 파일을 읽는다.
    const agentName = domain === "mcp" ? undefined : await readAgentName(process.cwd());
    /** 인증·RPC 클라이언트. ★토큰은 서버마다 한 칸이다. */
    const connect = () => {
      const auth = new OAuthClient({
        endpoint: resolved.endpoint,
        tokenStore,
        // ★init·setup --dry-run 은 토큰을 갱신하지도 않는다 — 「아무것도 바꾸지 않는다」에 로그인 상태도 든다.
        //   (하위 명령의 플래그는 positional 로 흘러온다.)
        readOnly: (domain === "init" || domain === "setup") && parsed.positionals.includes("--dry-run"),
        // ★URL 을 «브라우저를 열기 전에» 알린다. stdout 은 결과 전용이라 stderr 에 쓴다.
        //   --json 이면 JSON 한 줄이다(설계 §21-3 (가)). 로그인이 역할과 무관해져 role 칸은 없다(0.4.2 §2-5).
        onAuthorizeUrl: (url) => {
          io.stderr.write(parsed.json
            ? `${JSON.stringify({ event: "login_url", url })}\n`
            : `Opening your browser to sign in to AiNecto. If it does not open, visit:\n  ${url}\n`);
        },
      });
      // 직접 명령 — 채널 cli. 에이전트 «종류»는 싣지 않는다(셸을 누가 돌렸는지 모른다 → 서버는 unknown).
      //   에이전트 «이름»은 폴더에 붙어 있으므로 싣는다.
      const client = new McpRpcClient({ endpoint: resolved.endpoint, tokenProvider: auth, legacyRole, channel: "cli", agentName });
      return { auth, client };
    };

    if (domain === "mcp") {
      // --env·--endpoint·--role 은 전역 파서가 이미 먹었다 — 남은 브리지 인자(--agent)는 브리지와 같은 파서로 읽는다.
      const bridgeArgs = parseMcpArgs(parsed.positionals.slice(1));
      await runConnector({
        endpoint: resolved.endpoint,
        legacyRoleFlag: parsed.legacyRole,
        agentFlag: bridgeArgs.agent,
        input: io.stdin,
        output: io.stdout,
        errorOutput: io.stderr,
      });
      return 0;
    }

    if (domain === "init") {
      // ⚠init 의 플래그는 전역 파서가 positional 로 흘려보낸다. 그대로 넘긴다.
      const { auth } = connect();
      return await executeInitCommand({
        argv: parsed.positionals.slice(1),
        // 문서는 인증 후에 받는다 — 토큰이 없으면 패키지 기본값으로 가고, 그 사실을 보고한다.
        // ★«필요할 때» 가져온다. --undo 는 로컬 작업이라 토큰을 건드리지 않는다(S1).
        // ★판정은 setup 과 같은 {@link usableAccessToken} 하나 — 서버가 저장 로그인을 거절했으면 «없음»(→ 로그인),
        //   네트워크 장애·AINECTO_TOKEN 을 못 쓰는 주소라는 거절은 삼키지 않는다(브라우저 로그인으로 둔갑하지 않게).
        accessToken: () => usableAccessToken(auth),
        // 로그인한다 — `ainecto auth login` 과 같은 함수다. 서버마다 한 번이다.
        login: async () => {
          await auth.login();
        },
        endpoint: resolved.endpoint,
        env: resolved.env,
        cliVersion: `${PACKAGE_NAME} ${CLI_VERSION}`,
        cwd: process.cwd(),
        json: parsed.json,
        io,
      });
    }

    if (domain === "setup") {
      const { auth, client } = connect();
      return await executeSetupCommand({
        argv: parsed.positionals.slice(1),
        endpoint: resolved.endpoint,
        env: resolved.env,
        auth,
        client,
        // ★외부 CLI 는 홈 폴더에서 돈다 — 지금 저장소의 local·project 범위 항목이 사용자 범위 판정에 끼지 않게.
        runner: systemCommandRunner({ cwd: homedir() }),
        home: homedir(),
        json: parsed.json,
        io,
      });
    }

    if (domain === "status" || domain === "doctor") {
      const { auth, client } = connect();
      const run = domain === "status" ? executeStatusCommand : executeDoctorCommand;
      return await run({
        argv: parsed.positionals.slice(1),
        collect: {
          endpoint: resolved.endpoint,
          env: resolved.env,
          cliVersion: CLI_VERSION,
          tokenStore,
          auth,
          client,
          runner: systemCommandRunner({ cwd: homedir() }),
          hereRunner: systemCommandRunner({ cwd: process.cwd() }),
          home: homedir(),
          cwd: process.cwd(),
          envVars: process.env,
        },
        json: parsed.json,
        io,
      });
    }

    if (domain === "auth") {
      // ★await 를 빼면 이 try 가 실패를 «못 본다» — 거부 사유가 renderError 를 지나치고
      //   날것의 스택 트레이스로 나간다(2026-09-23 실물 실행에서 발견).
      return await handleAuth(action, connect().auth, resolved.endpoint, parsed.json, io);
    }

    const env = parsed.env ?? "prod";
    // ★카탈로그는 서버의 지금 목록이다. 못 받으면 스냅샷으로 답한다.
    if (domain === "tools" && action === "catalog") {
      return await printCatalog(parsed, io, resolved.endpoint, async () => connect().client);
    }
    // 스냅샷에 없는 명령은 서버의 지금 목록에서 찾는다 — 서버에 새로 열린 도구를 CLI 재배포 없이 쓴다.
    let routeTools: readonly GeneratedToolDefinition[] = getGeneratedTools(env);
    let remote = isAttachmentsUploadCommand(domain, action)
      || isInboxPollCommand(domain, action)
      || (domain === "tools" && (action === "list" || action === "call"))
      || matchGeneratedCommand(routeTools, parsed.positionals) !== undefined;
    if (!remote) {
      const live = await loadLiveTools(env, connect().client).catch(() => undefined);
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

    // ★세션 역할은 없다 — 무엇을 할 수 있는지는 서버가 사용자 권한으로 정한다.
    const { client } = connect();

    if (isAttachmentsUploadCommand(domain, action)) {
      return await executeAttachmentsUploadCommand({
        argv: rest,
        client,
        json: parsed.json,
        io,
      });
    }

    if (isInboxPollCommand(domain, action)) {
      return await executeInboxPollCommand({ domain, action, argv: rest, client, json: parsed.json, io });
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
  /** 옛 --role — 검사하지 않는다(legacyRole.ts). */
  legacyRole?: string;
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
      // ★옛 전역 플래그 — 값을 검사하지 않고 받는다(legacyRole.ts). 값 없이 끝나도 멈추지 않는다.
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        result.legacyRole = value;
        index += 1;
      }
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
 * 닫은 실측(2026-09-29, Codex)이 있다. 그래서 auth 결과에 다음 단계를 싣는다 — --json 에도.
 * 무엇이 남았는지는 `doctor` 한 곳이 판정한다(여기서 따로 판정하지 않는다).
 */
async function nextStep(): Promise<{ next: string }> {
  return { next: NEXT_STEP };
}

/** 설치·로그인 뒤 «다음에 할 일». 도움말과 auth 결과가 같은 문장을 쓴다. */
// ★«참고»로 읽히면 넘긴다 — Codex 가 `next` 를 받고도 «업데이트 완료»만 말했다(2026-09-30 실측).
//   그래서 «사용자가 설치·업데이트·로그인만 부탁했어도 지금 알려라»를 지시문으로 적는다.
const NEXT_STEP = [
  "Connect your coding agents to AiNecto once per machine: `npx -y ainecto@latest setup`.",
  "AI agents: tell the user this now, even if they only asked to install, update, or sign in.",
  "To add AiNecto's working rules to a repository, run `npx -y ainecto@latest init` from its root.",
  "`npx -y ainecto@latest doctor` shows what is still missing and the command that fixes it.",
].join("\n");

function helpText(): string {
  return [
    "AiNecto CLI",
    "",
    NEXT_STEP,
    "",
    "Usage:",
    "  ainecto auth login|status|logout [--env prod|dev] [--json]   (one sign-in per machine)",
    "  ainecto tools list [--env prod|dev] [--endpoint URL] [--json]",
    "  ainecto tools call <mcpName> [-f payload.json|@-] [inline-json] [--json]",
    "  ainecto attachments upload --document-uuid <uuid> <file...> [--json]",
    "  ainecto notifications poll --cursor-file <path> [--kinds A,B] [--workspace <uuid>]... [--project <uuid>]... [--direct-only] [--limit N] [--json]",
    "  ainecto notifications ack --cursor-file <path>     (after the agent handled the polled batch)",
    "  ainecto agent-todos poll [--workspace <uuid>]... [--project <uuid>]... [--only-new --seen-file <path>] [--json]",
    "      --workspace and --project may repeat: any of the given workspaces AND any of the given projects",
    "      poll exit codes: 0 new items · 3 nothing new · 1 error · 2 usage error",
    "  ainecto <generated-command> [flags] [-f payload.json] [--yes] [--json]",
    "  ainecto mcp [--env prod|dev] [--endpoint URL] [--agent NAME]",
    "",
    "Setup (once per machine):",
    "  ainecto setup [--env prod|dev] [--endpoint URL] [--dry-run] [--json]   sign in and connect Claude Code, Cursor, and Codex to the server address",
    "  ainecto setup --local                                                  connect through the local relay (npx -y @ainecto/mcp) instead",
    "  ainecto setup --undo                                                   remove those connections (sign-in stays)",
    "  ainecto status [--json]                                                who is signed in, and what is connected (read-only)",
    "  ainecto doctor [--json]                                                status + what is missing and the command that fixes it",
    "",
    "Harness:",
    "  ainecto init [--mcp] [--local] [--dry-run] [--json]   AiNecto rules for this repository (--mcp also writes .mcp.json and .cursor/mcp.json with the server address; --local writes the local relay instead)",
    "  ainecto init --agent NAME                             name the agent working in this folder: writes .ainecto/agent.local (do not commit it) and puts the name in .mcp.json, .cursor/mcp.json and .codex/config.toml",
    "  ainecto init --undo",
    "",
  ].join("\n");
}
