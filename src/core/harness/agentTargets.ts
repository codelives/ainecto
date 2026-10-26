import { basename } from "node:path";
import { isDefaultEndpoint, isDefaultEndpointFor, normalizeEndpoint } from "../config/endpoints";
import { bridgePackageSpec, PACKAGE_NAME } from "../version";
import { AGENT_NAME_HEADER } from "../mcp/rpcClient";

/**
 * 「어느 에이전트의 어느 파일에 무엇을 적는가」.
 *
 * ★<b>MCP 항목은 «하나»만 쓴다</b> — 이름 {@link SERVER_NAME}. 저장소 파일은 브리지 {@code npx -y @ainecto/mcp@<판>},
 * 저장소 파일·기기 전역 연결 모두 서버 주소(원격 MCP)가 기본이다({@link REMOTE_SIGN_IN} 표).
 * 세션 역할은 없다(0.8.0): 모든 세션이 같은 도구를 보고, 무엇을 할 수 있는지는 서버가 권한으로 정한다.
 *
 * <p>저장소 파일({@code .mcp.json}·{@code .cursor/mcp.json})은 {@code init --mcp} 가, 기기 전역 연결
 * (Claude Code 사용자 범위·Cursor 전역·Codex)은 {@code setup} 이 쓴다. 둘 다 이 파일의 항목 결정
 * ({@link desiredServerEntry})과 소유 판정({@link isOurEntry})을 쓴다 — 기록 파일을 따로 두지 않는다.
 */

/** 설정에 쓰는 서버 이름. ⛔env 에 따라 바꾸지 않는다 — 도구 접두사가 흔들리고 --undo 가 못 찾는다. */
export const SERVER_NAME = "ainecto";

export type AgentClientId = "claude-code" | "cursor" | "codex";

export interface AgentTarget {
  id: Extract<AgentClientId, "claude-code" | "cursor">;
  label: string;
  /** 저장소 루트 기준 상대 경로. */
  path: string;
}

export const AGENT_TARGETS: readonly AgentTarget[] = [
  { id: "claude-code", label: "Claude Code", path: ".mcp.json" },
  { id: "cursor", label: "Cursor", path: ".cursor/mcp.json" },
];

export interface ServerEntryInput {
  /** "prod" 면 인자를 안 붙인다 — 기본값을 설정에 박으면 기본이 바뀔 때 거짓이 된다. */
  env?: "prod" | "dev";
  /**
   * 기본이 아닌 엔드포인트. ⚠<b>이걸 빠뜨리면</b> 문서가 가리키는 곳과 세션이 붙는 곳이
   * 달라진다(2026-09-22 독립 리뷰 I7).
   */
  endpoint?: string;
  /** 브리지 패키지 지정. 기본은 이 CLI 판으로 고정한 {@link bridgePackageSpec}. */
  packageSpec?: string;
  /** 이 폴더의 에이전트 이름 — 있으면 브리지 인자 {@code --agent <이름>}. */
  agentName?: string;
}

export interface McpServerEntry {
  command: string;
  args: string[];
}

/** 서버 주소를 직접 적는 항목(원격 MCP) — 기본. {@code type} 은 Claude Code 파일에만 붙는다. */
export interface RemoteServerEntry {
  type?: "http";
  url: string;
  /** 이 폴더의 에이전트 이름 헤더({@code init --agent}). Claude Code·Cursor 의 원격 항목이 같은 칸 이름을 쓴다. */
  headers?: Record<string, string>;
}

/** {@code ainecto} 항목의 모양 — 명령형(로컬 중계, stdio) 또는 주소형(원격). 지금 있는 것과 쓸 것이 같은 모양이다. */
export type AgentEntry = McpServerEntry | RemoteServerEntry;

