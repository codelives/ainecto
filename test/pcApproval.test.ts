import { describe, expect, it } from "vitest";
import { ApprovalSlot } from "../src/core/pc/pcApproval";
import { runPairing, type ApprovalRequest, type BrowserOffer, type MatchedBrowser, type PairTransport } from "../src/core/pc/pcPairing";
import {
  assertCommitment,
  browserKeyIdOf,
  generateSigningJwk,
  pairCodes,
  pairDoneInput,
  pairTranscript,
  publicJwkFromRaw,
  publicRawFromJwk,
  randomBytes,
  verifyBytes,
} from "../src/core/term/e2e";

/**
 * 새 기기 허용(approve-new-device §3-2 · §3-3) — runPairing(approval) + ApprovalSlot.
 * 중계는 가짜지만 새 기기(N)는 진짜 암호로 행동한다: 약속값 대조 → 같은 T 로 숫자 계산 → done 서명 검증.
 */
const USER_ID = "5b1f2c9e-0a7d-4e63-8f41-9c2d7b6a3e10";
const PC_ID = "6f2c1d3e-0000-4000-8000-000000000004";

/** 새 기기 N — macB 없이 제안한다. swapKey 면 서버가 PC 쪽으로 N 키를 공격자 키로 바꿔 넘긴다(N 은 자기 키로 T 를 계산). */
async function newDevice(options: { swapKey?: boolean } = {}) {
  const ownPub = publicRawFromJwk(await generateSigningJwk());
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

/** PC 쪽 등록 한 번 — 허용은 slot 으로 기다린다. onRequest 는 대기에 들어온 순간(=이미 믿는 브라우저가 물어 가져갈 수 있는 때). */
async function pairWithSlot(device: Awaited<ReturnType<typeof newDevice>>, onRequest: (request: ApprovalRequest, slot: ApprovalSlot) => void,
  waitMs = 10_000) {
  const slot = new ApprovalSlot();
  const order: string[] = [];
  const pinned: MatchedBrowser[] = [];
  const outcome = await runPairing({
    userId: USER_ID, pcId: PC_ID, pcKey: await generateSigningJwk(), transport: device.transport, waitMs,
    confirm: {
      kind: "approval",
      approve: (request, signal) => {
        order.push("approve");
        const waiting = slot.wait(request, new Date(), signal);
        onRequest(request, slot);
        return waiting;
      },
    },
    pin: async (browser) => { order.push("pin"); pinned.push(browser); },
  });
  return { outcome, pinned, order, slot };
}

describe("새 기기 허용 — runPairing(approval)", () => {
  it("허용 — 두 화면 숫자가 같고 · 허용 뒤에만 핀 · 새 기기가 done 을 검증", async () => {
    const device = await newDevice();
    let shown: string | undefined;
    const { outcome, pinned, order } = await pairWithSlot(device, (request, slot) => {
      shown = request.code;
      expect(slot.decide(request.transcript, true)).toBe("accepted");
    });
    expect(outcome.kind).toBe("paired");
    expect(shown).toMatch(/^\d{6}$/);
    expect(shown).toBe(device.state.code);
    expect(order).toEqual(["approve", "pin"]);
    expect(pinned[0]?.name).toBe("Safari · iPhone");
    expect(device.state.doneVerified).toBe(true);
    expect(device.state.aborts).toEqual([]);
  });

  it("거절 — 핀 0 · 새 기기에 code-mismatch", async () => {
    const device = await newDevice();
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      expect(slot.decide(request.transcript, false)).toBe("rejected");
    });
    expect(outcome.kind).toBe("code-mismatch");
    expect(pinned).toEqual([]);
    expect(device.state.doneVerified).toBe(false);
    expect(device.state.aborts).toEqual(["code-mismatch"]);
  });

  it("다른 T 의 허용은 stale — 대기는 그대로 · 기한이 지나면 timeout · 핀 0 · 대기도 비워진다", async () => {
    const device = await newDevice();
    const { outcome, pinned, slot } = await pairWithSlot(device, (request, s) => {
      const other = new Uint8Array(request.transcript);
      other[0] = (other[0] ?? 0) ^ 1;
      expect(s.decide(other, true)).toBe("stale");
      expect(s.busy).toBe(true);
    }, 200);
    expect(outcome.kind).toBe("timeout");
    expect(pinned).toEqual([]);
    expect(slot.busy).toBe(false);
    expect(device.state.aborts).toEqual(["timeout"]);
  });

  it("같은 T 에 허용 두 번 — 첫 것만", async () => {
    const device = await newDevice();
    const { outcome, pinned } = await pairWithSlot(device, (request, slot) => {
      expect(slot.decide(request.transcript, true)).toBe("accepted");
      expect(slot.decide(request.transcript, false)).toBe("stale");
    });
    expect(outcome.kind).toBe("paired");
    expect(pinned).toHaveLength(1);
  });

  it("서버가 PC 쪽으로 새 기기 키를 바꾸면 — PC 가 보이는 숫자 ≠ 새 기기 숫자(사람은 거절한다)", async () => {
    const device = await newDevice({ swapKey: true });
    let pcCode: string | undefined;
    await pairWithSlot(device, (request, slot) => {
      pcCode = request.code;
      slot.decide(request.transcript, false);
    });
    expect(pcCode).toMatch(/^\d{6}$/);
    expect(device.state.code).toMatch(/^\d{6}$/);
    expect(pcCode).not.toBe(device.state.code);
  });

  it("대기 중이면 두 번째 대기는 거절한다(다리당 하나)", async () => {
    const slot = new ApprovalSlot();
    const request: ApprovalRequest = { transcript: randomBytes(32), code: "123456", name: "x" };
    const first = new AbortController();
    const waiting = slot.wait(request, new Date(), first.signal);
    await expect(slot.wait({ ...request }, new Date(), new AbortController().signal)).rejects.toThrow();
    expect(slot.pending()?.request).toBe(request);
    first.abort();
    await expect(waiting).rejects.toThrow();
    expect(slot.pending()).toBeUndefined();
  });
});
