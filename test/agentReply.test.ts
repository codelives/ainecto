import { replyForOutcome } from "../src/core/agent/reply";

const limits = { textMaxCharacters: 10, documentsMax: 2 };
const ok = (structuredOutput: unknown, documents: string[] = []) =>
  ({ kind: "result" as const, documents, result: { isError: false, subtype: "success", structuredOutput } });

describe("agent reply — Claude 결과 → 서버 답", () => {
  it("schema 를 지킨 reply 만 DONE · 문서는 서버 상한까지", () => {
    expect(replyForOutcome(ok({ reply: "4730" }, ["d1", "d2", "d3"]), limits))
      .toEqual({ status: "DONE", reply: "4730", documentUuids: ["d1", "d2"] });
  });

  it("어긴 답(모르는 칸·빈 글·상한 초과·없음)은 원문을 FAILED SCHEMA_VIOLATION 으로", () => {
    for (const bad of [{ reply: "x", documents: [] }, { reply: "  " }, { reply: "가".repeat(11) }, undefined]) {
      const r = replyForOutcome(ok(bad), limits);
      expect(r.status).toBe("FAILED");
      expect(r.errorCode).toBe("SCHEMA_VIOLATION");
      expect(Array.from(r.reply).length).toBeLessThanOrEqual(10);
    }
  });

  it("실패·기한·프로세스 끝은 FAILED + 이유 코드", () => {
    expect(replyForOutcome({ kind: "result", documents: [], result: { isError: true, subtype: "error_max_turns" } }, limits).errorCode).toBe("AGENT_ERROR");
    expect(replyForOutcome({ kind: "timeout" }, limits).errorCode).toBe("TURN_TIMEOUT");
    expect(replyForOutcome({ kind: "exited", code: 3, signal: null, stderrTail: "" }, limits).errorCode).toBe("AGENT_EXITED");
  });
});
