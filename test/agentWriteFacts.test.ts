import { WriteFactsCollector, writeResultFacts } from "../src/core/agent/documents";

const doc = (uuid: string) => `📄 Open in AiNecto: https://dev.ainecto.com/app/docs/${uuid}`;
const A = "0777d9d448f6453b8a897a3a10b90543";
const B = "efd5fdebc99f43a195c228d74b3ae9a2";
const CARD = "b3fa7bd9c83a4969b780619bbc302d0d";
const BOARD = "9f0cfd35bcd3420abfdea98c66c36ab1";

describe("agent write facts — 쓰기 도구 결과 → 문서·새 문서·카드(한 곳)", () => {
  it("create_documents 의 created 배열에 있는 📄 문서만 «새 문서»", () => {
    // 실측 모양(three-agents codex-1 create_documents 결과).
    expect(writeResultFacts([
      { type: "text", text: `{"count":1,"created":[{"uuid":"${A}","type":"markdown","title":"t"}],"warnings":[]}` },
      { type: "text", text: doc(A) },
      { type: "text", text: `${A} marked as being written (lastWriteAt 2026-11-12T05:20:43Z). Call finish_documents when complete.` },
      { type: "text", text: "🔔 AiNecto: 2 unread notifications · 1 to-do" },
    ])).toEqual({ documents: [A], createdDocuments: [A], cards: [] });
  });

  it("고친 문서(updated · 인자의 documentUuid)는 문서지만 새 문서가 아니다", () => {
    expect(writeResultFacts([{ type: "text", text: `{"updated":[{"uuid":"${B}","type":"markdown","title":"t"}]}` }, { type: "text", text: doc(B) }]))
      .toEqual({ documents: [B], createdDocuments: [], cards: [] });
  });

  it("created 에 있어도 📄 줄이 없으면 문서가 아니다(서버가 문서로 붙인 것만)", () => {
    expect(writeResultFacts(`{"created":[{"uuid":"${A}","name":"폴더"}]}`)).toEqual({ documents: [], createdDocuments: [], cards: [] });
  });

  it("칸반 결과의 cardUuid(32 hex) 를 깊이와 상관없이 모은다 · 보드는 고친 문서", () => {
    // 실측 모양(kanban_apply_changes create · update).
    const content = [
      { type: "text", text: `{"documentUuid":"${BOARD}","results":[{"index":0,"op":"create","cardUuid":"${CARD}","revision":0},`
        + `{"index":1,"op":"update","cardUuid":"${CARD}"},{"index":2,"op":"create","cardUuid":"not-a-uuid"}]}` },
      { type: "text", text: doc(BOARD) },
    ];
    expect(writeResultFacts(content)).toEqual({ documents: [BOARD], createdDocuments: [], cards: [CARD] });
  });

  it("문서 본문 안의 글(이스케이프된 JSON)은 카드로 읽지 않는다 · JSON 이 아닌 글은 건너뛴다", () => {
    const body = JSON.stringify({ content: `{"cardUuid":"${CARD}"}` });
    expect(writeResultFacts([{ type: "text", text: body }, { type: "text", text: "{not json" }]).cards).toEqual([]);
  });

  it("한 차례 동안 모은 값은 순서대로 · 중복 없이", () => {
    const facts = new WriteFactsCollector();
    facts.add([{ type: "text", text: `{"created":[{"uuid":"${A}"}]}` }, { type: "text", text: doc(A) }]);
    facts.add([{ type: "text", text: `{"documentUuid":"${BOARD}","results":[{"cardUuid":"${CARD}"}]}` }, { type: "text", text: doc(BOARD) }]);
    facts.add([{ type: "text", text: `{"updated":[{"uuid":"${A}"}]}` }, { type: "text", text: doc(A) }]);
    expect(facts.snapshot()).toEqual({ documents: [A, BOARD], createdDocuments: [A], cards: [CARD] });
  });
});
