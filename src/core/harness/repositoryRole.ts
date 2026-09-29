import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { AGENT_TARGETS, readRoleFromEntry, SERVER_NAME } from "./agentTargets";
import { HARNESS_ROLES, type HarnessRole } from "./role";

/**
 * ★저장소 역할의 SSOT (설계 0.4.2 §2-1).
 *
 * <p>역할이 «저장된 곳»은 하나다 — init 이 쓴 {@code .mcp.json}·{@code .cursor/mcp.json} 의 {@code ai-erd}
 * 항목의 {@code --role}. 에이전트가 실제로 읽는 값이 그것이므로 다른 곳({@code .ai-erd/config.json} 등)에
 * 두 번째 기록을 두지 않는다. init 의 역할 추론과 셸 CLI 의 역할 결정이 모두 이 모듈을 지난다.
 */

/** 명령이 찾은 저장소 역할. */
export type RepositoryRole =
  | { kind: "none" }
  | { kind: "role"; role: HarnessRole; dir: string }
  | { kind: "conflict"; dir: string; reason: string };

/** 파일 스냅샷에서 읽은 역할과, 역할을 «읽어 낼 수 없었던» 이유들. */
export interface RolesInFiles {
  /** 중복 없는 역할. 둘 이상이면 설정끼리 어긋난 것이다. */
  roles: HarnessRole[];
  /** 읽기 문제(JSON 아님, --role 없는 ai-erd 항목 등). */
  problems: string[];
  /** 어느 파일이든 ai-erd 항목(또는 읽기 문제)이 있었나 — 이 폴더가 «ai-erd 폴더»인가. */
  found: boolean;
}

/**
 * 스냅샷(경로 → 내용)에서 역할을 읽는다. 순수 함수.
 *
 * <p>init 은 {@code roles} 만 본다(자기가 그 파일을 다시 쓰므로 문제를 고칠 수 있다). 셸 명령은
 * {@code problems} 가 있으면 멈춘다 — 역할을 모르는 채로 «제한 없음»으로 떨어지지 않는다.
 */
export function rolesInFiles(files: ReadonlyMap<string, string | undefined>): RolesInFiles {
  const roles: HarnessRole[] = [];
  const problems: string[] = [];
  for (const target of AGENT_TARGETS) {
    const content = files.get(target.path);
    if (content === undefined || !content.trim()) {
      continue;
    }
    let entry: unknown;
    try {
      const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> };
      entry = parsed?.mcpServers?.[SERVER_NAME];
    } catch {
      problems.push(`${target.path} is not valid JSON`);
      continue;
    }
    if (entry === undefined) {
      continue;
    }
    const role = readRoleFromEntry(entry);
    if (role === undefined) {
      problems.push(`${target.path} has an "${SERVER_NAME}" entry without a valid --role`);
      continue;
    }
    if (!roles.includes(role)) {
      roles.push(role);
    }
  }
  return { roles, problems, found: roles.length > 0 || problems.length > 0 };
}

/**
 * 셸 명령의 저장소 역할. ★cwd 에서 위로, {@code ai-erd} 항목이 있는 «첫 폴더»에서 멈춘다
 * (리뷰 P1-a — 중첩 저장소는 가까운 쪽, git 아닌 하위 폴더·worktree 도 같은 규칙).
 *
 * <p>⚠홈 폴더 자체는 보지 않는다. {@code ~/.cursor/mcp.json} 은 Cursor 의 «전역» 설정이라, 거기 있는
 * {@code ai-erd} 항목(역할 없는 HTTP 연결 등)을 저장소 역할로 읽으면 모든 폴더의 명령이 멈춘다.
 *
 * <p>읽기 문제(저장소 밖을 가리키는 링크, JSON 아님, --role 없는 항목)와 설정끼리의 불일치는
 * {@code conflict} 다 — 호출자는 멈추고 사용자에게 물으라고 말한다.
 */
