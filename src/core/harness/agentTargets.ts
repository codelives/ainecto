import { isDefaultEndpointFor } from "../config/endpoints";
import { HARNESS_ROLES, type HarnessRole } from "./role";

/**
 * 「어느 에이전트의 어느 파일에 무엇을 적는가」.
 *
 * ★<b>MCP 항목은 «하나»만 쓴다.</b> 이것이 「하나의 세션은 하나의 역할」을 강제하는 방식이다 —
 * 네 역할을 동시에 등록해 두면 개발 세션이 설계 서버도 보게 되고, 그 순간 제약은 다시
 * 「규칙을 읽고 지켜라」로 내려앉는다. 역할을 바꾸려면 이 한 항목을 고치고 세션을 다시 연다.
 *
 * ⚠<b>Codex 는 여기 없다.</b> Codex 의 MCP 설정은 {@code $CODEX_HOME/config.toml} 전역이라
 * 프로젝트별 파일이 없다. 프로젝트에서 친 명령이 말없이 전역 설정을 고치면 다른 저장소의
 * 세션까지 역할이 걸린다. ⇒ 우리가 고치지 않고 <b>실행할 명령을 내준다</b>.
 *
 * <p>★<b>Codex 의 세션별 역할은 «프로필»로 한다</b>(2026-09-22 실측, codex 0.153.4).
 * {@code codex -p <name>} 은 {@code $CODEX_HOME/<name>.config.toml} 을 base 위에 얹고,
 * <b>같은 서버 이름이면 프로필 쪽이 base 를 덮어쓴다</b> — 합쳐지지 않는다. 그래서 서버 항목은
 * 여전히 «하나»이고 「한 세션에 한 역할」이 그대로 성립한다.
 * ⚠구식 {@code [profiles.<name>]} 테이블은 이제 «에러로» 거부된다 — 별도 파일이어야 한다.
 * ⛔CODEX_HOME 을 프로젝트별로 바꾸는 길은 auth.json 까지 갈려 로그인을 잃으므로 택하지 않았다.
 */

/** 설정에 쓰는 서버 이름. ⛔env 에 따라 바꾸지 않는다 — 도구 접두사가 흔들리고 --undo 가 못 찾는다. */
export const SERVER_NAME = "ai-erd";

export const PACKAGE_NAME = "@ai-erd/mcp";

export interface AgentTarget {
  id: "claude-code" | "cursor";
  label: string;
  /** 저장소 루트 기준 상대 경로. */
  path: string;
}

export const AGENT_TARGETS: readonly AgentTarget[] = [
  { id: "claude-code", label: "Claude Code", path: ".mcp.json" },
  { id: "cursor", label: "Cursor", path: ".cursor/mcp.json" },
];

export interface ServerEntryInput {
  role: HarnessRole;
  /** "prod" 면 인자를 안 붙인다 — 기본값을 설정에 박으면 기본이 바뀔 때 거짓이 된다. */
  env?: "prod" | "dev";
  /**
   * 기본이 아닌 엔드포인트. ⚠<b>이걸 빠뜨리면</b> init 은 이 주소에서 프로젝트를 찾아 적어
   * 놓고, 정작 에이전트는 «기본 주소»에 붙는다 — 문서가 가리키는 곳과 세션이 보는 곳이
   * 달라진다(2026-09-22 독립 리뷰 I7).
   */
  endpoint?: string;
}

export interface McpServerEntry {
  command: string;
  args: string[];
}

export function buildServerEntry(input: ServerEntryInput): McpServerEntry {
  const args = ["-y", PACKAGE_NAME, "--role", input.role];
  if (input.env && input.env !== "prod") {
    args.push("--env", input.env);
  }
  // ★«이 env 의» 기본 주소일 때만 생략한다. 넓은 기본 판정을 쓰면 dev 주소가 prod 로 해석된다.
  if (input.endpoint && !isDefaultEndpointFor(input.env ?? "prod", input.endpoint)) {
    args.push("--endpoint", input.endpoint);
  }
  return { command: "npx", args };
}

/** 설정에 적힌 항목에서 역할을 되읽는다. 설정이 곧 진실원이므로 여기서만 읽는다. */
export function readRoleFromEntry(entry: unknown): HarnessRole | undefined {
  if (!isRecord(entry) || !Array.isArray(entry.args)) {
    return undefined;
  }
  const index = entry.args.indexOf("--role");
  const value = index >= 0 ? entry.args[index + 1] : undefined;
  return typeof value === "string" && (HARNESS_ROLES as readonly string[]).includes(value)
    ? (value as HarnessRole)
    : undefined;
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
    const parsed = JSON.parse(existing) as { mcpServers?: Record<string, unknown> };
    return parsed?.mcpServers?.[SERVER_NAME];
  } catch {
    return undefined;
  }
}

export function mergeServerEntry(existing: string | undefined, entry: McpServerEntry): MergeResult {
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
 * 「백업 없음」으로 바꾼다.</b> 사용자가 {@code "ai-erd": null} 을 적어 두었고 우리가 그것을
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
  delete servers[SERVER_NAME];
  const otherKeys = Object.keys(root).filter((key) => key !== "mcpServers");
  const emptied = Object.keys(servers).length === 0 && otherKeys.length === 0;
  return { content: stringify({ ...root, mcpServers: servers }), removed, emptied };
}

/** Codex 는 전역 설정뿐이라 «우리가 고치지 않는다». 사용자가 칠 명령을 내준다. */
export function codexAddCommand(input: ServerEntryInput): string {
  const entry = buildServerEntry(input);
  return `codex mcp add ${SERVER_NAME} -- ${entry.command} ${entry.args.join(" ")}`;
}

/**
 * Codex 에서 역할을 세션마다 바꾸는 법. ★프로필 파일이 같은 이름의 서버를 덮어쓰므로
 * 항목은 하나로 유지된다.
 */
export function codexProfileSetup(input: ServerEntryInput): string[] {
  const entry = buildServerEntry(input);
  return [
    `Per-session roles in Codex use profiles. Put this in $CODEX_HOME/${input.role}.config.toml:`,
    "",
    `    [mcp_servers.${SERVER_NAME}]`,
    `    command = "${entry.command}"`,
    `    args = ${JSON.stringify(entry.args)}`,
    "",
    `Then start that session with: codex -p ${input.role}`,
    "A profile entry with the same server name replaces the global one, so the session still sees exactly one.",
  ];
}

export function codexRemoveCommand(): string {
  return `codex mcp remove ${SERVER_NAME}`;
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
