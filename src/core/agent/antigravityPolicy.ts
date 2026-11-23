import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import { AGY_CUSTOMIZATION_DIRS, ANTIGRAVITY_MCP_SERVER } from "./antigravityArgs";

/**
 * Antigravity 차례마다 «agy 가 읽을 MCP 서버 이름» 모으기 — 설계 r3 §2-2 1~6(reviewer03 GO 11-23).
 * 결과는 «deny 할 이름 목록» 또는 «시작 안 함»(이유 · 경로). ★지원 원천 밖은 무시하지 않고 불허한다.
 * 이름 거절이 막는 것은 다른 서버의 도구 호출(tools/call)이다 — 그 서버가 뜨고 initialize 하는 것까지 막지는 않는다.
 *
 * <ol>
 *   <li>작업 폴더 = 우리 세션 폴더. 그 폴더부터 위로 {@code .git} 이 보이면 «저장소 안» → 시작 안 함(저장소 밖이면 agy 는 작업 폴더만 본다).</li>
 *   <li>작업 폴더에는 우리 {@code .agents/mcp_config.json} 하나만. 별칭 폴더·다른 파일·manifest·AGENTS.md 가 있으면 시작 안 함.</li>
 *   <li>부모부터 파일 시스템 루트까지 폴더 넷의 {@code mcp_config.json} 이름을 모은다(판이 바뀔 때를 위한 덧댐).</li>
 *   <li>전역 {@code ~/.gemini/config/mcp_config.json}(빈 파일 = 없음) · {@code agy plugin list --json} 의 플러그인(켜짐·꺼짐 모두 — 더 막아도 해가 없다).
 *       ★전역 {@code plugins.json} 은 바깥 폴더의 플러그인을 더하는데 {@code plugin list} 에 보이지 않는다(실측 1.5.14) → 있으면 시작 안 함.</li>
 *   <li>읽기·해석 실패 · 모르는 형식 · 거절 규칙에 그대로 못 싣는 이름이면 시작 안 함.</li>
 *   <li>모은 어느 원천에든 {@code ainecto-pc} 가 있으면 시작 안 함.</li>
 * </ol>
 */
export type McpPolicy = { ok: true; deny: string[] } | { ok: false; reason: string; path?: string };

export interface McpPolicyInput {
  /** 작업 폴더(우리 세션 폴더) — 이미 {@link writeWorkspaceMcpConfig} 로 우리 파일을 쓴 뒤. */
  cwd: string;
  home: string;
  /** {@code agy plugin list --json} 의 stdout — 실패면 이유. */
  pluginList(): Promise<{ ok: true; stdout: string } | { ok: false; detail: string }>;
}

/** 거절 규칙 {@code mcp(<이름>/*)} 에 그대로 실을 수 있는 이름 — 그 밖(괄호·별표·빗금 등)은 규칙이 맞을지 모르니 시작 안 함. */
const SAFE_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

class Refuse extends Error {
  constructor(readonly reason: string, readonly path?: string) {
    super(reason);
  }
}

