import { FileTokenStore } from "../../core/auth/tokenStore";
import { OAuthClient, usableAccessToken } from "../../core/auth/oauth";
import { resolveEndpoint, assertEnv, type AinectoEnv } from "../../core/config/endpoints";
import { parsePayloadSource } from "../../core/input/payloadSource";
import { McpRpcClient, isToolError } from "../../core/mcp/rpcClient";
import { renderError, renderSuccess } from "../../core/output/render";
import { getGeneratedTools, loadLiveTool, loadLiveTools } from "../../core/catalog";
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
import { executeTermCommand, stringEnv, TERM_HELP_LINES } from "./termCommand";
import { executePcStart, executePcStop, executeRemoteSetting, type PcDeps } from "./pcCommand";
import { npxCliCommand, pcReadyDeadlineMs, pcStopDeadlineMs, skipUpgradeOf } from "../../core/pc/pcSession";
import { executePcSwap } from "./pcSwap";
import { swapArgsOf } from "./pcAutoUpgrade";
import { openAgentLog } from "../../core/agent/log";
import { ensurePrivateDir } from "../../core/fs/privateFiles";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pcSettingsPath } from "../../core/pc/pcSettings";
import { pcStatus } from "./pcStatus";
import { readAccount } from "../../core/setup/accountSummary";
import { CliCommandError } from "./errors";
import { termPaths } from "../../core/term/paths";
import { termRuntimeProblem } from "../../core/term/daemonLock";
import { agentPaths } from "../../core/agent/paths";
import { collectStatus, type CollectInput, type MachineStatus } from "../../core/setup/machineStatus";
import { AGENT_HELP_LINES, executeAgentServe, isPcRunCommand } from "./agentCommand";
import { systemCommandRunner } from "../../core/setup/commandRunner";
import { homedir, hostname, tmpdir } from "node:os";
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
    // ★사람이 보는 터미널(stdin·stdout 모두 TTY)인가 — 인자 없는 `ainecto` 는 여기서만 «이 PC 연결»(start)이다.
    //   AI 에이전트·스크립트(파이프)·--json·--help 는 지금처럼 도움말 — 에이전트가 구경하려고 친 `ainecto` 가 백그라운드를 띄우지 않는다.
    const interactive = !parsed.json && io.stdin.isTTY === true && io.stdout.isTTY === true;
    if (parsed.help || (parsed.positionals.length === 0 && !interactive)) {
      io.stdout.write(helpText());
      return 0;
    }
    // ★term 은 이 기기 안의 터미널 다중화다 — 서버·로그인·에이전트 이름을 쓰지 않는다(KAN-738 1단계).
    //   웹에 잇는 다리는 이 PC 연결(`ainecto` → pc run) 안에 있다 — `term remote` 는 그 안내만 한다.
    if (parsed.positionals[0] === "term") {
      return await executeTermCommand({ argv: parsed.positionals.slice(1), json: parsed.json, io });
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
    /** 인증·RPC 클라이언트 — 명령 하나에 한 벌(operation 상세를 같은 연결에서 한 번만 묻게). ★토큰은 서버마다 한 칸이다. */
    let connection: { auth: OAuthClient; client: McpRpcClient } | undefined;
    const connect = () => connection ??= (() => {
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
    })();

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

    /** `ainecto init` — 하위 명령과 메뉴 ④가 같이 쓴다. */
    const runInit = (argv: string[]): Promise<number> => {
      const { auth } = connect();
      return executeInitCommand({
        argv,
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
    };
    /** `ainecto setup` — 하위 명령과 메뉴(로그인 전)가 같이 쓴다. */
    const runSetup = (argv: string[]): Promise<number> => {
      const { auth, client } = connect();
      return executeSetupCommand({
        argv,
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
    };
    /** status·doctor·메뉴 점검이 같이 쓰는 수집 입력. */
    const collectInput = (): CollectInput => {
      const { auth, client } = connect();
      return {
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
      };
    };

    /** «이 PC 연결» 입구들(start·stop·remote)이 같이 쓰는 것. */
    const pcDeps = (): PcDeps => ({
      io,
      json: parsed.json,
      interactive,
      paths: termPaths(),
      settingsPath: pcSettingsPath(),
      hostName: hostname(),
      endpoint: resolved.endpoint,
      cwd: process.cwd(),
      sessionEnv: stringEnv(),
      flags: { env: parsed.env, endpoint: parsed.endpoint },
      cliVersion: CLI_VERSION,
      managedCommand: (args) => npxCliCommand(args),
      runner: systemCommandRunner({ cwd: process.cwd() }),
      termProblem: termRuntimeProblem(),
      agentLog: agentPaths().log,
      stopDeadlineMs: pcStopDeadlineMs(),
      readyDeadlineMs: pcReadyDeadlineMs(),
      machine: () => collectStatus(collectInput()),
      account: () => readAccount(connect().client),
      setup: () => runSetup([]),
    });

    if (domain === undefined || domain === "start") {
      if (rest.length > 0 || (domain === "start" && action !== undefined)) {
        throw new CliCommandError("USAGE", "Usage: ainecto start [--env prod|dev] [--endpoint URL]");
      }
      return await executePcStart(pcDeps());
    }
    if (domain === "stop") {
      return await executePcStop(pcDeps(), parsed.positionals.slice(1));
    }
    if (domain === "remote") {
      return await executeRemoteSetting(pcDeps(), parsed.positionals.slice(1));
    }

    if (domain === "init") {
      // ⚠init 의 플래그는 전역 파서가 positional 로 흘려보낸다. 그대로 넘긴다.
      return await runInit(parsed.positionals.slice(1));
    }

    if (domain === "setup") {
      return await runSetup(parsed.positionals.slice(1));
    }

    if (domain === "status" || domain === "doctor") {
      const run = domain === "status" ? executeStatusCommand : executeDoctorCommand;
      return await run({
        argv: parsed.positionals.slice(1),
        collect: collectInput(),
        // status 만 — 이 PC 연결·동의·터미널 세션(doctor 의 판정은 바꾸지 않는다).
        ...(domain === "status" ? { pc: (status: MachineStatus) => pcStatus(status, resolved.endpoint) } : {}),
        json: parsed.json,
        io,
      });
    }

    if (isPcRunCommand(domain, action)) {
      const skipUpgrade = skipUpgradeOf(parsed.positionals.slice(2));
      return await executeAgentServe({ endpoint: resolved.endpoint, env: resolved.env, auth: connect().auth, io, agentName,
        launchFlags: { env: parsed.env, endpoint: parsed.endpoint }, ...(skipUpgrade ? { skipUpgrade } : {}) });
    }
    if (domain === "pc" && action === "swap") {
      // 내부 명령 — pc run 이 자동 업그레이드 때 세션 밖에 띄운다(사람이 칠 일은 없다).
      const versions = swapArgsOf(parsed.positionals.slice(2));
      if (!versions) throw new CliCommandError("USAGE", "Usage: ainecto pc swap --from <version> --to <version>");
      const swapPaths = agentPaths();
      await ensurePrivateDir(swapPaths.dir);
      return await executePcSwap({
        ...versions,
        packageName: PACKAGE_NAME,
        pc: (version, skip) => ({
          ...pcDeps(),
          flags: { env: parsed.env, endpoint: parsed.endpoint, ...(skip ? { skipUpgrade: skip } : {}) },
          cliVersion: version,
          managedCommand: (args) => npxCliCommand(args, version),
        }),
        runner: (cwd) => systemCommandRunner({ cwd }),
        fetchJson: async (url) => {
          const response = await fetch(url, { signal: AbortSignal.timeout(pcReadyDeadlineMs()) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json();
        },
        makeTempDir: () => mkdtemp(join(tmpdir(), "ainecto-upgrade-")),
        removeDir: (path) => rm(path, { recursive: true, force: true }),
        home: homedir(),
        log: openAgentLog(swapPaths),
      });
    }
    if (domain === "agent" && action === "serve") {
      // ★두 방식 금지 — 앞에서 따로 돌리면 pc 연결과 서버 링크를 서로 뺏는다.
      throw new CliCommandError("MOVED", "`ainecto agent serve` is now `ainecto start` (or just `ainecto` in a terminal): it keeps your PC agent running in the background. Stop it with `ainecto stop`.");
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
      // ★목록을 못 받았으면 «없는 명령»이 아니다 — 서버의 코드·사유를 그대로 올린다(리뷰 r1 P1-6). 받았는데 없을 때만 미등록.
      const live = await loadLiveTools(env, connect().client).catch(liveListFailure);
      const match = matchGeneratedCommand(live, parsed.positionals);
      if (match) {
        // 목록은 이름·한 줄뿐 — 부를 operation 하나의 상세(inputSchema)를 받아 그것으로 인자를 읽는다.
        routeTools = [await loadLiveTool(env, connect().client, match.tool.mcpName)];
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
    io.stdout.write(renderSuccess(tools.map(catalogLine), { json: parsed.json, warnings: [CATALOG_DETAIL_HINT] }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    io.stdout.write(renderSuccess(getGeneratedTools(catalogEnv).map(catalogLine), {
      json: parsed.json,
      warnings: [CATALOG_DETAIL_HINT, `Could not read the live tool list from ${endpoint} (${reason}). `
        + `Showing the ${catalogEnv} catalog checked in when this CLI version was built — a snapshot of that `
        + "server's tools/list that may miss newer document types and tools. Run `ainecto auth login`, then retry."],
    }));
  }
  return 0;
}

/**
 * 스냅샷에 없는 명령을 찾으려고 서버 operation 목록을 받다가 실패 — 서버가 밝힌 코드·세부는 그대로 두고, 무엇을 하다 실패했는지만 앞에 붙인다.
 * ★입력한 낱말은 하나도 싣지 않는다 — 목록을 못 받았으니 어디까지가 명령이고 어디부터가 값(인라인 JSON 등)인지 알 수 없다.
 *   고정 문맥 + 서버 사유만(리뷰 r2 P1-5 · r3 P1).
 */
function liveListFailure(error: unknown): never {
  const cause = error instanceof Error ? error : new Error(String(error));
  const failure = new Error(`This command is not in this CLI's catalog, and the server's operation list could not be read: ${cause.message}`) as Error & {
    code?: string; details?: unknown;
  };
  const source = cause as Error & { code?: unknown; details?: unknown };
  failure.code = typeof source.code === "string" ? source.code : "LIVE_CATALOG_UNAVAILABLE";
  if (source.details !== undefined) failure.details = source.details;
  throw failure;
}

/** 카탈로그 한 줄 — 라이브(search 목록)와 스냅샷이 같은 모양이게. 입력 형식은 상세에서 본다({@link CATALOG_DETAIL_HINT}). */
function catalogLine(tool: GeneratedToolDefinition): { operation: string; command: string; description: string } {
  return { operation: tool.mcpName, command: `ainecto ${tool.commandPath.join(" ")}`, description: tool.description };
}

const CATALOG_DETAIL_HINT = "Each line is an operation. For its input format, run "
  + "`ainecto tools call search '{\"operation\":\"<operation>\"}'`; run it with its command or `ainecto tools call <operation> '<json>'`.";

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
    if (arg === "--") {
      // ★`--` 뒤는 하위 명령의 몫이다 — `term new x -- claude --version` 의 --version 을 여기서 먹으면 CLI 판이 찍힌다.
      result.positionals.push(...argv.slice(index));
      break;
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
    "  ainecto setup [--env prod|dev] [--endpoint URL] [--dry-run] [--json]   sign in and connect Claude Code, Cursor, Codex, and Antigravity to the server address",
    "  ainecto setup --local                                                  connect through the local relay (npx -y @ainecto/mcp) instead",
    "  ainecto setup --undo                                                   remove those connections (sign-in stays)",
    "  ainecto status [--json]                                                who is signed in, and what is connected (read-only)",
    "  ainecto doctor [--json]                                                status + what is missing and the command that fixes it",
    "",
    "Harness:",
    "  ainecto init [--mcp] [--local] [--dry-run] [--json]   AiNecto rules for this repository (--mcp also writes .mcp.json, .cursor/mcp.json and .agents/mcp_config.json with the server address; --local writes the local relay instead)",
    "  ainecto init --agent NAME                             name the agent working in this folder: writes .ainecto/agent.local (do not commit it) and puts the name in .mcp.json, .cursor/mcp.json, .agents/mcp_config.json and .codex/config.toml",
    "  ainecto init --undo",
    "",
    "This PC (requests from AiNecto Chat and auto-run cards, answered by Claude Code or Codex on this machine):",
    ...AGENT_HELP_LINES,
    "",
    "Terminal sessions on this machine (no tmux or cmux needed; macOS and Linux):",
    ...TERM_HELP_LINES,
    "",
  ].join("\n");
}