export async function findRepositoryRole(cwd: string, home: string = homedir()): Promise<RepositoryRole> {
  const stopAt = resolve(home);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (dir === stopAt) {
      return { kind: "none" };
    }
    const files = new Map<string, string | undefined>();
    let readProblem: string | undefined;
    for (const target of AGENT_TARGETS) {
      try {
        files.set(target.path, await readManagedFile(dir, target.path));
      } catch (error) {
        readProblem = error instanceof Error ? error.message : String(error);
      }
    }
    if (readProblem !== undefined) {
      return { kind: "conflict", dir, reason: readProblem };
    }
    const result = rolesInFiles(files);
    if (result.found) {
      if (result.problems.length > 0) {
        return { kind: "conflict", dir, reason: result.problems.join("; ") };
      }
      if (result.roles.length > 1) {
        return {
          kind: "conflict",
          dir,
          reason: `agent configs disagree about the session role (${result.roles.join(", ")})`,
        };
      }
      return { kind: "role", role: result.roles[0]!, dir };
    }
    if (dirname(dir) === dir) {
      return { kind: "none" };
    }
  }
}

/** 멈출 때 쓰는 문장 — 역할은 사용자가 고른다(읽는 쪽은 대개 에이전트다). */
export function askTheUserToFixRole(dir: string, reason: string): string {
  return `Cannot tell this repository's AI session role: ${reason} (in ${dir}). `
    + `Ask the user which role this repository's AI sessions should have (${HARNESS_ROLES.join(", ")}), `
    + `then run \`ai-erd init --role <role>\` in ${dir}.`;
}

/** cwd 에서 위로 올라가며 {@code .git} 이 있는 첫 디렉터리. 없으면 undefined. */
export async function findGitRoot(cwd: string): Promise<string | undefined> {
  for (let at = resolve(cwd); ; at = dirname(at)) {
    try {
      await lstat(join(at, ".git"));
      return at;
    } catch {
      // 없다(또는 볼 수 없다) — 한 칸 위로.
    }
    if (dirname(at) === at) {
      return undefined;
    }
  }
}

/**
 * ★<b>저장소 안의 파일을 읽는 유일한 문.</b> 경계 검사가 읽기 «앞»에 붙어 있다.
 *
 * <p>예전엔 스냅샷만 검사를 했고, 나중에 붙인 역할 추론이 파일을 바로 읽었다. 그래서 저장소 밖을
 * 가리키는 설정 파일을 <b>한 번 읽고 나서</b> 거절했다(2026-09-23 4차 독립 리뷰 I5). 검사와 읽기가
 * 갈라지면, 새로 생긴 경로마다 검사를 잊는다.
 */
export async function readManagedFile(root: string, path: string): Promise<string | undefined> {
  await assertInsideRepository(root, path);
  return readIfExists(join(root, path));
}

export async function readIfExists(absolutePath: string): Promise<string | undefined> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * ★이 경로가 정말 저장소 «안»인가.
 *
 * <p>{@code join(root, path)} 는 이름을 이어 붙일 뿐이고, {@code readFile}/{@code writeFile}
 * 은 심볼릭 링크를 따라간다. {@code .ai-erd → /somewhere/else} 인 저장소에서 undo 를 돌리면
 * 남의 디렉터리 파일이 지워졌다(2026-09-22 독립 리뷰 I4). 실제 경로로 풀어서 경계를 본다.
 */
export async function assertInsideRepository(root: string, relativePath: string): Promise<void> {
  const absolutePath = join(root, relativePath);
  const realRoot = await realpath(root);
  let realParent: string;
  try {
    realParent = await realpath(dirname(absolutePath));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return; // 아직 없는 디렉터리는 우리가 만든다 — 링크일 수 없다.
    }
    throw error;
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new Error(
      `${relativePath} resolves outside the repository (${realParent}); refusing to touch it.`,
    );
  }
  try {
    if ((await lstat(absolutePath)).isSymbolicLink()) {
      throw new Error(`${relativePath} is a symbolic link; refusing to write through it.`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
