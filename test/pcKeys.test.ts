import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { FileLockConflictError, FileLockTimeoutError } from "../src/core/fs/fileLock";
import { writePrivateFileAtomic } from "../src/core/fs/privateFiles";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_NAME_MAX,
  browserNameOf,
  loadPcKeys,
  normalizePcKeys,
  updatePcKeys,
  withBrowser,
  withoutBrowser,
  withoutEndpointKeys,
  withPendingTurnOff,
  type PairedBrowser,
} from "../src/core/pc/pcKeys";
import { accountKey } from "../src/core/pc/pcSettings";
import { generateSigningJwk, publicJwkOf } from "../src/core/term/e2e";

// 최종 교체(writePrivateFileAtomic)를 그대로 부르되, 시험이 그 직전에 멈춰 세우고 동시에 몇 명이 쓰는지 센다.
vi.mock("../src/core/fs/privateFiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/fs/privateFiles")>();
  return { ...actual, writePrivateFileAtomic: vi.fn(actual.writePrivateFileAtomic) };
});

describe("~/.ainecto/pc-keys.json — 짝지은 키 한 곳", () => {
  const a = accountKey("https://ainecto.com/mcp", "u1");
  const b = accountKey("https://dev.ainecto.com/mcp", "u1");

  async function browser(keyId: string, name: string): Promise<PairedBrowser> {
    return { keyId, publicJwk: publicJwkOf(await generateSigningJwk()), name, pairedAt: "2026-11-21T00:00:00.000Z" };
  }

  it("모양이 틀린 계정·브라우저는 버린다 — 비공개 d 가 없는 pcKey, 공개키가 틀린 브라우저", async () => {
    const pcKey = await generateSigningJwk();
    const good = await browser("k1", "Chrome · macOS");
    const raw = {
      accounts: {
        [a]: { pcKey, browsers: [good, { ...good, keyId: "" }, { ...good, keyId: "k2", publicJwk: { kty: "EC", crv: "P-256", x: "AA", y: "AA" } }] },
        [b]: { pcKey: publicJwkOf(pcKey), browsers: [] },
      },
    };
    expect(normalizePcKeys(raw)).toEqual({ accounts: { [a]: { pcKey, browsers: [good] } } });
    expect(normalizePcKeys(undefined)).toEqual({ accounts: {} });
  });

  it("넣기: 같은 keyId 는 바꿔 넣고 · 겹치는 이름은 « (2)» · 계정이 없으면 pcKey 와 함께 만든다", async () => {
    const pcKey = await generateSigningJwk();
    const one = withBrowser({ accounts: {} }, a, pcKey, await browser("k1", "Chrome"));
    const two = withBrowser(one, a, pcKey, await browser("k2", "Chrome"));
    expect(two.accounts[a]?.browsers.map((item) => [item.keyId, item.name])).toEqual([["k1", "Chrome"], ["k2", "Chrome (2)"]]);
    const replaced = withBrowser(two, a, pcKey, await browser("k1", "Chrome"));
    expect(replaced.accounts[a]?.browsers.map((item) => [item.keyId, item.name])).toEqual([["k2", "Chrome (2)"], ["k1", "Chrome"]]);
    expect(replaced.accounts[a]?.pcKey).toEqual(pcKey);
  });

  it("지우기: keyId 가 먼저, 다음 이름 · 없으면 그대로 · stop --forget 은 그 서버 것만", async () => {
    const pcKey = await generateSigningJwk();
    let keys = withBrowser({ accounts: {} }, a, pcKey, await browser("k1", "Work"));
    keys = withBrowser(keys, a, pcKey, await browser("Work", "Home"));
    keys = withBrowser(keys, b, pcKey, await browser("k3", "Dev"));
    expect(withoutBrowser(keys, a, "Work").removed?.keyId).toBe("Work");
    expect(withoutBrowser(keys, a, "Home").removed?.keyId).toBe("Work");
    expect(withoutBrowser(keys, a, "k1").keys.accounts[a]?.browsers.map((item) => item.keyId)).toEqual(["Work"]);
    expect(withoutBrowser(keys, a, "nope")).toEqual({ keys, removed: undefined });
    expect(Object.keys(withoutEndpointKeys(keys, "https://ainecto.com/mcp").accounts)).toEqual([b]);
  });

  it("끄기 미완료 표지(pendingTurnOff): 남기기·지우기 · 정규화가 보존 · 계정이 없으면 그대로", async () => {
    const pcKey = await generateSigningJwk();
    const keys = withBrowser({ accounts: {} }, a, pcKey, await browser("k1", "Work"));
    const marked = withPendingTurnOff(keys, a, new Date("2026-11-21T09:00:00Z"));
    expect(marked.accounts[a]?.pendingTurnOff).toEqual({ removedAt: "2026-11-21T09:00:00.000Z" });
    expect(normalizePcKeys(JSON.parse(JSON.stringify(marked)))).toEqual(marked);
    expect(withPendingTurnOff(marked, a, undefined)).toEqual(keys);
    expect(withPendingTurnOff(keys, b, new Date())).toBe(keys);
  });

  it("이름 다듬기: 개행·제어 문자 제거 · 40자 · 비면 «Browser»", () => {
    expect(browserNameOf("Chrome\n\u001b[31m · macOS\u0007")).toBe("Chrome[31m · macOS");
    expect([...browserNameOf("가".repeat(100))].length).toBe(BROWSER_NAME_MAX);
    expect(BROWSER_NAME_MAX).toBe(40);
    expect(browserNameOf(" \t\r\n")).toBe("Browser");
  });

  it("잠금 경합: 지우기·넣기가 동시에 여럿 돌아도 지운 핀이 되살아나지 않고 넣은 것은 모두 남는다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pckeys-lock-"));
    try {
      const path = join(dir, ".ainecto", "pc-keys.json");
      const pcKey = await generateSigningJwk();
      await updatePcKeys(path, () => withBrowser({ accounts: {} }, a, pcKey, { keyId: "gone", publicJwk: publicJwkOf(pcKey), name: "Old", pairedAt: "t" }));
      const added = await Promise.all(Array.from({ length: 12 }, (_value, index) => browser(`k${index}`, `B${index}`)));
      await Promise.all([
        ...added.map((item) => updatePcKeys(path, (keys) => withBrowser(keys, a, pcKey, item))),
        updatePcKeys(path, (keys) => withoutBrowser(keys, a, "gone").keys),
      ]);
      const ids = (await loadPcKeys(path)).accounts[a]?.browsers.map((item) => item.keyId).sort();
      expect(ids).toEqual(added.map((item) => item.keyId).sort());
      await expect(stat(`${path}.lock`)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("죽은 잠금 회수와 새 획득이 겹칠 때(§14-6 2) — 작성자 1명 · 철회 핀 부활 0", () => {
    const DEAD = 999_999;
    const opts = (hooks?: { beforeReclaim?: () => Promise<void>; duringReclaim?: () => Promise<void> }) =>
      ({ waitMs: 3_000, pollMs: 10, isAlive: (pid: number) => pid !== DEAD, ...(hooks ? { testHooks: hooks } : {}) });

    async function world() {
      const dir = await mkdtemp(join(tmpdir(), "pckeys-reclaim-"));
      const path = join(dir, ".ainecto", "pc-keys.json");
      const pcKey = await generateSigningJwk();
      await updatePcKeys(path, () => withBrowser({ accounts: {} }, a, pcKey, { keyId: "gone", publicJwk: publicJwkOf(pcKey), name: "Old", pairedAt: "t" }));
      await writeFile(`${path}.lock`, JSON.stringify({ pid: DEAD, token: "dead" }));
      let acquired!: () => void;
      const bAcquired = new Promise<void>((resolve) => { acquired = resolve; });
      let open!: () => void;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      // B = 핀을 지우는 쪽 — 죽은 잠금을 먼저 회수하고 잡은 채 gate 에서 기다린다.
      const startB = () => updatePcKeys(path, async (keys) => {
        acquired();
        await gate;
        return withoutBrowser(keys, a, "gone").keys;
      }, opts());
      return { dir, path, pcKey, startB, bAcquired, open };
    }

    it("A 가 죽었다고 본 사이 B 가 치우고 잡았으면 A 는 B 의 잠금에 손대지 않고 기다린다 → B 쓰기 뒤에 A 가 읽고 쓴다(지운 핀 안 살아남)", async () => {
      const w = await world();
      try {
        let b: Promise<unknown> | undefined;
        let once = false;
        const newer = await browser("new", "New");
        const aDone = updatePcKeys(w.path, (keys) => withBrowser(keys, a, w.pcKey, newer), opts({
          beforeReclaim: async () => {
            if (once) return;
            once = true;
            b = w.startB();
            await w.bAcquired;
          },
        }));
        setTimeout(w.open, 150);
        await aDone;
        await b;
        expect((await loadPcKeys(w.path)).accounts[a]?.browsers.map((item) => item.keyId)).toEqual(["new"]);
        await expect(stat(`${w.path}.lock`)).rejects.toThrow();
      } finally {
        await rm(w.dir, { recursive: true, force: true });
      }
    });

    it("B 가 최종 교체 직전에 멈춘 사이 A 가 회수하고 C(철회)가 잡으려 해도 — C 는 B 가 풀 때까지 못 들어온다 · 작성자 1명 · 철회 핀 부활 0", async () => {
      const w = await world();
      const write = vi.mocked(writePrivateFileAtomic);
      const real = (await vi.importActual<typeof import("../src/core/fs/privateFiles")>("../src/core/fs/privateFiles")).writePrivateFileAtomic;
      let writing = 0;
      let most = 0;
      let inWrite!: () => void;
      const bInWrite = new Promise<void>((resolve) => { inWrite = resolve; });
      let letBWrite!: () => void;
      const gate = new Promise<void>((resolve) => { letBWrite = resolve; });
      let first = true;
      write.mockImplementation(async (path, text) => {
        writing += 1;
        most = Math.max(most, writing);
        try {
          if (first) {
            first = false;
            inWrite();
            await gate;
          }
          await real(path, text);
        } finally {
          writing -= 1;
        }
      });
      let aDone: Promise<unknown> | undefined;
      let b: Promise<unknown> | undefined;
      let c: Promise<unknown> | undefined;
      try {
        let cWrote = false;
        let hooked!: () => void;
        const aReclaimed = new Promise<void>((resolve) => { hooked = resolve; });
        const newer = await browser("new", "New");
        // A — 죽은 잠금을 본 뒤 멈춘 사이 B(옛 목록을 읽은 추가)가 그 잠금을 치우고 잡아 «최종 교체 직전»까지 간다.
        aDone = updatePcKeys(w.path, () => undefined, opts({
          beforeReclaim: async () => {
            if (b) return;
            b = updatePcKeys(w.path, (keys) => withBrowser(keys, a, w.pcKey, newer), opts());
            await bInWrite;
          },
          // A 가 회수에 손댄 바로 그 틈 — C(핀 철회)가 잡으러 온다. 옛 구현은 여기서 잠금 자리가 비어 C 가 B 보다 먼저 썼다.
          duringReclaim: async () => {
            if (c) return;
            c = updatePcKeys(w.path, (keys) => withoutBrowser(keys, a, "gone").keys, opts()).then(() => { cWrote = true; });
            await Promise.race([c, new Promise((resolve) => setTimeout(resolve, 200))]);
            hooked();
          },
        }));
        await aReclaimed;
        expect(cWrote).toBe(false);
        letBWrite();
        await Promise.all([aDone, b, c]);
        expect(most).toBe(1);
        expect((await loadPcKeys(w.path)).accounts[a]?.browsers.map((item) => item.keyId)).toEqual(["new"]);
        await expect(stat(`${w.path}.lock`)).rejects.toThrow();
        await expect(stat(`${w.path}.lock.reclaim`)).rejects.toThrow();
      } finally {
        letBWrite();
        await Promise.allSettled([aDone, b, c]);
        write.mockImplementation(real);
        await rm(w.dir, { recursive: true, force: true });
      }
    });

    it("회수 표지가 죽은 채 남았으면(치우던 실행이 죽음) 죽은 잠금을 소유자와 맞출 수 없다 — 잠금에 손대지 않고 FileLockConflictError · 아무것도 안 씀", async () => {
      const w = await world();
      try {
        await writeFile(`${w.path}.lock.reclaim`, JSON.stringify({ pid: DEAD, token: "dead-reclaimer" }));
        const newer = await browser("new", "New");
        await expect(updatePcKeys(w.path, (keys) => withBrowser(keys, a, w.pcKey, newer), opts())).rejects.toBeInstanceOf(FileLockConflictError);
        expect((await loadPcKeys(w.path)).accounts[a]?.browsers.map((item) => item.keyId)).toEqual(["gone"]);
        expect(JSON.parse(await readFile(`${w.path}.lock`, "utf8"))).toMatchObject({ token: "dead" });
      } finally {
        await rm(w.dir, { recursive: true, force: true });
      }
    });
  });

  it("죽은 잠금(pid 없음)은 치우고 잡는다 · 살아 있는 잠금은 기한 뒤 FileLockTimeoutError · 바꾸기가 던지면 쓰지 않고 잠금을 푼다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pckeys-stale-"));
    try {
      const path = join(dir, ".ainecto", "pc-keys.json");
      await updatePcKeys(path, () => ({ accounts: {} }));
      await writeFile(`${path}.lock`, JSON.stringify({ pid: 999_999, token: "dead" }));
      const quick = { waitMs: 200, pollMs: 10, isAlive: (pid: number) => pid !== 999_999 };
      await updatePcKeys(path, (keys) => keys, quick);
      await expect(stat(`${path}.lock`)).rejects.toThrow();
      await writeFile(`${path}.lock`, JSON.stringify({ pid: process.pid, token: "live" }));
      await expect(updatePcKeys(path, (keys) => keys, quick)).rejects.toBeInstanceOf(FileLockTimeoutError);
      await rm(`${path}.lock`);
      // 내용 없는 잠금(만든 직후 죽음) — 기한보다 오래됐으면 치운다.
      await writeFile(`${path}.lock`, "");
      const old = new Date(Date.now() - 10_000);
      await utimes(`${path}.lock`, old, old);
      await updatePcKeys(path, (keys) => keys, quick);
      await expect(updatePcKeys(path, () => { throw new Error("boom"); })).rejects.toThrow("boom");
      await expect(stat(`${path}.lock`)).rejects.toThrow();
      expect(await loadPcKeys(path)).toEqual({ accounts: {} });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("없으면 빈 목록(쓰지 않음 · change 가 undefined 면 파일을 만들지 않음) · 저장은 0600 · 깨진 JSON 은 조용히 버리지 않고 오류", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pckeys-"));
    try {
      const path = join(dir, ".ainecto", "pc-keys.json");
      expect(await loadPcKeys(path)).toEqual({ accounts: {} });
      await expect(stat(path)).rejects.toThrow();
      const keys = withBrowser({ accounts: {} }, a, await generateSigningJwk(), await browser("k1", "Chrome"));
      expect(await updatePcKeys(path, () => undefined)).toEqual({ accounts: {} });
      await expect(stat(path)).rejects.toThrow();
      await updatePcKeys(path, () => keys);
      await expect(stat(`${path}.lock`)).rejects.toThrow();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, ".ainecto"))).mode & 0o777).toBe(0o700);
      expect(await loadPcKeys(path)).toEqual(keys);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(keys);
      await writeFile(path, "{not json");
      await expect(loadPcKeys(path)).rejects.toThrow("is not valid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