/**
 * ★대상별 원격(HTTP) MCP 지원 표 — 한 곳. 있으면 서버 주소를 등록하고 값은 «첫 로그인 안내»다.
 * 없는 대상만 로컬 중계를 쓴다. 근거는 각 도구의 공식 형식(2026-10-21 실측):
 * <ul>
 *   <li>Claude Code 2.1.306 — {@code claude mcp add --transport http -s user <name> <url>}
 *       ({@code claude mcp add --help} 의 «Add HTTP server» 예). {@code ~/.claude.json}·{@code .mcp.json} 에
 *       {@code {type:"http",url}} — ★{@code .mcp.json} 은 {@code type} 이 없으면 항목을 못 읽는다(실측).
 *       {@code claude mcp get} 이 «Needs authentication» 을 보이고, 세션의 {@code /mcp} 에서 로그인한다.</li>
 *   <li>Cursor — {@code ~/.cursor/mcp.json}·{@code .cursor/mcp.json} 의 {@code {"url": …}} (docs.cursor.com «Model Context Protocol» 의
 *       Remote server 형식). 로그인은 Cursor 가 MCP 설정 화면에서 띄운다.</li>
 *   <li>Codex 0.163.0 — {@code codex mcp add <name> --url <url>} (streamable HTTP). ★add 가 서버의 OAuth 를
 *       감지하면 그 자리에서 브라우저 로그인을 시작한다(«Detected OAuth support. Starting OAuth flow»).
 *       못 마치면 {@code codex mcp login <name>}. 같은 이름은 stdio↔url 어느 쪽으로든 덮어쓴다.</li>
 * </ul>
 */
export const REMOTE_SIGN_IN: Partial<Record<AgentClientId, string>> = {
  "claude-code": `Claude Code — in a session, run /mcp, pick "${SERVER_NAME}" and sign in`,
  cursor: `Cursor — sign in when "${SERVER_NAME}" asks for it in Cursor's MCP settings`,
  codex: `Codex — signs in while setup connects it (its sign-in link is printed above); if that did not finish, run \`codex mcp login ${SERVER_NAME}\``,
};

/** {@code ainecto} 항목의 모양 — 명령형(로컬 중계, stdio) 또는 주소형(원격). 지금 있는 것과 쓸 것이 같은 모양이다. */
/**
 * ★이 클라이언트에 쓸 항목 — setup·init 의 «한» 결정. 원격을 지원하면({@link REMOTE_SIGN_IN}) 서버 주소,
 * 아니면(또는 {@code --local}) 판 고정한 로컬 중계. 주소는 호출자가 해석한 엔드포인트 하나다({@code resolveEndpoint}).
 */
export function desiredServerEntry(input: {
  client: AgentClientId;
  env: "prod" | "dev";
  endpoint: string;
  local: boolean;
  /** 브리지 패키지 지정(시험용). */
  packageSpec?: string;
  /**
   * 이 폴더의 에이전트 이름({@code init --agent}). 원격이면 {@link AGENT_NAME_HEADER} 헤더, 로컬 중계면
   * {@code --agent} 인자로 싣는다. 없으면 이름 없는 연결 — 지금 항목과 같다. setup(기기 전역)은 넘기지 않는다.
   */
  agentName?: string;
}): AgentEntry {
  if (REMOTE_SIGN_IN[input.client] === undefined || input.local) {
    return buildServerEntry({ env: input.env, endpoint: input.endpoint, packageSpec: input.packageSpec, agentName: input.agentName });
  }
  const headers = input.agentName === undefined ? {} : { headers: { [AGENT_NAME_HEADER]: input.agentName } };
  return input.client === "claude-code" ? { type: "http", url: input.endpoint, ...headers } : { url: input.endpoint, ...headers };
}

/** Codex 의 폴더별 설정 — 신뢰한 저장소에서만 Codex 가 읽는다. init 이 에이전트 이름이 있을 때만 쓴다. */
export const CODEX_CONFIG_PATH = ".codex/config.toml";

/**
 * {@link desiredServerEntry} 가 정한 Codex 항목을 {@code .codex/config.toml} 본문으로. ★항목 결정은 위 함수 하나 —
 * 여기는 모양만 바꾼다(원격 {@code headers} → Codex 의 {@code http_headers}). 문자열은 JSON 표기로 적는다 —
 * TOML 기본 문자열의 이스케이프(\" \\ \uXXXX)와 같다.
 */
