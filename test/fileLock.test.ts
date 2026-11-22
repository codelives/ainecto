import { mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileLockConflictError, withFileLock } from "../src/core/fs/fileLock";

/**
 * 키 파일 잠금 — 소유자 기록(PID·토큰)이 없는 잠금이 경로에 보이는 순간이 없어야 한다(리뷰 impl-2 #2 · 설계 §14-6 2).
 * 잠금을 만드는 쪽의 «첫 내용 쓰기»에서 멈춰 세우려고 open 만 감싼다 — 파일은 모두 임시 폴더의 실제 파일.
 */
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("잠금 파일 — 소유자 기록을 갖춘 잠금만 공개", () => {
  it("살아 있는 작성자가 잠금을 만드는 중(소유자 기록 전)에 멈춰 기한보다 오래돼도 — 남이 회수해 들어오지 않는다 · 동시 작성자 1명", async () => {
    const dir = await mkdtemp(join(tmpdir(), "filelock-init-"));
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let paused!: () => void;
    const aPaused = new Promise<void>((resolve) => { paused = resolve; });
    let resume!: () => void;
    const aResumes = new Promise<void>((resolve) => { resume = resolve; });
    let first = true;
    // A 가 새로 만드는 파일(O_EXCL)의 첫 내용 쓰기 직전에 멈춘다 — 옛 구현은 그때 이미 빈 잠금이 경로에 있었다.
    vi.mocked(open).mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await actual.open(...args);
      if (first && args[1] === "wx") {
        first = false;
        const write = handle.writeFile.bind(handle);
        handle.writeFile = (async (...input: Parameters<typeof handle.writeFile>) => {
          paused();
          await aResumes;
          return await write(...input);
        }) as typeof handle.writeFile;
      }
      return handle;
    });
    const lock = join(dir, "keys.json.lock");
    let inside = 0;
    let most = 0;
    const order: string[] = [];
    const enter = (name: string) => {
      inside += 1;
      most = Math.max(most, inside);
      order.push(name);
    };
    let a: Promise<void> | undefined;
    let b: Promise<void> | undefined;
    let letBOut!: () => void;
    const bGate = new Promise<void>((resolve) => { letBOut = resolve; });
    try {
      a = withFileLock(lock, { waitMs: 3_000, pollMs: 10 }, async () => {
        enter("A");
        inside -= 1;
      });
      await aPaused;
      // A(이 프로세스 — 살아 있다)는 기록 전에 멈춘 채 B 의 기한(100 ms)보다 오래 머문다.
      await sleep(250);
      let bIn!: () => void;
      const bEntered = new Promise<void>((resolve) => { bIn = resolve; });
      b = withFileLock(lock, { waitMs: 100, pollMs: 10 }, async () => {
        enter("B");
        bIn();
        await bGate;
        inside -= 1;
      });
      await bEntered;
      // A 가 다시 움직인다 — B 가 잡고 있는 동안 A 가 들어올 시간을 준다.
      resume();
      await sleep(200);
      letBOut();
      await Promise.all([a, b]);
      expect(most).toBe(1);
      expect(order).toEqual(["B", "A"]);
      expect(await readdir(dir)).toEqual([]);
    } finally {
      resume();
      letBOut();
      await Promise.allSettled([a, b]);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("소유자 기록이 없는(비었거나 읽을 수 없는) 잠금은 나이와 상관없이 치우지 않는다 — FileLockConflictError(사람이 지우라는 안내) · 파일 그대로 · 실행 안 함", async () => {
    const dir = await mkdtemp(join(tmpdir(), "filelock-unreadable-"));
    try {
      const lock = join(dir, "keys.json.lock");
      for (const text of ["", "{not json", JSON.stringify({ pid: "x" })]) {
        await writeFile(lock, text);
        const old = new Date(Date.now() - 60_000);
        await utimes(lock, old, old);
        let ran = false;
        const error = await withFileLock(lock, { waitMs: 100, pollMs: 10 }, async () => { ran = true; }).then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(FileLockConflictError);
        expect(String(error)).toContain("delete it");
        expect(ran).toBe(false);
        expect(await readFile(lock, "utf8")).toBe(text);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
