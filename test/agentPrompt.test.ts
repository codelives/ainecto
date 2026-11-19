import { AGENT_OPEN_RULE, agentPromptText } from "../src/core/agent/prompt";

describe("agent prompt — 차례마다 «열기» 규칙 줄 + 맥락 줄 (KAN-1229 Edwin #2172)", () => {
  it("맥락이 없어도 규칙 줄은 늘 맨 앞 — «열었습니다» 금지 · open* 목록 · 실제와 맞는 안내", () => {
    expect(agentPromptText("문서 열어 줘", undefined)).toBe(`${AGENT_OPEN_RULE}\n\n문서 열어 줘`);
    expect(AGENT_OPEN_RULE).toContain("never say you opened");
    expect(AGENT_OPEN_RULE).toContain("openDocumentUuids / openCardUuids");
    expect(AGENT_OPEN_RULE).toContain("«찾았습니다. 아래 열기 버튼에서 확인할 수 있습니다.»");
  });

  it("맥락이 있으면 규칙 줄 다음에 맥락 줄", () => {
    expect(agentPromptText("이 카드 열어", { card: { uuid: "c1", key: "KAN-1", title: "카드" } })).toBe(`${AGENT_OPEN_RULE}\n`
      + '[AiNecto context — "this project" / "this document" / "this card" mean these] card «카드» (KAN-1, cardUuid c1)\n\n이 카드 열어');
  });
});
