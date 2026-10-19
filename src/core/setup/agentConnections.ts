import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  buildServerEntry,
  entryCarriesRole,
  isOurBridge,
  mergeServerEntry,
  readServerEntry,
  removeServerEntry,
  SERVER_NAME,
  type McpServerEntry,
} from "../harness/agentTargets";
import { PACKAGE_NAME } from "../version";
import { lastLine, type CommandRunner } from "./commandRunner";

/**
 * ★기기 전역의 에이전트 연결 — Claude Code(사용자 범위) · Cursor(전역 {@code ~/.cursor/mcp.json}) · Codex.
 * setup 이 쓰고(connect/disconnect), status·doctor 가 읽는다(inspect). 셋이 같은 판정을 쓴다.
 *
 * <p>소유 판정은 {@link isOurBridge} 하나다 — 기록 파일을 따로 두지 않는다. 남의 {@code ainecto} 항목
 * (원격 URL 등)은 건드리지 않고 그대로 보고한다.
 *
 * <p>Claude Code·Codex 는 그 도구의 CLI({@code claude mcp …}·{@code codex mcp …})로만 고친다 — 설정 파일
 * 형식을 우리가 쓰지 않는다. Cursor 는 CLI 가 없어 우리가 JSON 을 병합한다(남의 항목·다른 키 보존).
 */

export type AgentClientId = "claude-code" | "cursor" | "codex";

export const AGENT_CLIENT_LABELS: Record<AgentClientId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  codex: "Codex",
};

/** 지금 있는 {@code ainecto} 항목의 모양. 명령형(stdio) 또는 주소형. */
export type ExistingEntry = { command: string; args: string[] } | { url: string };

export interface AgentState {
  client: AgentClientId;
  installed: boolean;
  /** 항목이 있는 범위 — Claude: user·local·project / Cursor·Codex: global. */
  scope?: string;
  entry?: ExistingEntry;
  /** 우리 브리지 항목인가. */
  ours: boolean;
  /** 옛 {@code --role} 을 싣고 있나(0.7.x 의 흔적). */
  carriesRole: boolean;
  /** 고정한 브리지 판({@code @ainecto/mcp@X}). 고정하지 않았으면 undefined. */
  pinnedVersion?: string;
  /** 읽다가 막힌 이유 — 있으면 상태를 모른다. */
  problem?: string;
}

export type ConnectionStatus =
  | "connected" | "updated" | "kept" | "not installed" | "failed" | "removed" | "not connected";

export interface ConnectionOutcome {
  client: AgentClientId;
  label: string;
  status: ConnectionStatus;
  /** dry-run 이면 «했을» 일이다. */
  planned?: true;
  detail?: string;
}

export interface AgentContext {
  runner: CommandRunner;
  /** 사용자 홈 — Cursor 전역 설정의 자리. 시험은 임시 폴더를 준다. */
  home: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 읽기
// ─────────────────────────────────────────────────────────────────────────────

export async function inspectAgents(context: AgentContext): Promise<AgentState[]> {
  return [await inspectClaude(context), await inspectCursor(context), await inspectCodex(context)];
}

const NOT_FOUND = /No MCP server named/i;

/**
 * Claude Code. {@code claude mcp get ainecto} 는 «이긴» 범위 하나를 말한다(local > project > user).
 * setup 은 홈 폴더에서 실행해 저장소의 local·project 범위가 끼지 않게 한다(실행기의 cwd).
 */
export async function inspectClaude({ runner }: AgentContext): Promise<AgentState> {
  const base = { client: "claude-code" as const, ours: false, carriesRole: false };
  const result = await runner("claude", ["mcp", "get", SERVER_NAME]);
  if (result.missing) {
    return { ...base, installed: false };
  }
  if (result.exitCode !== 0) {
    return NOT_FOUND.test(result.stdout + result.stderr)
      ? { ...base, installed: true }
      : { ...base, installed: true, problem: lastLine(result.stderr) ?? `claude mcp get exited ${result.exitCode}` };
  }
  const field = (name: string) => result.stdout.match(new RegExp(`^\\s*${name}:\\s*(.*)$`, "m"))?.[1]?.trim();
  const scopeText = field("Scope") ?? "";
  const scope = /^user/i.test(scopeText) ? "user" : /^local/i.test(scopeText) ? "local"
    : /^project/i.test(scopeText) ? "project" : scopeText || undefined;
  const url = field("URL");
  const command = field("Command");
  const entry: ExistingEntry | undefined = url
    ? { url }
    : command ? { command, args: (field("Args") ?? "").split(/\s+/).filter(Boolean) } : undefined;
  return { ...base, installed: true, scope, ...describe(entry) };
}

export async function inspectCursor({ home }: AgentContext): Promise<AgentState> {
  const base = { client: "cursor" as const, ours: false, carriesRole: false, scope: "global" };
  if (!(await exists(join(home, ".cursor")))) {
    return { ...base, installed: false };
  }
  let content: string | undefined;
  try {
    content = await readFile(cursorConfigPath(home), "utf8");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      return { ...base, installed: true, problem: error instanceof Error ? error.message : String(error) };
    }
  }
  if (content !== undefined && content.trim()) {
    try {
      JSON.parse(content);
    } catch {
      return { ...base, installed: true, problem: `${cursorConfigPath(home)} is not valid JSON` };
    }
  }
  const raw = readServerEntry(content);
  return { ...base, installed: true, ...describe(toExisting(raw)) };
}