export function renderCodexConfig(entry: AgentEntry): string {
  const lines = [`[mcp_servers.${SERVER_NAME}]`];
  if ("url" in entry) {
    lines.push(`url = ${JSON.stringify(entry.url)}`);
    if (entry.headers !== undefined) {
      const pairs = Object.entries(entry.headers).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`);
      lines.push(`http_headers = { ${pairs.join(", ")} }`);
    }
  } else {
    lines.push(`command = ${JSON.stringify(entry.command)}`);
    lines.push(`args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * ★이 항목이 우리 것인가 — 우리 브리지({@link isOurBridge}) 또는 우리 서버 주소(기본 prod·dev 주소나 지금 쓰는
 * {@code endpoint}). 다른 주소·다른 명령은 남의 것이다. setup·init·status·doctor 가 이것 하나를 쓴다.
 */
export function isOurEntry(entry: unknown, endpoint: string): boolean {
  if (isRecord(entry) && typeof entry.url === "string") {
    const url = normalizedServerUrl(entry.url);
    return url !== undefined && (url === endpoint || isDefaultEndpoint(url));
  }
  return isOurBridge(entry);
}

/** 설정에 적힌 주소를 견줄 모양으로 — 못 읽는(믿을 수 없는) 주소면 undefined: 우리 것으로 보지 않는다. */
export function normalizedServerUrl(url: string): string | undefined {
  try {
    return normalizeEndpoint(url);
  } catch {
    return undefined;
  }
}

export function buildServerEntry(input: ServerEntryInput = {}): McpServerEntry {
  const args = ["-y", input.packageSpec ?? bridgePackageSpec()];
  if (input.env && input.env !== "prod") {
    args.push("--env", input.env);
  }
  // ★«이 env 의» 기본 주소일 때만 생략한다. 넓은 기본 판정을 쓰면 dev 주소가 prod 로 해석된다.
  if (input.endpoint && !isDefaultEndpointFor(input.env ?? "prod", input.endpoint)) {
    args.push("--endpoint", input.endpoint);
  }
  if (input.agentName !== undefined) {
    args.push("--agent", input.agentName);
  }
  return { command: "npx", args };
}

/** 이 항목의 브리지가 옛 {@code --role} 을 싣고 있나 — doctor 의 «옛 설정 잔존» 판정이 쓴다. */
export function entryCarriesRole(entry: unknown): boolean {
  return isRecord(entry) && Array.isArray(entry.args) && entry.args.includes("--role");
}

/** 이 항목이 고정한 브리지 판({@code @ainecto/mcp@X} 의 X). 고정하지 않았으면 undefined — doctor 의 «더 새 판» 판정. */
export function pinnedBridgeVersion(entry: unknown): string | undefined {
  if (!isRecord(entry) || !Array.isArray(entry.args)) {
    return undefined;
  }
  const pinned = entry.args.find((arg): arg is string => typeof arg === "string" && arg.startsWith(`${PACKAGE_NAME}@`));
  return pinned?.slice(PACKAGE_NAME.length + 1);
}

export interface MergeResult {
  /** 적어 넣은 결과 JSON 문자열 (끝에 줄바꿈 포함). */
  content: string;
  /** 이 파일에 우리 항목이 이미 있었나 — 보고용. */
  replaced: boolean;
  /**
   * 우리가 «밀어낸» 원래 항목. ★undo 가 이것을 도로 넣는다.
   * 없으면 undefined — 그때는 undo 가 그냥 지운다.
   */
  replacedEntry?: unknown;
}

/**
 * 기존 설정을 살린 채 우리 항목 하나만 얹는다.
 *
 * ⚠<b>남의 서버 항목을 지우지 않는다.</b> 이 파일은 사용자의 것이고 우리는 한 칸을 빌릴 뿐이다.
 * 파싱이 안 되면 덮어쓰지 말고 던진다 — 읽을 수 없는 파일을 덮으면 사용자의 설정이 사라진다.
 */
/**
 * 이 파일에 들어 있는 «우리» 서버 항목. 없거나 파일이 JSON 이 아니면 undefined.
 *
 * <p>undo 가 「우리가 쓴 그대로인가」를 보려고 쓴다 — 파일 «전체»가 아니라 우리가 소유한
 * 조각만 견주어야, 남이 다른 항목을 더한 것과 우리 항목을 손댄 것을 구별한다
 * (2026-09-23 독립 재리뷰 I8).
 */
export function readServerEntry(existing: string | undefined): unknown {
  if (existing === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(existing) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    return isRecord(servers) ? servers[SERVER_NAME] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 이 항목이 우리 브리지({@code npx -y @ainecto/mcp[@판] …} · 전역 설치한 {@code ainecto})인가.
 * 옛 {@code --role} 을 싣는 것도 우리 브리지뿐이다(0.7.x 가 쓴 항목).
 */
export function isOurBridge(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const { command, args } = entry as { command?: unknown; args?: unknown };
  const argList = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [];
  const isOurPackage = (arg: string) => arg === PACKAGE_NAME || arg.startsWith(`${PACKAGE_NAME}@`);
  if (argList.some((arg) => isOurPackage(arg) || arg === "--role")) {
    return true;
  }
  const bin = typeof command === "string" ? basename(command) : "";
  return OUR_BINS.includes(bin);
}

/**
 * 전역 설치한 우리 명령 이름(package.json bin 중 브리지를 띄울 수 있는 것). ⚠{@code mcp} 는 넣지 않는다 —
 * 흔한 이름이라 남의 명령일 수 있고, 우리 브리지로 오인하면 남의 항목을 고쳐 쓰게 된다.
 */
const OUR_BINS: readonly string[] = ["ainecto"];

export function mergeServerEntry(existing: string | undefined, entry: McpServerEntry | RemoteServerEntry): MergeResult {
  const root = parseConfigObject(existing);
  const servers = readServers(root);
  const replaced = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  const replacedEntry = replaced ? servers[SERVER_NAME] : undefined;
  servers[SERVER_NAME] = entry;
  return { content: stringify({ ...root, mcpServers: servers }), replaced, replacedEntry };
}

export interface RemoveResult {
  /** 우리 항목을 뺀 결과. 파일을 통째로 지워야 하면 undefined. */
  content?: string;
  removed: boolean;
  /** 우리 항목을 빼고 나니 아무것도 안 남았나. */
  emptied: boolean;
}

/**
 * 되돌릴 목표를 «감싸서» 받는다.
 *
 * <p>★{@code restoreEntry?: unknown} 과 {@code !== undefined} 조합은 <b>저장된 {@code null} 을
 * 「백업 없음」으로 바꾼다.</b> 사용자가 {@code "ainecto": null} 을 적어 두었고 우리가 그것을
 * 백업했다면, 되돌리기는 null 을 도로 넣어야 한다(2026-09-27 7차 독립 리뷰 I5).
 * 「값이 없다」와 「값이 null 이다」는 다른 사실이므로 그 둘을 한 자리에 담지 않는다.
 */
export interface RestoreEntry {
  value: unknown;
}

export function removeServerEntry(existing: string | undefined, restore?: RestoreEntry): RemoveResult {
  if (existing === undefined) {
    return { removed: false, emptied: false };
  }
  const root = parseConfigObject(existing);
  const servers = readServers(root);
  const removed = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  if (restore !== undefined) {
    // ★우리가 밀어낸 사용자 항목을 도로 넣는다. 지우는 것이 아니라 «되돌리는» 것이다.
    servers[SERVER_NAME] = restore.value;
    return { content: stringify({ ...root, mcpServers: servers }), removed, emptied: false };
  }
  if (removed) {
    delete servers[SERVER_NAME];
  }
  const otherKeys = Object.keys(root).filter((key) => key !== "mcpServers");
  const emptied = Object.keys(servers).length === 0 && otherKeys.length === 0;
  return { content: stringify({ ...root, mcpServers: servers }), removed, emptied };
}

/**
 * {@code mcpServers} 를 읽는다. ⚠<b>모양이 틀리면 «조용히 버리지» 않는다</b> —
 * 배열이나 문자열이 들어 있는 설정을 {@code {}} 로 갈아 끼우면 사용자의 내용이 사라진다
 * (2026-09-22 독립 리뷰 I8). 이미 깨진 설정이어도 원문을 없애는 건 우리 일이 아니다.
 */
function readServers(root: Record<string, unknown>): Record<string, unknown> {
  const servers = root.mcpServers;
  if (servers === undefined) {
    return {};
  }
  if (!isRecord(servers)) {
    throw new Error(
      "Existing MCP config has an \"mcpServers\" value that is not an object, so it was left untouched. "
      + "Fix it by hand and run init again.",
    );
  }
  return { ...servers };
}

function parseConfigObject(existing: string | undefined): Record<string, unknown> {
  if (existing === undefined || !existing.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    throw new Error(
      `Existing MCP config is not valid JSON, so it was left untouched. Fix it by hand and run init again. (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("Existing MCP config must be a JSON object; it was left untouched.");
  }
  return parsed;
}

function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
