/**
 * 알림·할 일 «폴링» 명령 — 사람이 cron/launchd 에 걸어 «새 것이 있을 때만» 에이전트를 깨우게 한다(사건 기록 S2, 설계 §6-4 (5)).
 *
 *   ainecto notifications poll --cursor-file <path> [--kinds A,B] [--workspace <uuid>] [--project <uuid>]... [--direct-only] [--limit N] [--json]
 *   ainecto notifications ack  --cursor-file <path> [--json]
 *   ainecto agent-todos poll [--workspace <uuid>] [--project <uuid>]... [--only-new --seen-file <path>] [--json]
 *
 * --project 는 여러 번 줄 수 있다(여러 프로젝트). --workspace 와 함께 주면 서버가 교집합을 준다.
 *
 * ★종료 코드: 0 = 새 항목 있음 · 3 = 새 항목 없음 · 1 = 오류 · 2 = 사용법 오류(기존 0/1/2 와 충돌하지 않는다).
 *
 * 알림 증분은 «받기 → (에이전트) → 성공했을 때만 ack» 다. poll 은 받은 배치와 ackToken 을 ★커서 파일에 먼저 저장(fsync)한 뒤
 * 출력하고, ack 전까지 다시 부르면 서버에 묻지 않고 ★같은 배치를 다시 출력한다 — 에이전트가 실패하면 다음 회차에 같은 것을
 * 다시 받는다. ack 는 파일의 보류 ackToken 을 서버에 보내고 파일에서 지운다. 서버 커서는 ack 로만 움직인다.
 *
 * 할 일은 «지금 열린 것» 의 상태 조회다. --only-new 는 본 할 일 id 를 로컬 파일에 적어 «처음 보는 것이 있을 때만» 0 을 낸다
 * (같은 할 일로 5분마다 에이전트를 깨우지 않게 — 서버 상태 0).
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpRpcClient } from "../../core/mcp/rpcClient";
import { isToolError } from "../../core/mcp/rpcClient";
import { toolErrorText, unwrapMcpToolPayload } from "../../core/mcp/toolPayload";
import { renderError, renderSuccess } from "../../core/output/render";
import { CliCommandError } from "./errors";
import { AGENT_TODOS_POLL_COMMAND_PATH, NOTIFICATIONS_ACK_COMMAND_PATH, NOTIFICATIONS_POLL_COMMAND_PATH } from "./bespokeCommands";

/** 새 항목 없음 — 셸이 `&&` 로 에이전트 실행을 건너뛰게. */
export const EXIT_NOTHING_NEW = 3;

const LIST_NOTIFICATIONS = "mcp__ainecto__list_notifications";
const LIST_AGENT_TODOS = "mcp__ainecto__list_agent_todos";

export interface InboxCommandOptions {
  domain: string | undefined;
  action: string | undefined;
  argv: string[];
  client: McpRpcClient;
  json: boolean;
  io: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream };
}

export function isInboxPollCommand(domain: string | undefined, action: string | undefined): boolean {
  return [NOTIFICATIONS_POLL_COMMAND_PATH, NOTIFICATIONS_ACK_COMMAND_PATH, AGENT_TODOS_POLL_COMMAND_PATH]
    .some(([d, a]) => d === domain && a === action);
}

/** 사용법 오류 — 종료 코드 2(설계 §6-4 (5)). */
export const EXIT_USAGE = 2;
const USAGE_ERRORS = new Set(["UNKNOWN_FLAG", "FLAG_REQUIRES_VALUE", "MISSING_REQUIRED_FLAG", "INVALID_FLAG_VALUE"]);

export async function executeInboxPollCommand(options: InboxCommandOptions): Promise<number> {
  try {
    if (options.domain === "agent-todos") return await agentTodosPoll(options);
    if (options.action === "ack") return await notificationsAck(options);
    return await notificationsPoll(options);
  } catch (error) {
    if (error instanceof CliCommandError && USAGE_ERRORS.has(error.code)) {
      options.io.stderr.write(renderError(error, { json: options.json }));
      return EXIT_USAGE;
    }
    throw error;
  }
}

