import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { AGENT_TARGETS, PACKAGE_NAME, readRoleFromEntry, SERVER_NAME } from "./agentTargets";
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
  /** 읽기 문제(우리 브리지인데 --role 이 없거나 모르는 값, `ai-erd` 가 든 깨진 JSON). */
  problems: string[];
  /** 어느 파일이든 우리 브리지 항목(또는 읽기 문제)이 있었나 — 이 폴더가 «ai-erd 폴더»인가. */
  found: boolean;
}

/** 설정 파일 하나에서 읽은 것. */
export type ConfigRole =
  | { kind: "absent" }
  | { kind: "role"; role: HarnessRole }
  | { kind: "problem"; reason: string };

/**
 * ★설정 파일 «하나»에서 우리 브리지의 역할을 읽는 유일한 함수. init 의 역할 변경 알림(initPlan)과
 * 저장소 역할 판정이 모두 이것을 쓴다.
 *
 * <p>멈출 이유는 좁게 둔다(0.4.2 리뷰 P1-3) — 사람의 설정을 잘못 읽어 모든 명령을 막으면 안 된다.
 * <ul>
 *   <li>{@code ai-erd} 항목이 «우리 브리지»가 아니면(mcp-remote·url 방식 등) 역할 없음이다.</li>
 *   <li>JSON 이 깨졌어도 원문에 {@code ai-erd} 가 없으면 우리와 무관한 파일이다 — 건너뛴다.</li>
 *   <li>우리 브리지인데 {@code --role} 이 없거나 모르는 값이면 멈춘다 — 역할을 모르는 채로 «제한 없음»으로
 *       가지 않는다.</li>
 * </ul>
 */
export function readConfigRole(path: string, content: string | undefined): ConfigRole {
  if (content === undefined || !content.trim()) {
    return { kind: "absent" };
  }
  let entry: unknown;
  try {
    const parsed = JSON.parse(content) as { mcpServers?: Record<string, unknown> } | null;
    entry = parsed?.mcpServers?.[SERVER_NAME];
  } catch {
    return content.includes(SERVER_NAME)
      ? { kind: "problem", reason: `${path} is not valid JSON` }
      : { kind: "absent" };
  }
  if (entry === undefined || !isOurBridge(entry)) {
    return { kind: "absent" };
  }
  const role = readRoleFromEntry(entry);
  return role === undefined
    ? { kind: "problem", reason: `${path} has the "${SERVER_NAME}" bridge without a valid --role` }
    : { kind: "role", role };
}

/**
 * 이 항목이 우리 브리지({@code npx -y @ai-erd/mcp …}, 전역 설치한 {@code ai-erd}·{@code ai-erd-mcp})인가.
 * {@code --role} 을 싣는 것도 우리 브리지뿐이다.
 */
function isOurBridge(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const { command, args } = entry as { command?: unknown; args?: unknown };
  const argList = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [];
  if (argList.some((arg) => arg === PACKAGE_NAME || arg.startsWith(`${PACKAGE_NAME}@`) || arg === "--role")) {
    return true;
  }
  const bin = typeof command === "string" ? basename(command) : "";
  return bin === "ai-erd" || bin === "ai-erd-mcp";
}

/**
 * 스냅샷(경로 → 내용)에서 역할을 읽는다. 순수 함수.
 *
 * <p>init 은 {@code roles} 만 본다(자기가 그 파일을 다시 쓰므로 문제를 고칠 수 있다). 셸 명령은
 * {@code problems} 가 있으면 멈춘다.
 */
export function rolesInFiles(files: ReadonlyMap<string, string | undefined>): RolesInFiles {
  const roles: HarnessRole[] = [];
  const problems: string[] = [];
  for (const target of AGENT_TARGETS) {
    const read = readConfigRole(target.path, files.get(target.path));
    if (read.kind === "problem") {
      problems.push(read.reason);
    } else if (read.kind === "role" && !roles.includes(read.role)) {
      roles.push(read.role);
    }
  }
  return { roles, problems, found: roles.length > 0 || problems.length > 0 };
}