export async function antigravityMcpPolicy(input: McpPolicyInput): Promise<McpPolicy> {
  try {
    const names = new Set<string>();
    const add = (found: readonly string[], path: string): void => {
      for (const name of found) {
        if (!SAFE_SERVER_NAME.test(name)) throw new Refuse("server name the deny rule cannot carry", path);
        if (name === ANTIGRAVITY_MCP_SERVER) throw new Refuse(`another config also names ${ANTIGRAVITY_MCP_SERVER}`, path);
        names.add(name);
      }
    };
    // 1. 저장소 안이면 시작 안 함.
    for (const dir of selfAndAncestors(input.cwd)) {
      if (existsSync(join(dir, ".git"))) throw new Refuse("work folder is inside a git repository", join(dir, ".git"));
    }
    // 2. 작업 폴더에는 우리 파일 하나만.
    await onlyEntry(input.cwd, ".agents");
    const ours = join(input.cwd, ".agents");
    await onlyEntry(ours, "mcp_config.json");
    const ourNames = await serverNames(join(ours, "mcp_config.json"));
    if (ourNames.length !== 1 || ourNames[0] !== ANTIGRAVITY_MCP_SERVER) {
      throw new Refuse("work folder config is not ours", join(ours, "mcp_config.json"));
    }
    // 3. 위쪽 폴더 넷.
    for (const dir of selfAndAncestors(dirname(input.cwd))) {
      for (const folder of AGY_CUSTOMIZATION_DIRS) {
        const file = join(dir, folder, "mcp_config.json");
        if (existsSync(file)) add(await serverNames(file), file);
      }
    }
    // 4. 전역 · 플러그인.
    const globalRoot = join(input.home, ".gemini", "config");
    const globalPlugins = join(globalRoot, "plugins.json");
    if (existsSync(globalPlugins)) throw new Refuse("global plugins.json adds plugins that agy plugin list does not show", globalPlugins);
    const globalFile = join(globalRoot, "mcp_config.json");
    if (existsSync(globalFile)) add(await serverNames(globalFile), globalFile);
    const listed = await input.pluginList();
    if (!listed.ok) throw new Refuse(`agy plugin list failed: ${listed.detail}`);
    for (const plugin of pluginEntries(listed.stdout)) {
      add(plugin.mcpServers, plugin.path);
      const file = join(plugin.path, "mcp_config.json");
      if (existsSync(file)) add(await serverNames(file), file);
    }
    return { ok: true, deny: [...names].sort() };
  } catch (error) {
    if (error instanceof Refuse) return { ok: false, reason: error.reason, ...(error.path ? { path: error.path } : {}) };
    return { ok: false, reason: `could not read the Antigravity settings: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 우리 파일을 쓴다 — 차례마다 덮어쓴다. ★임시 파일은 작업 폴더 밖(부모)에 두고 옮긴다: 작업 폴더에 다른 파일이 잠깐이라도 생기면 2번이 거절한다.
 */
export async function writeWorkspaceMcpConfig(cwd: string, config: Record<string, unknown>): Promise<void> {
  const target = join(cwd, ".agents", "mcp_config.json");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temp = join(dirname(cwd), `.${parsePath(cwd).base}.mcp_config.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

function selfAndAncestors(start: string): string[] {
  const out: string[] = [];
  let dir = start;
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

async function onlyEntry(dir: string, expected: string): Promise<void> {
  const entries = await readdir(dir);
  const others = entries.filter((name) => name !== expected);
  if (others.length > 0 || !entries.includes(expected)) {
    throw new Refuse("work folder holds something other than our config", join(dir, others[0] ?? expected));
  }
}

/** {@code mcp_config.json} 의 서버 이름 — 빈 파일 = 없음 · {@code mcpServers} 가 없으면 없음 · 그 밖의 꼴은 모르는 형식. */
async function serverNames(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  if (text.trim() === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Refuse("unreadable mcp_config.json", file);
  }
  if (!isObject(value)) throw new Refuse("unknown mcp_config.json shape", file);
  if (value.mcpServers === undefined) return [];
  if (!isObject(value.mcpServers)) throw new Refuse("unknown mcp_config.json shape", file);
  return Object.keys(value.mcpServers);
}

/** {@code agy plugin list --json} = 배열 · 항목마다 {@code path} 글 · {@code mcpServers} 는 없거나 글 배열(실측 1.5.14). */
function pluginEntries(stdout: string): Array<{ path: string; mcpServers: string[] }> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Refuse("unreadable agy plugin list");
  }
  if (!Array.isArray(value)) throw new Refuse("unknown agy plugin list shape");
  return value.map((item) => {
    if (!isObject(item) || typeof item.path !== "string") throw new Refuse("unknown agy plugin list shape");
    const servers = item.mcpServers ?? [];
    if (!Array.isArray(servers) || !servers.every((name) => typeof name === "string")) {
      throw new Refuse("unknown agy plugin list shape", item.path);
    }
    return { path: item.path, mcpServers: servers as string[] };
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