// ── 알림 ────────────────────────────────────────────────────────────────

/** 범위 필터 — 알림·할 일 공용. projectUuids 는 정렬·중복 제거된 집합(없으면 undefined). */
interface ScopeFilter {
  workspaceUuid?: string;
  projectUuids?: string[];
}

interface PollFilter extends ScopeFilter {
  kinds?: string[];
  directOnly: boolean;
}

/** 0.7.0 커서 파일의 필터 모양 — 프로젝트가 하나뿐이던 때. 읽을 때 PollFilter 로 바꾼다. */
interface LegacyPollFilter extends PollFilter {
  projectUuid?: string;
}

/** 커서 파일 — 보류 중인 배치(ack 전)와 그 필터. 서버 위치는 서버가 기억한다(파일은 «아직 확인 안 한 것» 만 든다). */
interface CursorFile {
  v: 1;
  filter: PollFilter;
  stream?: string;
  ackToken?: string;
  pendingItems?: unknown[];
}

async function notificationsPoll(options: InboxCommandOptions): Promise<number> {
  const flags = parseFlags(options.argv, ["--cursor-file", "--kinds", "--workspace", "--project", "--limit"], ["--direct-only"]);
  const cursorPath = requireFlag(flags, "--cursor-file", "notifications poll");
  const filter: PollFilter = {
    kinds: flags.values["--kinds"]?.split(",").map((kind) => kind.trim()).filter(Boolean).sort(),
    ...scopeFilter(flags),
    directOnly: flags.switches.has("--direct-only"),
  };
  if (filter.kinds?.length === 0) filter.kinds = undefined;
  const limit = flags.values["--limit"] === undefined ? undefined : positiveInt("--limit", flags.values["--limit"]);

  const saved = await readCursorFile(cursorPath);
  if (saved?.ackToken && saved.pendingItems?.length) {
    if (!sameFilter(saved.filter, filter)) {
      throw new CliCommandError("PENDING_BATCH_OTHER_FILTER",
        `${cursorPath} holds an unacknowledged batch for a different filter. Run \`ainecto notifications ack --cursor-file ${cursorPath}\` `
        + "after handling it, or use another cursor file for this filter.", { cursorFile: cursorPath });
    }
    // ★ack 전까지 같은 결과 — 서버에 묻지 않는다.
    options.io.stdout.write(renderSuccess({ items: saved.pendingItems, pending: true, stream: saved.stream }, { json: options.json }));
    return 0;
  }

  const result = await callTool(options.client, LIST_NOTIFICATIONS, {
    cursor: "saved",
    ...(filter.kinds ? { kinds: filter.kinds } : {}),
    ...scopeArgs(filter),
    ...(filter.directOnly ? { directOnly: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  const items = Array.isArray(result.items) ? result.items : [];
  const stream = typeof result.stream === "string" ? result.stream : undefined;
  if (typeof result.retryAfterSeconds === "number") {
    options.io.stderr.write(`Polled too soon; try again in ${result.retryAfterSeconds}s.\n`);
    return EXIT_NOTHING_NEW;
  }
  if (items.length === 0) {
    await writeCursorFile(cursorPath, { v: 1, filter, stream });
    if (options.json) options.io.stdout.write(renderSuccess({ items: [], stream }, { json: true }));
    return EXIT_NOTHING_NEW;
  }
  // ★출력보다 저장이 먼저 — 출력 뒤에 죽어도 다음 회차가 같은 배치를 다시 낸다.
  await writeCursorFile(cursorPath, {
    v: 1, filter, stream, ackToken: typeof result.ackToken === "string" ? result.ackToken : undefined, pendingItems: items,
  });
  options.io.stdout.write(renderSuccess({ items, hasMore: result.hasMore === true, stream }, { json: options.json }));
  return 0;
}

async function notificationsAck(options: InboxCommandOptions): Promise<number> {
  const flags = parseFlags(options.argv, ["--cursor-file"], []);
  const cursorPath = requireFlag(flags, "--cursor-file", "notifications ack");
  const saved = await readCursorFile(cursorPath);
  if (!saved?.ackToken) {
    if (options.json) options.io.stdout.write(renderSuccess({ acked: false }, { json: true }));
    return EXIT_NOTHING_NEW;
  }
  // ack 는 다음 폴링 인자로 싣는다(서버 계약). 이번 응답의 다음 배치는 버린다 — ack 하지 않았으니 다음 poll 이 다시 받는다.
  await callTool(options.client, LIST_NOTIFICATIONS, {
    cursor: "saved",
    ack: saved.ackToken,
    ...(saved.filter.kinds ? { kinds: saved.filter.kinds } : {}),
    ...scopeArgs(saved.filter),
    ...(saved.filter.directOnly ? { directOnly: true } : {}),
    limit: 1,
  });
  const acked = saved.pendingItems?.length ?? 0;
  await writeCursorFile(cursorPath, { v: 1, filter: saved.filter, stream: saved.stream });
  options.io.stdout.write(renderSuccess({ acked: true, items: acked }, { json: options.json }));
  return 0;
}

// ── 할 일 ────────────────────────────────────────────────────────────────

async function agentTodosPoll(options: InboxCommandOptions): Promise<number> {
  const flags = parseFlags(options.argv, ["--workspace", "--project", "--seen-file"], ["--only-new"]);
  const scope = scopeArgs(scopeFilter(flags));
  const onlyNew = flags.switches.has("--only-new");
  const seenPath = flags.values["--seen-file"];
  if (onlyNew && !seenPath) {
    throw new CliCommandError("MISSING_REQUIRED_FLAG", "--only-new needs --seen-file <path>.", { flag: "--seen-file" });
  }
  const items: Array<Record<string, unknown>> = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await callTool(options.client, LIST_AGENT_TODOS, { state: ["OPEN"], ...scope, limit: 50, ...(after ? { after } : {}) });
    const pageItems = Array.isArray(result.items) ? result.items.filter(isRecord) : [];
    items.push(...pageItems);
    const last = pageItems[pageItems.length - 1];
    if (result.hasMore !== true || !last || typeof last.todoId !== "string") break;
    after = last.todoId;
  }
  let shown = items;
  if (onlyNew && seenPath) {
    const seen = new Set(await readSeenFile(seenPath));
    shown = items.filter((item) => typeof item.todoId === "string" && !seen.has(item.todoId));
    // 본 목록 = 지금 열린 것(닫힌 것은 빠진다 — 파일이 끝없이 자라지 않게).
    await writeJsonAtomic(seenPath, items.map((item) => item.todoId).filter((id): id is string => typeof id === "string"));
  }
  if (shown.length === 0) {
    if (options.json) options.io.stdout.write(renderSuccess({ items: [] }, { json: true }));
    return EXIT_NOTHING_NEW;
  }
  options.io.stdout.write(renderSuccess({ items: shown }, { json: options.json }));
  return 0;
}

// ── 도우미 ──────────────────────────────────────────────────────────────

async function callTool(client: McpRpcClient, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await client.toolsCall(name, args);
  if (isToolError(raw)) {
    throw new CliCommandError("TOOL_ERROR", toolErrorText(raw), { tool: name });
  }
  const payload = unwrapMcpToolPayload(raw);
  if (!isRecord(payload)) {
    throw new CliCommandError("MCP_PROTOCOL_ERROR", `${name} did not return an object.`, { tool: name });
  }
  return payload;
}

interface ParsedFlags {
  /** 값 플래그의 마지막 값. */
  values: Record<string, string | undefined>;
  /** 값 플래그의 모든 값(반복 가능한 플래그용, 준 순서). */
  lists: Record<string, string[]>;
  switches: Set<string>;
}

/** --workspace(1개) · --project(반복) → 범위 필터. 프로젝트는 정렬·중복 제거 — 같은 집합이면 같은 필터. */
function scopeFilter(flags: ParsedFlags): ScopeFilter {
  const projects = [...new Set(flags.lists["--project"] ?? [])].sort();
  return {
    ...(flags.values["--workspace"] ? { workspaceUuid: flags.values["--workspace"] } : {}),
    ...(projects.length ? { projectUuids: projects } : {}),
  };
}

/**
 * 범위 필터 → 서버 인자. ★준 것만 키로 싣는다(옛 서버는 모르는 필드를 거절한다).
 * 프로젝트 1개는 문자열(옛 서버 호환), 2개 이상은 배열.
 */
function scopeArgs(filter: ScopeFilter): Record<string, unknown> {
  const projects = filter.projectUuids ?? [];
  return {
    ...(filter.workspaceUuid ? { workspaceUuid: filter.workspaceUuid } : {}),
    ...(projects.length === 1 ? { projectUuid: projects[0] } : {}),
    ...(projects.length > 1 ? { projectUuid: projects } : {}),
  };
}

function parseFlags(argv: string[], valueFlags: string[], switchFlags: string[]): ParsedFlags {
  const values: Record<string, string | undefined> = {};
  const lists: Record<string, string[]> = {};
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (valueFlags.includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliCommandError("FLAG_REQUIRES_VALUE", `${arg} requires a value.`, { flag: arg });
      }
      values[arg] = value;
      (lists[arg] ??= []).push(value);
      index += 1;
    } else if (switchFlags.includes(arg)) {
      switches.add(arg);
    } else {
      throw new CliCommandError("UNKNOWN_FLAG", `Unknown argument ${arg}.`, { flag: arg });
    }
  }
  return { values, lists, switches };
}

function requireFlag(flags: ParsedFlags, flag: string, command: string): string {
  const value = flags.values[flag];
  if (!value) throw new CliCommandError("MISSING_REQUIRED_FLAG", `${command} needs ${flag} <path>.`, { flag });
  return value;
}

function positiveInt(flag: string, value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new CliCommandError("INVALID_FLAG_VALUE", `${flag} must be a positive integer.`, { flag, value });
  }
  return Number.parseInt(value, 10);
}

