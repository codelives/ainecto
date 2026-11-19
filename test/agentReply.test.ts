import type { TurnFacts } from "../src/core/agent/documents";
import { replyForOutcome } from "../src/core/agent/reply";

const limits = { textMaxCharacters: 10, documentsMax: 2 };
const NONE: TurnFacts = { documents: [], createdDocuments: [], cards: [], seen: [] };
const answer = (reply: string, openDocumentUuids: string[] = [], openCardUuids: string[] = []) => ({ reply, openDocumentUuids, openCardUuids });
const ok = (structuredOutput: unknown, facts: Partial<TurnFacts> = {}) =>
  ({ kind: "result" as const, facts: { ...NONE, ...facts }, result: { isError: false, subtype: "success", structuredOutput } });

describe("agent reply — Claude 결과 → 서버 답", () => {
  it("schema 를 지킨 답만 DONE · 문서는 서버 상한까지", () => {
    expect(replyForOutcome(ok(answer("4730"), { documents: ["d1", "d2", "d3"] }), limits, "Claude Code"))
      .toEqual({ status: "DONE", reply: "4730", documentUuids: ["d1", "d2"] });
  });

  it("찾은 문서·카드 — 모델이 고른 것 가운데 이 차례 도구가 돌려준 것만, 쓰기 결과 뒤에 · 상한 안 (KAN-1229 Edwin #2172)", () => {
    const facts = { documents: ["w1"], createdDocuments: ["w1"], cards: ["k1"], seen: ["w1", "f1", "f2", "k1", "k2"] };
    expect(replyForOutcome(ok(answer("찾았어요", ["nope", "f1", "w1"], ["k2", "k1", "nope"]), facts), limits, "Claude Code")).toEqual({
      status: "DONE", reply: "찾았어요",
      documentUuids: ["w1", "f1"], createdDocumentUuids: ["w1"], foundDocumentUuids: ["f1"], cardUuids: ["k1", "k2"],
    });
    // 상한(2)은 쓰기 결과가 먼저 차지한다.
    expect(replyForOutcome(ok(answer("찾았어요", ["f1", "f2"]), { ...facts, documents: ["w1", "w2"] }), limits, "Claude Code"))
      .toMatchObject({ documentUuids: ["w1", "w2"] });
    expect(replyForOutcome(ok(answer("찾았어요", ["f1", "f2"]), { ...facts, documents: ["w1", "w2"] }), limits, "Claude Code"))
      .not.toHaveProperty("foundDocumentUuids");
  });

  it("어긴 답은 «열기»로 고른 것을 싣지 않는다 — 쓰기 결과만", () => {
    const r = replyForOutcome(ok({ reply: "x", openDocumentUuids: ["f1"] }, { documents: ["w1"], seen: ["w1", "f1"] }), limits, "Claude Code");
    expect(r).toMatchObject({ status: "FAILED", errorCode: "SCHEMA_VIOLATION", documentUuids: ["w1"] });
  });

  it("어긴 답(모르는 칸·옛 꼴·빈 글·상한 초과·목록이 글 배열 아님·없음)은 원문을 FAILED SCHEMA_VIOLATION 으로", () => {
    for (const bad of [{ ...answer("x"), documents: [] }, { reply: "x" }, answer("  "), answer("가".repeat(11)),
      { ...answer("x"), openCardUuids: [1] }, { ...answer("x"), openDocumentUuids: "f1" }, undefined]) {
      const r = replyForOutcome(ok(bad), limits, "Claude Code");
      expect(r.status).toBe("FAILED");
      expect(r.errorCode).toBe("SCHEMA_VIOLATION");
      expect(Array.from(r.reply).length).toBeLessThanOrEqual(10);
    }
  });

  it("실패·기한·프로세스 끝은 FAILED + 이유 코드", () => {
    expect(replyForOutcome({ kind: "result", facts: NONE, result: { isError: true, subtype: "error_max_turns" } }, limits, "Claude Code").errorCode).toBe("AGENT_ERROR");
    expect(replyForOutcome({ kind: "timeout" }, limits, "Claude Code").errorCode).toBe("TURN_TIMEOUT");
    expect(replyForOutcome({ kind: "exited", code: 3, signal: null, stderrTail: "" }, limits, "Claude Code").errorCode).toBe("AGENT_EXITED");
  });
});
