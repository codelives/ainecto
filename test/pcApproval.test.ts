import { describe, expect, it } from "vitest";
import { ApprovalSlot } from "../src/core/pc/pcApproval";
import { runPairing, type ApprovalRequest, type BrowserOffer, type MatchedBrowser, type PairTransport } from "../src/core/pc/pcPairing";
import {
  assertCommitment,
  browserKeyIdOf,
  generateSigningJwk,
  importSigningKey,
  pairApproveInput,
  pairCodes,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicRawFromJwk,
  randomBytes,
  signBytes,
  verifyBytes,
} from "../src/core/term/e2e";

/**
 * 새 기기 허용(approve-new-device §3-2 · §3-3) — runPairing(approval) + ApprovalSlot.
 * 중계는 가짜지만 새 기기(N)는 진짜 암호로 행동한다: 약속값 대조 → 같은 T 로 숫자 계산 → [같아요] 서명 → done 서명 검증.
 */
const USER_ID = "5b1f2c9e-0a7d-4e63-8f41-9c2d7b6a3e10";
const PC_ID = "6f2c1d3e-0000-4000-8000-000000000004";
const APPROVER = "b1-key";

type Click = "same" | "cancel" | "wrong-t";

/** 새 기기 N — macB 없이 제안한다. swapKey 면 서버가 PC 쪽으로 N 키를 공격자 키로 바꿔 넘긴다(N 은 자기 키로 T 를 계산·서명). */
async function newDevice(options: { swapKey?: boolean; click?: Click; clickDelayMs?: number } = {}) {
  const own = await generateSigningJwk();
  const ownPub = publicRawFromJwk(own);
  const sentPub = options.swapKey ? publicRawFromJwk(await generateSigningJwk()) : ownPub;
  const nB = randomBytes(32);
  const state: { commit?: Uint8Array; transcript?: Uint8Array; pcPub?: Uint8Array; code?: string; doneVerified: boolean; aborts: string[] } = {
    doneVerified: false, aborts: [],
  };
  const transport: PairTransport = {
    async offer(commit) {
      state.commit = commit;
      const offer: BrowserOffer = { keyId: await browserKeyIdOf(sentPub), publicRaw: sentPub, nB, name: "Safari · iPhone", attemptId: "attempt-1" };
      return offer;
    },
    async reveal(pcPub, nP, _signal, macP) {
      if (macP) throw new Error("approval reveal carries no macP");
      if (!state.commit) throw new Error("reveal before offer");
      await assertCommitment(state.commit, pcPub, nP);
      state.pcPub = pcPub;
      state.transcript = await pairTranscript({ userId: USER_ID, pcId: PC_ID, pcPublicRaw: pcPub, browserPublicRaw: ownPub, nP, nB });
      state.code = (await pairCodes(state.transcript)).a;
    },
    async deviceConsent(signal) {
      if (!state.transcript) throw new Error("consent before reveal");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.clickDelayMs ?? 0);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("consent wait aborted"));
        }, { once: true });
      });
      const click = options.click ?? "same";
      if (click === "cancel") return undefined;
      const signed = click === "wrong-t" ? randomBytes(32) : state.transcript;
      return await signBytes(await importSigningKey(own), pairApproveInput(signed));
    },
    async done(signature) {
      if (!state.pcPub || !state.transcript) throw new Error("done before reveal");
      state.doneVerified = await verifyBytes(publicJwkFromRaw(state.pcPub), signature, pairDoneInput(state.transcript));
    },
    async abort(reason) {
      state.aborts.push(reason);
    },
  };
  return { transport, state };
}

/** PC 쪽 등록 한 번 — B1 결정은 slot 으로. onRequest = 대기에 들어온 순간(이미 믿는 브라우저가 물어 가져갈 수 있는 때). */
async function pairWithSlot(device: Awaited<ReturnType<typeof newDevice>>, onRequest: (request: ApprovalRequest, slot: ApprovalSlot) => void,
  options: { waitMs?: number; pin?: (approver: string | undefined) => boolean } = {}) {
  const slot = new ApprovalSlot();
  const order: string[] = [];
  const pinned: Array<{ browser: MatchedBrowser; approver: string | undefined }> = [];
  const outcome = await runPairing({
    userId: USER_ID, pcId: PC_ID, pcKey: await generateSigningJwk(), transport: device.transport, waitMs: options.waitMs ?? 10_000,
    confirm: {
      kind: "approval",
      approve: (request, signal) => {
        order.push("approve");
        const waiting = slot.wait(request, new Date(), signal);
        onRequest(request, slot);
        return waiting;
      },
    },
    pin: async (browser, approver) => {
      order.push("pin");
      if (options.pin && !options.pin(approver)) return false;
      pinned.push({ browser, approver });
      return true;
    },
  });
  return { outcome, pinned, order, slot };
}

