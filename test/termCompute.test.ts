import { compute, type ComputeModule } from "../src/core/term/compute";
import { COMPUTE_VIEW, rejectReason } from "../src/core/term/computeSlot";
import { XTERM_VERSION } from "../src/core/term/xtermVersion";

/**
 * 계산 모듈(세션 유지 구조 3-2) — holder 가 받기 전에 스스로 하는 확인. 묶여 온 모듈은 이 holder 의 xterm·파서 훅으로 자기 시험을 다 통과해야 하고
 * (휠 1000→1016 · 1000→1006→1016 = 0.16.3 바이트 — keys.ts·screen.ts 는 바탕 0.16.6 그대로), 어긋난 모듈은 이유와 함께 거절된다.
 */
describe("계산 모듈 확인(rejectReason)", () => {
  it("묶여 온 모듈 = 이 holder 의 xterm 판 · 요구 칸이 holder 가 넘기는 칸 안 · 자기 시험 전부 통과", async () => {
    expect(compute.xterm).toBe(XTERM_VERSION);
    expect(compute.needs.filter((need) => !COMPUTE_VIEW.includes(need))).toEqual([]);
    expect(compute.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "mouse 1000 → 1016 (X10 wheel, as 0.16.3)", "mouse 1000 → 1006 → 1016 (SGR cell wheel, as 0.16.3)"]));
    expect(await rejectReason(compute)).toBeUndefined();
  });

  it("xterm 판이 다르면 · holder 가 못 넘기는 칸을 요구하면 · 자기 시험이 어긋나면 · 던지면 · 모양이 아니면 — 이유", async () => {
    expect(await rejectReason({ ...compute, xterm: "5.5.0" })).toBe(`the module was built for xterm 5.5.0, this holder runs xterm ${XTERM_VERSION}`);
    expect(await rejectReason({ ...compute, needs: [...compute.needs, "flags.pixelMouse"] }))
      .toBe("the module needs screen fields this holder does not pass: flags.pixelMouse");
    expect(await rejectReason({ ...compute, checks: [] })).toBe("the module has no self-checks");
    const wrongRead: ComputeModule = { ...compute, read: () => ["something else"] };
    expect(await rejectReason(wrongRead)).toBe(`self-check "plain shell screen" failed: read gave ["something else"], expected ["hello","red dim"]`);
    const wrongWheel: ComputeModule = { ...compute, key: (view, name) => (name === "wheel-up" ? "\x1b[<64;1;1M" : compute.key(view, name)) };
    expect(await rejectReason(wrongWheel)).toMatch(/^self-check "plain shell screen" failed: key wheel-up gave/);
    const throwing: ComputeModule = { ...compute, modes: () => { throw new Error("boom"); } };
    expect(await rejectReason(throwing)).toBe(`self-check "plain shell screen" failed: threw boom`);
    expect(await rejectReason(undefined)).toBe("the file does not export a compute module");
    const { reset: _reset, ...noReset } = compute;
    expect(await rejectReason(noReset)).toBe("the module has no reset()");
  });
});
