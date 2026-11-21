import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { processAlive } from "../os/processes";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "./privateFiles";

/**
 * 짧은 «읽기 → 바꾸기 → 쓰기»를 프로세스 사이에서 직렬화하는 잠금 파일(O_EXCL) — `pc-keys.json.lock` 이 쓴다(설계 terminal-e2e §13-2).
 *   잡기: O_CREAT|O_EXCL(0600)로 만들고 {pid, token} 을 쓴다. 있으면 pollMs 마다 다시, waitMs 가 지나면 {@link FileLockTimeoutError}.
 *   죽은 잠금: 적힌 pid 가 살아 있지 않거나, 내용을 읽을 수 없는 채로 waitMs 보다 오래됐으면(만든 직후 죽음) 치우고 다시 잡는다.
 *   풀기: 내 token 이 그대로일 때만 지운다.
 * ★치우기는 «고유 이름으로 rename → 지우기»라 두 프로세스가 같은 죽은 잠금을 동시에 치워도 하나만 성공한다.
 *   남는 틈: 치우기 직전에 남이 새로 잡은 잠금을 죽은 것으로 볼 수는 없다(살아 있는 pid 를 적으므로) — 읽기와 rename 사이의 아주 짧은 틈만 남는다.
 */
export interface FileLockOptions {
  waitMs: number;
  pollMs: number;
  /** 시험만 바꾼다. */
  isAlive?: (pid: number) => boolean;
}

export class FileLockTimeoutError extends Error {
  constructor(readonly lockPath: string, readonly holderPid: number | undefined) {
    super(`${lockPath} is held by another ainecto${holderPid !== undefined ? ` (pid ${holderPid})` : ""} — try again in a moment.`);
  }
}

interface LockContent {
  pid: number;
  token: string;
}

export async function withFileLock<T>(lockPath: string, options: FileLockOptions, run: () => Promise<T>): Promise<T> {
  const token = await acquire(lockPath, options);
  try {
    return await run();
  } finally {
    await release(lockPath, token);
  }
}

async function acquire(lockPath: string, options: FileLockOptions): Promise<string> {
  await ensurePrivateDir(dirname(lockPath));
  const token = randomUUID();
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token } satisfies LockContent));
      } finally {
        await handle.close();
      }
      return token;
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const holder = await readLock(lockPath);
    if (await isStale(lockPath, holder, options)) {
      await clearStale(lockPath);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(lockPath, holder?.pid);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

async function readLock(lockPath: string): Promise<LockContent | undefined> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockContent> | null;
    return value && Number.isSafeInteger(value.pid) && typeof value.token === "string" ? { pid: value.pid as number, token: value.token } : undefined;
  } catch {
    return undefined;
  }
}

async function isStale(lockPath: string, holder: LockContent | undefined, options: FileLockOptions): Promise<boolean> {
  if (holder) {
    return !(options.isAlive ?? processAlive)(holder.pid);
  }
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > options.waitMs;
  } catch (error) {
    // 그새 풀렸다 — 다시 잡으러 간다.
    if (isNodeError(error, "ENOENT")) return true;
    throw error;
  }
}

async function clearStale(lockPath: string): Promise<void> {
  const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  await unlink(aside);
}

async function release(lockPath: string, token: string): Promise<void> {
  if ((await readLock(lockPath))?.token !== token) return;
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}