describe("새 기기 허용 — runPairing(approval) · 양쪽 동의", () => {
  it("B1 먼저 · N 나중 — 숫자가 같고 · 둘 다 온 뒤에만 핀 · N 이 done 을 검증", async () => {
    const device = await newDevice({ clickDelayMs: 30 });
    let shown: string | undefined;
    const { outcome, pinned, order } = await pairWithSlot(device, (request, slot) => {
      shown = request.code;
      expect(slot.decide(request.transcript, true, APPROVER)).toBe("recorded");
    });
    expect(outcome.kind).toBe("paired");
    expect(shown).toMatch(/^\d{6}$/);
    expect(shown).toBe(device.state.code);
    expect(order).toEqual(["approve", "pin"]);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]?.approver).toBe(APPROVER);
    expect(pinned[0]?.browser.name).toBe("Safari · iPhone");
    expect(device.state.doneVerified).toBe(true);
    expect(device.state.aborts).toEqual([]);
  });

  it("N 먼저 · B1 나중 — 같다", async () => {
    const device = await newDevice();
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      setTimeout(() => slot.decide(request.transcript, true, APPROVER), 30);
    });
    expect(outcome.kind).toBe("paired");
    expect(pinned).toHaveLength(1);
    expect(device.state.doneVerified).toBe(true);
  });

  it("B1 허용 뒤 N 취소 — 핀 0", async () => {
    const device = await newDevice({ click: "cancel", clickDelayMs: 30 });
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      expect(slot.decide(request.transcript, true, APPROVER)).toBe("recorded");
    });
    expect(outcome.kind).toBe("code-mismatch");
    expect(pinned).toEqual([]);
    expect(device.state.doneVerified).toBe(false);
    expect(device.state.aborts).toEqual(["code-mismatch"]);
  });

  it("B1 거절 — 핀 0 · N 동의 대기도 풀린다", async () => {
    const device = await newDevice({ clickDelayMs: 5_000 });
    const started = Date.now();
    const { outcome, pinned, slot } = await pairWithSlot(device, (request, s) => {
      expect(s.decide(request.transcript, false, APPROVER)).toBe("rejected");
    });
    expect(outcome.kind).toBe("code-mismatch");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(pinned).toEqual([]);
    expect(slot.busy).toBe(false);
  });

  it("다른 T 의 허용은 stale — 대기는 그대로 · 기한이 지나면 timeout · 핀 0 · 대기도 비워진다", async () => {
    const device = await newDevice();
    const { outcome, pinned, slot } = await pairWithSlot(device, (request, s) => {
      const other = new Uint8Array(request.transcript);
      other[0] = (other[0] ?? 0) ^ 1;
      expect(s.decide(other, true, APPROVER)).toBe("stale");
      expect(s.busy).toBe(true);
    }, { waitMs: 200 });
    expect(outcome.kind).toBe("timeout");
    expect(pinned).toEqual([]);
    expect(slot.busy).toBe(false);
    expect(device.state.aborts).toEqual(["timeout"]);
  });

  it("N 서명이 다른 T 에 대한 것이면 — 핀 0", async () => {
    const device = await newDevice({ click: "wrong-t" });
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      slot.decide(request.transcript, true, APPROVER);
    });
    expect(outcome.kind).toBe("code-mismatch");
    expect(pinned).toEqual([]);
  });

  it("핀 쓰는 순간 허용한 브라우저 키가 지워져 있으면 — 핀 0 · done 없음", async () => {
    const device = await newDevice();
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      slot.decide(request.transcript, true, APPROVER);
    }, { pin: () => false });
    expect(outcome.kind).toBe("code-mismatch");
    expect(pinned).toEqual([]);
    expect(device.state.doneVerified).toBe(false);
  });

  it("같은 T 에 결정 두 번 — 첫 것만", async () => {
    const device = await newDevice({ clickDelayMs: 30 });
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      expect(slot.decide(request.transcript, true, APPROVER)).toBe("recorded");
      expect(slot.decide(request.transcript, false, APPROVER)).toBe("stale");
    });
    expect(outcome.kind).toBe("paired");
    expect(pinned).toHaveLength(1);
  });

  it("서버가 PC 쪽으로 새 기기 키를 바꾸면 — PC 숫자 ≠ N 숫자 · N 서명도 맞지 않는다", async () => {
    const device = await newDevice({ swapKey: true });
    let pcCode: string | undefined;
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      pcCode = request.code;
      slot.decide(request.transcript, true, APPROVER);   // 사람이 숫자를 안 보고 눌러도
    });
    expect(pcCode).toMatch(/^\d{6}$/);
    expect(pcCode).not.toBe(device.state.code);
    expect(outcome.kind).toBe("code-mismatch");
    expect(pinned).toEqual([]);
  });
});

describe("ApprovalSlot", () => {
  it("대기는 하나 · 끝나면 비워진다 · 후보 키를 지우면 그 대기를 끝낸다", async () => {
    const slot = new ApprovalSlot();
    const request: ApprovalRequest = { transcript: randomBytes(32), code: "123456", name: "x", keyId: "n-key" };
    const first = new AbortController();
    const waiting = slot.wait(request, new Date(), first.signal);
    await expect(slot.wait({ ...request }, new Date(), new AbortController().signal)).rejects.toThrow();
    expect(slot.pending()?.request).toBe(request);
    expect(slot.cancelInvolving("other-key")).toBe(false);
    expect(slot.cancelInvolving("n-key")).toBe(true);
    await expect(waiting).rejects.toThrow(/removed/);
    expect(slot.pending()).toBeUndefined();
    const second = slot.wait(request, new Date(), first.signal);
    first.abort();
    await expect(second).rejects.toThrow();
    expect(slot.busy).toBe(false);
  });
});
