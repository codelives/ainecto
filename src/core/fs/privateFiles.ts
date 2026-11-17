import { chmod, lstat, mkdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * 이 기기 사용자만 읽는 파일·폴더 규칙 한 곳 — ★폴더 0700 · 파일 0600.
 * {@code ~/.ainecto/tokens.json}(auth)과 {@code ~/.ainecto/term/}(term) 이 같은 규칙을 쓴다.
 */
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

/** 그룹·남에게 열린 권한이 있으면 좁힌다. 없으면 그대로. */
export async function chmodIfPermissive(path: string, mode: number): Promise<void> {
  try {
    const result = await stat(path);
    if ((result.mode & 0o077) !== 0) {
      await chmod(path, mode);
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

/**
 * 다른 OS 사용자가 끼어들 수 없는 폴더를 보장한다 — 만들 때부터 0700, 이미 있으면
 * ① symlink 가 아니고 ② 폴더이고 ③ 내 것인지 확인한 뒤 권한을 좁힌다.
 * ★제어 소켓처럼 «폴더 권한이 곧 신뢰 경계»인 곳에 쓴다(설계 2-4).
 */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${path} must be a real directory, not a link or a file.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`${path} belongs to another user (uid ${info.uid}).`);
  }
  await chmodIfPermissive(path, PRIVATE_DIR_MODE);
}

/**
 * 이 사용자만 읽는 파일을 통째로 바꿔 쓴다 — 폴더 0700 · 임시 파일(0600) → rename. 중간에 죽어도 반쪽 파일이 남지 않는다.
 * 임시 파일 이름에 pid 를 넣어 두 프로세스가 같은 임시 파일을 쓰지 않는다.
 */
export async function writePrivateFileAtomic(path: string, text: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tmpPath = `${path}.${process.pid}.tmp`;
  await writeFile(tmpPath, text, { mode: PRIVATE_FILE_MODE });
  await chmod(tmpPath, PRIVATE_FILE_MODE);
  await rename(tmpPath, path);
}
