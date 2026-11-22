import { randomUUID } from "node:crypto";
import { link, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { processAlive } from "../os/processes";
import { ensurePrivateDir, isNodeError, PRIVATE_FILE_MODE } from "./privateFiles";

/**
 * 짧은 «읽기 → 바꾸기 → 쓰기»를 프로세스 사이에서 직렬화하는 잠금 파일(O_EXCL) — `pc-keys.json.lock` 이 쓴다(설계 terminal-e2e §13-2·§14-6 2).
 *   잡기: {pid, token} 을 다 쓰고 fsync 한 임시 파일(0600)을 link 로 잠금 자리에 공개한다(EEXIST = 남이 잡음) — ★경로에 나타나는 잠금은 늘
 *     소유자 기록을 갖췄다. 있으면 pollMs 마다 다시, waitMs 가 지나면 {@link FileLockTimeoutError}.
 *   죽은 잠금: 적힌 pid 가 살아 있지 않으면 치우고 다시 잡는다.
 *   소유자 기록이 없는(비었거나 읽을 수 없는) 잠금: 이 판이 만든 것이 아니다(옛 판이 만드는 중일 수도) — 나이로 회수하지 않고
 *     {@link FileLockConflictError}(사람이 확인하고 지운다).
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
    if (!holder.content) {
      throw new FileLockConflictError(lockPath, "it has no owner recorded (it was not made by this version of ainecto), so it cannot be told apart from a "
        + "lock still being made — check that no other ainecto is running, delete it and try again");
    }
    if (isDead(holder.content, options)) {
      await options.testHooks?.beforeReclaim?.();
      if (await reclaim(lockPath, holder.raw, token, options)) continue;
    }
    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(lockPath, holder.content?.pid);
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/**
 * {pid, token} 을 다 쓰고 fsync 한 임시 파일(`<path>.<token>.tmp`, O_EXCL·0600)을 link 로 path 에 공개한다 — 이미 있으면(EEXIST) false.
 * 임시 파일은 늘 지운다(공개됐으면 path 가 같은 내용을 가리킨다).
 */
async function create(path: string, token: string): Promise<boolean> {
  const staging = `${path}.${token}.tmp`;
  const handle = await open(staging, "wx", PRIVATE_FILE_MODE);
  try {
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token } satisfies LockContent));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(staging, path);
    return true;
  } catch (error) {
    if (isNodeError(error, "EEXIST")) return false;
    throw error;
  } finally {
    await unlink(staging);
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

function isDead(holder: LockContent, options: FileLockOptions): boolean {
  return !(options.isAlive ?? processAlive)(holder.pid);
}

/**
 * 죽었다고 본 잠금(observed = 그때 읽은 원문)을 회수 표지를 잡은 채 치운다 — 다시 읽은 원문이 같고 여전히 죽었을 때만 지우고, 다르면(그 사이 남이 치우고 새로
 * 잡았다) 손대지 않는다. true = 바로 다시 잡으러 간다 · false = 남이 치우는 중이라 기다린다. 표지가 죽은 채(또는 소유자 기록 없이) 남았으면 던진다.
 */
async function reclaim(lockPath: string, observed: string, token: string, options: FileLockOptions): Promise<boolean> {
  const guard = `${lockPath}.reclaim`;
  if (!(await create(guard, token))) {
    const other = await readLock(guard);
    if (other.raw !== undefined && (!other.content || isDead(other.content, options))) {
      throw new FileLockConflictError(lockPath, `${guard} was left by an ainecto that stopped while clearing a stale lock, so the stale lock cannot be `
        + `matched to its owner — check that no other ainecto is running, delete both files and try again`);
    }
    return other.raw === undefined;
  }
  try {
    await options.testHooks?.duringReclaim?.();
    // 원문이 같고 아직 죽은 것만.
    const now = await readLock(lockPath);
    if (now.raw === observed && now.content && isDead(now.content, options)) {
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