/**
 * 셸 명령의 저장소 역할. ★cwd 에서 위로, 우리 브리지 항목이 있는 «첫 폴더»에서 멈춘다
 * (리뷰 P1-a — 중첩 저장소는 가까운 쪽, git 아닌 하위 폴더·worktree 도 같은 규칙).
 *
 * <p>⚠홈 폴더 자체는 보지 않는다. {@code ~/.cursor/mcp.json} 은 Cursor 의 «전역» 설정이다(실측: 역할 없는
 * {@code ai-erd} 항목이 있었다). ★비교는 «실제 경로»로 한다 — macOS 의 {@code /var} 와 {@code /private/var}
 * 처럼 링크로 갈라진 같은 폴더를 문자열로 비교하면 홈을 못 알아본다(0.4.2 리뷰 P1-1). Windows 는 대소문자를
 * 가리지 않는다.
 *
 * <p>설정 파일이 폴더 «안»을 가리키는 링크면 그대로 읽는다({@code .cursor/mcp.json → ../.mcp.json}). 폴더
 * «밖»을 가리키면 멈춘다.
 */
export async function findRepositoryRole(cwd: string, home: string = homedir()): Promise<RepositoryRole> {
  const stopAt = await realOrResolved(home);
  for (let dir = await realOrResolved(cwd); ; dir = dirname(dir)) {
    if (samePath(dir, stopAt)) {
      return { kind: "none" };
    }
    const files = new Map<string, string | undefined>();
    let readProblem: string | undefined;
    for (const target of AGENT_TARGETS) {
      try {
        files.set(target.path, await readConfigInside(dir, target.path));
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

/**
 * 멈출 때 쓰는 문장. ★막다른 길이 되지 않게 한다(0.4.2 리뷰 P2): init 은 git 저장소의 루트에서만 돈다.
 * 그 폴더가 git 저장소의 «하위 폴더»면 init 으로는 그 폴더의 설정을 고칠 수 없으므로, 사용자에게 그 파일을
 * 어떻게 둘지 물으라고 말한다.
 */
export async function askTheUserToFixRole(dir: string, reason: string): Promise<string> {
  const gitRoot = await findGitRoot(dir);
  const roles = HARNESS_ROLES.join(", ");
  if (gitRoot !== undefined && !samePath(await realOrResolved(gitRoot), await realOrResolved(dir))) {
    return `Cannot tell this folder's AI session role: ${reason} (in ${dir}, inside the git repository at ${gitRoot}). `
      + "Ask the user how that AI-ERD setting should look — `ai-erd init` only sets up a repository root "
      + `(${gitRoot}).`;
  }
  return `Cannot tell this repository's AI session role: ${reason} (in ${dir}). `
    + `Ask the user which role this repository's AI sessions should have (${roles}), `
    + `then run \`ai-erd init --role <role>\` in ${dir}.`;
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * 역할을 읽으려고 설정 파일을 연다. 링크면 따라가되, 그 실제 경로가 이 폴더 «안»일 때만 읽는다.
 * (init 의 {@link readManagedFile} 은 쓰기를 위한 문이라 링크를 아예 거절한다 — 역할 읽기에는 너무 좁다.)
 */
async function readConfigInside(dir: string, path: string): Promise<string | undefined> {
  let real: string;
  try {
    real = await realpath(join(dir, path));
  } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
  const realDir = await realOrResolved(dir);
  if (!samePath(real, realDir) && !real.startsWith(realDir + sep)
      && !(process.platform === "win32" && real.toLowerCase().startsWith((realDir + sep).toLowerCase()))) {
    throw new Error(`${path} points outside ${dir} (${real})`);
  }
  return readFile(real, "utf8");
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
