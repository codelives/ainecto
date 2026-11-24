import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceManager } from "../src/core/pc/pcDevices";
import { updatePcKeys, type PairedBrowser } from "../src/core/pc/pcKeys";
import type { RefuseReason, RequestRelay } from "../src/core/pc/pcPairRelay";
import { browserKeyIdOf, generateSigningJwk, publicJwkOf, publicRawFromJwk } from "../src/core/term/e2e";

/**
 * KAN-1376(Edwin 11-24) — 새 기기 허용 요청을 PC 가 받을 수 없을 때 말없이 버려 웹이 5분을 기다렸고, 다시 누르면 서버가 409 로 막았다.
 * PC 는 이유를 알리고(refuse), 진행 중에 새 요청이 오면 새 요청이 이긴다(서버도 새 요청이 앞 요청을 대신한다).
 */
const ACCOUNT = "acct";

async function keysFile(browsers: number): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), "pc-devices-")), "pc-keys.json");
  const pcKey = await generateSigningJwk();
  const list: PairedBrowser[] = [];
  for (let index = 0; index < browsers; index += 1) {
    const publicJwk = publicJwkOf(await generateSigningJwk());
    list.push({ keyId: await browserKeyIdOf(publicRawFromJwk(publicJwk)), publicJwk, name: `Browser ${index}`, pairedAt: new Date().toISOString() });
  }
  await updatePcKeys(path, () => ({ accounts: { [ACCOUNT]: { pcKey, browsers: list } } }));
  return path;
}

/** 요청마다 중계 하나 — offer 는 중단될 때까지 붙잡는다(사람이 아직 [허용]을 안 누른 상태). */
function relays() {
  const refused: Array<{ requestId: string; reason: RefuseReason }> = [];
  const offered: string[] = [];
  const aborted: string[] = [];
  const relay = (requestId: string): RequestRelay => ({
    async refuse(reason) {
      refused.push({ requestId, reason });
    },
    async offer(_commit, signal) {
      offered.push(requestId);
      await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
      throw new Error("unreachable");
    },
    async reveal() {},
    async deviceConsent() {
      return undefined;
    },
    async done() {},
    async abort() {
      aborted.push(requestId);
    },
  });
  return { relay, refused, offered, aborted };
}

function manager(keysPath: string, relay: (requestId: string) => RequestRelay): DeviceManager {
  return new DeviceManager({
    keysPath,
    accountKey: ACCOUNT,
    userId: "3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f",
    pcId: "pc-1",
    relay,
    notifyRequest: () => {},
    log: () => {},
    closeKey: async () => {},
    remoteOn: () => true,
  });
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check(), what).toBe(true);
}

describe("DeviceManager — 받을 수 없는 요청 · 겹친 요청(KAN-1376)", () => {
  it("이 PC 에 믿는 브라우저가 없으면 말없이 버리지 않고 그 요청에 «no-trusted-browser» 를 알린다", async () => {
    const { relay, refused, offered } = relays();
    await manager(await keysFile(0), relay).onPairRequest("r1");
    expect(refused).toEqual([{ requestId: "r1", reason: "no-trusted-browser" }]);
    expect(offered).toEqual([]);
  });

  it("진행 중에 새 요청이 오면 새 요청이 이긴다 — 앞 작업을 끝내고(abort) 쉬지 않고 새 요청을 받는다", async () => {
    const { relay, refused, offered, aborted } = relays();
    const devices = manager(await keysFile(1), relay);
    await devices.onPairRequest("r1");
    await until(() => offered.includes("r1"), "r1 started");
    await devices.onPairRequest("r2");
    await until(() => offered.includes("r2"), "r2 started after r1 ended");
    expect(aborted).toContain("r1");
    expect(refused, "앞 작업의 끝은 거절·취소가 아니다 — 1분 쉬기(quiet)로 새 요청을 막지 않는다").toEqual([]);
    devices.stop();
  });

  it("거절·취소 뒤 1분 안의 요청은 «quiet» 를 알린다(말없이 버리지 않는다)", async () => {
    const { relay, refused, offered } = relays();
    const devices = manager(await keysFile(1), relay);
    await devices.onPairRequest("r1");
    await until(() => offered.includes("r1"), "r1 started");
    devices.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await devices.onPairRequest("r2");
    expect(refused).toEqual([{ requestId: "r2", reason: "quiet" }]);
  });
});
