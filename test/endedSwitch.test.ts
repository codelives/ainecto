import { switchedOffRecords } from "../src/core/term/endedBook";
import type { EndedRecord } from "../src/core/term/protocol";

/** 첫 전환으로 닫힌 세션의 끝 기록(KAN-1616) — 순수 함수. */
describe("switchedOffRecords", () => {
  const AT = "2026-11-27T07:00:00.000Z";
  const TO = "https://example.test/mcp#u1";
  const seen = [
    { name: "fresh-old", instance: "i-1", command: ["/bin/sh"], kind: "user" as const },
    { name: "no-uuid", command: null },
    { name: "booked", instance: "i-2", command: null },
    { name: "other-account", instance: "i-3", command: null },
  ];
  const stored: EndedRecord[] = [
    { instance: "i-2", name: "booked", command: null, endedAt: "2026-11-27T06:59:59.000Z", reason: "exited" },
    { instance: "i-3", name: "other-account", command: null, endedAt: "2026-11-27T06:59:59.000Z", reason: "killed", to: "https://example.test/mcp#u2" },
  ];

  it("기록 없음 → exited 새로 · 수신처 없는 기록 → 수신처만 채움(옛 끝 시각 그대로) · 수신처가 있으면 그대로 · uuid 없는 줄은 뺀다", () => {
    expect(switchedOffRecords(seen, stored, AT, TO)).toEqual([
      { instance: "i-1", name: "fresh-old", kind: "user", command: ["/bin/sh"], endedAt: AT, reason: "exited", to: TO },
      { instance: "i-2", name: "booked", command: null, endedAt: "2026-11-27T06:59:59.000Z", reason: "exited", to: TO },
    ]);
  });

  it("수신처를 모르면(계정 모름) 아무것도 만들지 않는다", () => {
    expect(switchedOffRecords(seen, stored, AT, undefined)).toEqual([]);
  });
});
