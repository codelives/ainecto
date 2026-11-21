import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { processAlive } from "../os/processes";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "./privateFiles";

/**
 * 짧은 «읽기 → 바꾸기 → 쓰기»를 프로세스 사이에서 직렬화하는 잠금 파일(O_EXCL) — `pc-keys.json.lock` 이 쓴다(설계 terminal-e2e §13-2·§14-6 2).
 *   잡기: O_CREAT|O_EXCL(0600)로 만들고 {pid, token} 을 쓴다. 있으면 pollMs 마다 다시, waitMs 가 지나면 {@link FileLockTimeoutError}.
 *   죽은 잠금: 적힌 pid 가 살아 있지 않거나, 내용을 읽을 수 없는 채로 waitMs 보다 오래됐으면(만든 직후 죽음) 치우고 다시 잡는다.
 *   쓰기 직전: {@link LockHandle.assertHeld} — 잠금 파일이 아직 내 token 이 아니면 쓰지 않고 던진다.
 *   풀기: 내 token 이 그대로일 때만 지운다.
 * ★회수는 «확인한 그 소유자»와 원자적으로 맞을 때만 한다: 고유 이름으로 rename → 옮긴 파일의 내용이 내가 죽었다고 본 내용과 같은지 다시 본다.
 *   다르면(그 사이 남이 회수하고 새로 잡았다) link 로 제자리에 되돌린다. 되돌릴 수 없으면(그 자리를 또 남이 잡았다) {@link FileLockConflictError}
 *   로 이 쓰기를 멈춘다 — 옮겨진 잠금의 주인은 쓰기 직전 확인에서 멈추므로, 남는 작성자는 그 자리의 새 주인 하나다.
 */
export interface FileLockOptions {
  waitMs: number;
  pollMs: number;
  /** 시험만 바꾼다. */
  isAlive?: (pid: number) => boolean;
  /** 시험만 — 회수의 틈(죽었다고 본 뒤 rename 전 · rename 뒤 확인 전)에 다른 획득을 끼워 넣는다. */
  testHooks?: { beforeReclaim?: () => Promise<void>; afterReclaimRename?: () => Promise<void> };
}

export class FileLockTimeoutError extends Error {
  constructor(readonly lockPath: string, readonly holderPid: number | undefined) {
    super(`${lockPath} is held by another ainecto${holderPid !== undefined ? ` (pid ${holderPid})` : ""} — try again in a moment.`);
  }
}

/** 잠금을 잃었다(회수가 겹쳐 제자리에 되돌릴 수 없었음 · 쓰기 직전에 내 잠금이 아님) — 이번 쓰기는 하지 않았다. */
export class FileLockConflictError extends Error {
  constructor(readonly lockPath: string, reason: string) {
    super(`${lockPath}: ${reason} — nothing was written; try again.`);
  }
}

export interface LockHandle {
  /** 쓰기 직전 — 잠금 파일이 아직 내 것인지. 아니면 {@link FileLockConflictError}. */
  assertHeld(): Promise<void>;
}

interface LockContent {
  pid: number;
  token: string;
}

export async function withFileLock<T>(lockPath: string, options: FileLockOptions, run: (lock: LockHandle) => Promise<T>): Promise<T> {
  const token = await acquire(lockPath, options);
  try {
    return await run({
      assertHeld: async () => {
        if ((await readLock(lockPath)).content?.token !== token) {
          throw new FileLockConflictError(lockPath, "the lock was taken over while this command held it");
        }
      },
    });
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
    if (await isStale(lockPath, holder.content, options)) {
      await options.testHooks?.beforeReclaim?.();
      await reclaim(lockPath, holder.raw, options);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(lockPath, holder.content?.pid);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/** 잠금 파일 원문과 읽은 내용 — 없으면 raw 도 undefined. */
async function readLock(path: string): Promise<{ raw: string | undefined; content: LockContent | undefined }> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { raw: undefined, content: undefined };
    throw error;
  }
  try {
    const value = JSON.parse(raw) as Partial<LockContent> | null;
    const content = value && Number.isSafeInteger(value.pid) && typeof value.token === "string" ? { pid: value.pid as number, token: value.token } : undefined;
    return { raw, content };
  } catch {
    return { raw, content: undefined };
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

/**
 * 죽었다고 본 잠금(observed = 그때 읽은 원문)을 치운다 — 옮긴 뒤 원문이 같을 때만 지운다. 다르면 제자리로(link — 그 자리가 비었을 때만) 되돌리고,
 * 되돌릴 수 없으면 던진다.
 */
async function reclaim(lockPath: string, observed: string | undefined, options: FileLockOptions): Promise<void> {
  const aside = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  await options.testHooks?.afterReclaimRename?.();
  const moved = (await readLock(aside)).raw;
  if (moved === observed) {
    await unlink(aside);
    return;
  }
  try {
    await link(aside, lockPath);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      // 옮긴 것은 남의 살아 있는 잠금인데 그 자리를 또 남이 잡았다 — 되돌릴 수 없다. 옮긴 잠금의 주인은 쓰기 직전 확인에서 멈춘다.
      await unlink(aside);
      throw new FileLockConflictError(lockPath, "another command took the lock while a stale lock was being cleared");
    }
    throw error;
  }
  await unlink(aside);
}

async function release(lockPath: string, token: string): Promise<void> {
  if ((await readLock(lockPath)).content?.token !== token) return;
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}