function sameFilter(a: PollFilter, b: PollFilter): boolean {
  return JSON.stringify(a.kinds ?? []) === JSON.stringify(b.kinds ?? [])
    && (a.workspaceUuid ?? "") === (b.workspaceUuid ?? "")
    && JSON.stringify(a.projectUuids ?? []) === JSON.stringify(b.projectUuids ?? [])
    && a.directOnly === b.directOnly;
}

/** 0.7.0 파일의 projectUuid(문자열 1개)를 projectUuids 집합으로 — 옛 보류 배치도 같은 필터로 알아보고 ack 한다. */
function normalizeSavedFilter(saved: LegacyPollFilter): PollFilter {
  const { projectUuid, ...rest } = saved;
  if (rest.projectUuids?.length || !projectUuid) return rest;
  return { ...rest, projectUuids: [projectUuid] };
}

async function readCursorFile(path: string): Promise<CursorFile | undefined> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined || !text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as CursorFile;
    if (parsed?.v !== 1 || !isRecord(parsed.filter)) throw new Error("shape");
    return { ...parsed, filter: normalizeSavedFilter(parsed.filter) };
  } catch {
    throw new CliCommandError("INVALID_CURSOR_FILE", `${path} is not a cursor file written by ainecto notifications poll.`, { cursorFile: path });
  }
}

async function writeCursorFile(path: string, value: CursorFile): Promise<void> {
  await writeJsonAtomic(path, value);
}

async function readSeenFile(path: string): Promise<string[]> {
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!text?.trim()) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    throw new CliCommandError("INVALID_SEEN_FILE", `${path} is not a seen file written by ainecto agent-todos poll.`, { seenFile: path });
  }
}

/** 임시 파일에 쓰고 fsync 한 뒤 바꿔 끼운다 — 중간에 죽어도 반쯤 쓴 파일이 남지 않는다. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
