import { randomUUID } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { processAlive } from "../os/processes";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "./privateFiles";

/**
 * 짧은 «읽기 → 바꾸기 → 쓰기»를 프로세스 사이에서 직렬화하는 잠금 파일(O_EXCL) — `pc-keys.json.lock` 이 쓴다(설계 terminal-e2e §13-2·§14-6 2).
 *   잡기: O_CREAT|O_EXCL(0600)로 만들고 {pid, token} 을 쓴다. 있으면 pollMs 마다 다시, waitMs 가 지나면 {@link FileLockTimeoutError}.
 *   죽은 잠금: 적힌 pid 가 살아 있지 않거나, 내용을 읽을 수 없는 채로 waitMs 보다 오래됐으면(만든 직후 죽음) 치우고 다시 잡는다.
 *   풀기: 내 token 이 그대로일 때만 지운다.
 * ★살아 있는 잠금은 누구도 옮기거나 지우지 않는다 — 그래서 잡은 쪽이 최종 교체·풀기까지 유일한 작성자다.
 *   죽은 잠금 치우기는 회수 표지(`<잠금>.reclaim`, O_EXCL)를 잡은 한 명만 한다. 표지를 잡은 동안 잠금 파일을 지울 수 있는 것은 그 한 명뿐이므로
 *   (죽은 주인은 풀지 못하고, 새로 잡기는 파일이 없을 때만 된다) «다시 읽은 원문이 죽었다고 본 원문과 같으면 지운다»가 그 소유자와 원자적으로 맞는다.
 *   다르면 손대지 않는다. 표지가 죽은 채 남았으면(치우던 실행이 그 사이 죽음) 일치시킬 수 없으므로 {@link FileLockConflictError} 로 쓰기를 멈춘다.
 */
export interface FileLockOptions {
  waitMs: number;
  pollMs: number;
  /** 시험만 바꾼다. */
  isAlive?: (pid: number) => boolean;
  /** 시험만 — 회수의 틈(죽었다고 본 뒤 회수 표지 전 · 표지를 잡고 다시 읽기 전)에 다른 획득을 끼워 넣는다. */
  testHooks?: { beforeReclaim?: () => Promise<void>; duringReclaim?: () => Promise<void> };
}

export class FileLockTimeoutError extends Error {
  constructor(readonly lockPath: string, readonly holderPid: number | undefined) {
    super(`${lockPath} is held by another ainecto${holderPid !== undefined ? ` (pid ${holderPid})` : ""} — try again in a moment.`);
  }
}

/** 죽은 잠금을 그 소유자와 원자적으로 맞춰 치울 수 없다 — 이번 쓰기는 하지 않았다. */
export class FileLockConflictError extends Error {
  constructor(readonly lockPath: string, reason: string) {
    super(`${lockPath}: ${reason} — nothing was written.`);
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
    if (await create(lockPath, token)) return token;
    const holder = await readLock(lockPath);
    // 그새 풀렸다 — 바로 다시 잡으러 간다.
    if (holder.raw === undefined) continue;
    if (await isStale(lockPath, holder.content, options)) {
      await options.testHooks?.beforeReclaim?.();
      if (await reclaim(lockPath, holder.raw, token, options)) continue;
    }
    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(lockPath, holder.content?.pid);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/** O_CREAT|O_EXCL 로 만들고 {pid, token} 을 쓴다 — 이미 있으면 false. */
async function create(path: string, token: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", PRIVATE_FILE_MODE);
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token } satisfies LockContent));
  } finally {
    await handle.close();
  }
  return true;
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

async function isStale(path: string, holder: LockContent | undefined, options: FileLockOptions): Promise<boolean> {
  if (holder) {
    return !(options.isAlive ?? processAlive)(holder.pid);
  }
  try {
    return Date.now() - (await stat(path)).mtimeMs > options.waitMs;
  } catch (error) {
    // 그새 풀렸다 — 죽은 것이 아니다(부른 쪽이 다시 본다).
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * 죽었다고 본 잠금(observed = 그때 읽은 원문)을 회수 표지를 잡은 채 치운다 — 다시 읽은 원문이 같고 여전히 죽었을 때만 지우고, 다르면(그 사이 남이 치우고 새로
 * 잡았다) 손대지 않는다. true = 바로 다시 잡으러 간다 · false = 남이 치우는 중이라 기다린다. 표지가 죽은 채 남았으면 던진다.
 */
async function reclaim(lockPath: string, observed: string, token: string, options: FileLockOptions): Promise<boolean> {
  const guard = `${lockPath}.reclaim`;
  if (!(await create(guard, token))) {
    const other = await readLock(guard);
    if (other.raw !== undefined && await isStale(guard, other.content, options)) {
      throw new FileLockConflictError(lockPath, `${guard} was left by an ainecto that stopped while clearing a stale lock, so the stale lock cannot be `
        + `matched to its owner — check that no other ainecto is running, delete both files and try again`);
    }
    return other.raw === undefined;
  }
  try {
    await options.testHooks?.duringReclaim?.();
    // 원문이 같고 아직 죽은 것 — 내용 없는 잠금은 원문이 같아도 막 만든 남의 잠금일 수 있어 나이를 다시 본다.
    const now = await readLock(lockPath);
    if (now.raw === observed && await isStale(lockPath, now.content, options)) {
      await unlink(lockPath);
    }
  } finally {
    await unlink(guard);
  }
  return true;
}

async function release(lockPath: string, token: string): Promise<void> {
  if ((await readLock(lockPath)).content?.token !== token) return;
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}
