import { documentUuidsIn, writeToolNames } from "../src/core/agent/documents";

describe("agent documents — 쓰기 도구 결과의 📄 줄", () => {
  const a = "0777d9d448f6453b8a897a3a10b90543";
  const b = "efd5fdebc99f43a195c228d74b3ae9a2";

  it("문자열·텍스트 배열 둘 다 · 순서대로 · 중복 없이", () => {
    expect(documentUuidsIn(`{"x":1}\n📄 Open in AiNecto: https://dev.ainecto.com/app/docs/${a}`)).toEqual([a]);
    expect(documentUuidsIn([
      { type: "text", text: "{}" },
      { type: "text", text: `📄 원고: https://ainecto.com/app/docs/${b}` },
      { type: "text", text: `📄 원고 다시: https://ainecto.com/app/docs/${b}` },
      { type: "text", text: `📄 Open in AiNecto: https://ainecto.com/app/docs/${a}` },
    ])).toEqual([b, a]);
  });

  it("📄 줄이 아닌 URL · 32자가 아닌 uuid 는 뽑지 않는다", () => {
    expect(documentUuidsIn(`본문 안의 링크 https://ainecto.com/app/docs/${a}`)).toEqual([]);
    expect(documentUuidsIn(`📄 x: https://ainecto.com/app/docs/${a}ff`)).toEqual([]);
    expect(documentUuidsIn(undefined)).toEqual([]);
  });

  it("쓰기 도구 = readOnlyHint 가 참이 아닌 것(서버 표시가 진실원)", () => {
    expect([...writeToolNames([
      { name: "list_documents", annotations: { readOnlyHint: true } },
      { name: "create_documents", annotations: { readOnlyHint: false } },
      { name: "erd_apply_changes" },
    ])]).toEqual(["create_documents", "erd_apply_changes"]);
  });
});
