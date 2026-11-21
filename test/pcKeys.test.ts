import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { FileLockTimeoutError } from "../src/core/fs/fileLock";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROWSER_NAME_MAX,
  browserNameOf,
  loadPcKeys,
  normalizePcKeys,
  updatePcKeys,
  withBrowser,
  withoutBrowser,
  withoutEndpointKeys,
  type PairedBrowser,
} from "../src/core/pc/pcKeys";
import { accountKey } from "../src/core/pc/pcSettings";
import { generateSigningJwk, publicJwkOf } from "../src/core/term/e2e";

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
