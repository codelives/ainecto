import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  accountKey,
  loadPcSettings,
  normalizePcSettings,
  savePcSettings,
  withConsent,
  withoutEndpoint,
  withRemoteTerminal,
} from "../src/core/pc/pcSettings";

describe("~/.ainecto/pc.json — 이 PC 단위 사실 한 곳", () => {
  const id = () => "new-id";

  it("모양이 틀렸거나 hostName 이 다르면 새 pcId 의 빈 설정 — 다른 기기에서 복사된 동의를 쓰지 않는다", () => {
    const stored = { pcId: "p1", hostName: "mac", accounts: { "e#u": { consentedAt: "2026-11-17T00:00:00.000Z", remoteTerminal: true } } };
    expect(normalizePcSettings(stored, "mac", id)).toEqual(stored);
    expect(normalizePcSettings(stored, "other", id)).toEqual({ pcId: "new-id", hostName: "other", accounts: {} });
    expect(normalizePcSettings(undefined, "mac", id)).toEqual({ pcId: "new-id", hostName: "mac", accounts: {} });
    expect(normalizePcSettings({ pcId: "p1", hostName: "mac", accounts: { bad: { remoteTerminal: "yes" } } }, "mac", id).accounts).toEqual({});
  });

  it("동의·원격 허용·잊기 — 동의 없는 계정의 원격 설정은 undefined · 잊기는 그 서버 주소만", () => {
    const base = normalizePcSettings(undefined, "mac", id);
    const a = accountKey("https://ainecto.com/mcp", "u1");
    const b = accountKey("https://dev.ainecto.com/mcp", "u1");
    expect(withRemoteTerminal(base, a, true)).toBeUndefined();
    const consented = withConsent(withConsent(base, a, false, new Date("2026-11-17T01:00:00Z")), b, true, new Date("2026-11-17T02:00:00Z"));
    expect(consented.accounts[a]).toEqual({ consentedAt: "2026-11-17T01:00:00.000Z", remoteTerminal: false });
    expect(withRemoteTerminal(consented, a, true)?.accounts[a]?.remoteTerminal).toBe(true);
    expect(Object.keys(withoutEndpoint(consented, "https://ainecto.com/mcp").accounts)).toEqual([b]);
  });

  it("없으면 새 설정(쓰지 않음) · 저장은 0600 · 깨진 JSON 은 조용히 버리지 않고 오류", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pcset-"));
    try {
      const path = join(dir, ".ainecto", "pc.json");
      const fresh = await loadPcSettings(path, "mac");
      expect(fresh.accounts).toEqual({});
      await expect(stat(path)).rejects.toThrow();
      const saved = withConsent(fresh, "e#u", true, new Date("2026-11-17T00:00:00Z"));
      await savePcSettings(path, saved);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, ".ainecto"))).mode & 0o777).toBe(0o700);
      expect(await loadPcSettings(path, "mac")).toEqual(saved);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
      await writeFile(path, "{not json");
      await expect(loadPcSettings(path, "mac")).rejects.toThrow("is not valid JSON");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