export async function inspectCodex({ runner }: AgentContext): Promise<AgentState> {
  const base = { client: "codex" as const, ours: false, carriesRole: false, scope: "global" };
  const result = await runner("codex", ["mcp", "get", SERVER_NAME, "--json"]);
  if (result.missing) {
    return { ...base, installed: false };
  }
  if (result.exitCode !== 0) {
    return NOT_FOUND.test(result.stdout + result.stderr)
      ? { ...base, installed: true }
      : { ...base, installed: true, problem: lastLine(result.stderr) ?? `codex mcp get exited ${result.exitCode}` };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { transport?: { command?: unknown; args?: unknown; url?: unknown } };
    const transport = parsed.transport ?? {};
    return { ...base, installed: true, ...describe(toExisting(transport)) };
  } catch {
    return { ...base, installed: true, problem: "codex mcp get --json did not return JSON" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 쓰기
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 한 클라이언트를 우리 브리지에 연결한다. ★남의 항목은 건드리지 않는다. 실패는 그 클라이언트만의 결과다 —
 * 던지지 않는다(나머지 클라이언트는 계속한다).
 */
export async function connectAgent(
  state: AgentState,
  desired: McpServerEntry,
  context: AgentContext,
  dryRun: boolean,
): Promise<ConnectionOutcome> {
  const outcome = (status: ConnectionStatus, detail?: string): ConnectionOutcome => ({
    client: state.client, label: AGENT_CLIENT_LABELS[state.client], status,
    ...(dryRun && (status === "connected" || status === "updated") ? { planned: true as const } : {}),
    ...(detail ? { detail } : {}),
  });
  if (!state.installed) {
    return outcome("not installed");
  }
  if (state.problem) {
    return outcome("failed", state.problem);
  }
  if (state.entry && (!state.ours || (state.client === "claude-code" && state.scope !== "user"))) {
    return outcome("kept", keptDetail(state));
  }
  if (state.entry && sameEntry(state.entry, desired)) {
    return outcome("connected", "already connected");
  }
  const updating = state.entry !== undefined;
  const commands = writeCommands(state.client, desired, updating);
  if (dryRun) {
    return outcome(updating ? "updated" : "connected", commands.length > 0 ? `would run: ${commands.map((c) => c.join(" ")).join(" && ")}` : `would write ${cursorConfigPath(context.home)}`);
  }
  try {
    if (state.client === "cursor") {
      const path = cursorConfigPath(context.home);
      await writeKeepingMode(path, mergeServerEntry(await readIfExists(path), desired).content);
    }
    for (const [command, ...args] of commands) {
      const result = await context.runner(command!, args);
      if (result.exitCode !== 0) {
        return outcome("failed", `${[command, ...args].join(" ")}: ${lastLine(result.stderr) ?? lastLine(result.stdout) ?? `exit ${result.exitCode}`}`);
      }
    }
  } catch (error) {
    return outcome("failed", error instanceof Error ? error.message : String(error));
  }
  return outcome(updating ? "updated" : "connected");
}

/** 우리 브리지 항목만 지운다(setup --undo). 로그인은 그대로다 — `ainecto auth logout` 이 따로 있다. */
export async function disconnectAgent(state: AgentState, context: AgentContext, dryRun: boolean): Promise<ConnectionOutcome> {
  const outcome = (status: ConnectionStatus, detail?: string): ConnectionOutcome => ({
    client: state.client, label: AGENT_CLIENT_LABELS[state.client], status,
    ...(dryRun && status === "removed" ? { planned: true as const } : {}),
    ...(detail ? { detail } : {}),
  });
  if (!state.installed) {
    return outcome("not installed");
  }
  if (state.problem) {
    return outcome("failed", state.problem);
  }
  if (!state.entry) {
    return outcome("not connected");
  }
  if (!state.ours || (state.client === "claude-code" && state.scope !== "user")) {
    return outcome("kept", keptDetail(state));
  }
  if (dryRun) {
    return outcome("removed");
  }
  try {
    if (state.client === "cursor") {
      const path = cursorConfigPath(context.home);
      const removed = removeServerEntry(await readIfExists(path));
      if (removed.content !== undefined) {
        await writeKeepingMode(path, removed.content);
      }
    } else {
      const [command, ...args] = removeCommand(state.client);
      const result = await context.runner(command!, args);
      if (result.exitCode !== 0) {
        return outcome("failed", `${[command, ...args].join(" ")}: ${lastLine(result.stderr) ?? `exit ${result.exitCode}`}`);
      }
    }
  } catch (error) {
    return outcome("failed", error instanceof Error ? error.message : String(error));
  }
  return outcome("removed");
}

/** setup 이 쓰는 우리 항목 — init 과 같은 모양(판 고정). */
export function desiredEntry(input: { env: "prod" | "dev"; endpoint: string }): McpServerEntry {
  return buildServerEntry({ env: input.env, endpoint: input.endpoint });
}

export function cursorConfigPath(home: string): string {
  return join(home, ".cursor", "mcp.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// 내부
// ─────────────────────────────────────────────────────────────────────────────

function writeCommands(client: AgentClientId, entry: McpServerEntry, updating: boolean): string[][] {
  const bridge = [entry.command, ...entry.args];
  if (client === "claude-code") {
    // 같은 범위에 같은 이름이 있으면 add 가 거절한다 — 우리 것일 때만 지우고 다시 넣는다.
    return [
      ...(updating ? [["claude", "mcp", "remove", "-s", "user", SERVER_NAME]] : []),
      ["claude", "mcp", "add", "-s", "user", SERVER_NAME, "--", ...bridge],
    ];
  }
  if (client === "codex") {
    // codex mcp add 는 같은 이름을 덮어쓴다(0.163 실측).
    return [["codex", "mcp", "add", SERVER_NAME, "--", ...bridge]];
  }
  return [];
}

function removeCommand(client: Exclude<AgentClientId, "cursor">): string[] {
  return client === "claude-code"
    ? ["claude", "mcp", "remove", "-s", "user", SERVER_NAME]
    : ["codex", "mcp", "remove", SERVER_NAME];
}

function keptDetail(state: AgentState): string {
  if (state.client === "claude-code" && state.ours && state.scope !== "user") {
    return `a ${state.scope}-scope "${SERVER_NAME}" entry takes precedence here — left as it is`;
  }
  const where = state.scope ? ` (${state.scope})` : "";
  return `someone else's "${SERVER_NAME}" entry${where} — left untouched`;
}

function describe(entry: ExistingEntry | undefined): Pick<AgentState, "entry" | "ours" | "carriesRole" | "pinnedVersion"> {
  if (!entry) {
    return { ours: false, carriesRole: false };
  }
  if ("url" in entry) {
    return { entry, ours: false, carriesRole: false };
  }
  const pinned = entry.args.find((arg) => arg.startsWith(`${PACKAGE_NAME}@`));
  return {
    entry,
    ours: isOurBridge(entry),
    carriesRole: entryCarriesRole(entry),
    ...(pinned ? { pinnedVersion: pinned.slice(PACKAGE_NAME.length + 1) } : {}),
  };
}

function toExisting(raw: unknown): ExistingEntry | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const { command, args, url } = raw as { command?: unknown; args?: unknown; url?: unknown };
  if (typeof url === "string" && url) {
    return { url };
  }
  if (typeof command === "string") {
    return { command, args: Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [] };
  }
  return undefined;
}

function sameEntry(entry: ExistingEntry, desired: McpServerEntry): boolean {
  return "command" in entry && entry.command === desired.command
    && entry.args.length === desired.args.length && entry.args.every((arg, at) => arg === desired.args[at]);
}

async function writeKeepingMode(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode: number | undefined;
  try {
    mode = (await stat(path)).mode & 0o7777;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode: mode ?? 0o600 });
  if (mode !== undefined) {
    await chmod(tmp, mode);
  }
  await rename(tmp, path);
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
