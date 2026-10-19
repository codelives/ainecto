import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/** 저장소 안의 파일을 다루는 문 — init 이 읽고 쓰는 모든 경로가 이 경계 검사를 지난다. */

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
 * 은 심볼릭 링크를 따라간다. {@code .ainecto → /somewhere/else} 인 저장소에서 undo 를 돌리면
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
