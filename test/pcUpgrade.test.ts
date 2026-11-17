import {
  auditPassed,
  cliTagsOf,
  pcIdle,
  provenanceWorkflow,
  releaseChannel,
  reportsVersion,
  sameWorkflow,
  upgradeTarget,
} from "../src/core/pc/pcUpgrade";
import { lastUpgrade } from "../src/core/agent/log";
import { attestationBundle } from "./support/attestation";

describe("자동 업그레이드 — 순수 함수", () => {
  it("채널 — next·latest 모양만, 로컬 빌드(게시판 아님)는 늘 없음", () => {
    expect(releaseChannel("0.14.0-next.10", true)).toBe("next");
    expect(releaseChannel("0.14.0-next.9.1", true)).toBe("next");
    expect(releaseChannel("0.14.0", true)).toBe("latest");
    expect(releaseChannel("dev", true)).toBeUndefined();
    expect(releaseChannel("0.14.0-dev+abc1234", true)).toBeUndefined();
    expect(releaseChannel("0.14.0-next.10", false)).toBeUndefined();
  });

  it("목표 — 내 채널의 판이 지금과 다르면(되돌림도) · 해 본 판은 다시 안 함 · 로컬 빌드는 없음", () => {
    const tags = { next: "0.14.0-next.11", latest: "0.13.1" };
    expect(upgradeTarget({ current: "0.14.0-next.10", release: true, tags, tried: new Set() })).toBe("0.14.0-next.11");
    expect(upgradeTarget({ current: "0.14.0-next.12", release: true, tags, tried: new Set() })).toBe("0.14.0-next.11");
    expect(upgradeTarget({ current: "0.14.0-next.11", release: true, tags, tried: new Set() })).toBeUndefined();
    expect(upgradeTarget({ current: "0.13.0", release: true, tags, tried: new Set() })).toBe("0.13.1");
    expect(upgradeTarget({ current: "0.14.0-next.10", release: true, tags, tried: new Set(["0.14.0-next.11"]) })).toBeUndefined();
    expect(upgradeTarget({ current: "0.14.0-next.10", release: false, tags, tried: new Set() })).toBeUndefined();
    expect(upgradeTarget({ current: "0.14.0-next.10", release: true, tags: { latest: "0.13.1" }, tried: new Set() })).toBeUndefined();
    expect(upgradeTarget({ current: "0.14.0-next.10", release: true, tags: undefined, tried: new Set() })).toBeUndefined();
  });

  it("한가 — Agent 할 일 없음 + 보는 세션 0 · cli 칸 읽기", () => {
    expect(pcIdle({ agentBusy: false, watching: 0 })).toBe(true);
    expect(pcIdle({ agentBusy: true, watching: 0 })).toBe(false);
    expect(pcIdle({ agentBusy: false, watching: 1 })).toBe(false);
    expect(cliTagsOf({ next: "0.14.0-next.11", latest: "0.13.1", other: 1 })).toEqual({ next: "0.14.0-next.11", latest: "0.13.1" });
    expect(cliTagsOf({ next: "" })).toBeUndefined();
    expect(cliTagsOf(undefined)).toBeUndefined();
  });

  it("판 출력·audit 판정", () => {
    expect(reportsVersion('{\n  "version": "0.14.0-next.9.1"\n}\n', "0.14.0-next.9.1")).toBe(true);
    expect(reportsVersion('{"version": "0.14.0-next.9"}', "0.14.0-next.9.1")).toBe(false);
    expect(reportsVersion("0.14.0-next.9.1\n", "0.14.0-next.9.1")).toBe(true);
    expect(auditPassed(0, "audited 3 packages in 1s\n\n3 packages have verified registry signatures\n\n1 package has a verified attestation\n")).toBe(true);
    expect(auditPassed(0, "audited 3 packages in 1s\n\n3 packages have verified registry signatures\n")).toBe(false);
    expect(auditPassed(1, "1 package has an invalid attestation")).toBe(false);
  });

  it("증명 대조 — 그 판의 SLSA workflow · 다른 판의 묶음·모양 틀림은 없음 · 저장소·경로가 같아야", () => {
    const ours = provenanceWorkflow(attestationBundle("0.14.0-next.10"), "@ainecto/mcp", "0.14.0-next.10");
    expect(ours).toEqual({ repository: "https://github.com/codelives/ainecto", path: ".github/workflows/publish.yml" });
    expect(provenanceWorkflow(attestationBundle("0.14.0-next.9"), "@ainecto/mcp", "0.14.0-next.10")).toBeUndefined();
    expect(provenanceWorkflow({ attestations: [] }, "@ainecto/mcp", "0.14.0-next.10")).toBeUndefined();
    expect(provenanceWorkflow("nope", "@ainecto/mcp", "0.14.0-next.10")).toBeUndefined();
    const fork = provenanceWorkflow(attestationBundle("0.14.0-next.11", { repository: "https://github.com/someone/fork", path: ".github/workflows/publish.yml" }),
      "@ainecto/mcp", "0.14.0-next.11");
    expect(ours && fork && sameWorkflow(ours, fork)).toBe(false);
    expect(ours && sameWorkflow(ours, { ...ours })).toBe(true);
  });

  it("마지막 갈아타기 — agent.log 의 끝·실패·거절 중 마지막", () => {
    const line = (event: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ ts: "2026-11-17T01:00:00Z", event, from: "0.14.0-next.10", to: "0.14.0-next.11", ...extra });
    expect(lastUpgrade([line("upgrade_start"), line("upgrade_done")].join("\n")))
      .toEqual({ at: "2026-11-17T01:00:00Z", result: "upgraded", from: "0.14.0-next.10", to: "0.14.0-next.11" });
    expect(lastUpgrade([line("upgrade_done"), line("upgrade_refused", { reason: "workflow-differs" })].join("\n"))?.result).toBe("refused");
    expect(lastUpgrade(line("upgrade_start"))).toBeUndefined();
  });
});
