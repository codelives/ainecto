import { describe, expect, it, vi } from "vitest";
import { fetchHarnessDocuments, AGENT_NOTE_KEY, DOC_KEY } from "../src/core/harness/documentFetch";
import { renderAgentNote, renderHarnessDoc } from "../src/core/harness/harnessDoc";

const ENDPOINT = "https://ai-erd.com/mcp";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("하네스 문서를 서버에서 받는다", () => {
  it("MCP 엔드포인트 아래로 요청하고 토큰을 싣는다", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      documents: {
        [DOC_KEY]: {
          body: "server doc {{projectName}} {{projectUuid}} {{endpoint}}",
          version: "HARNESS.DOC@harness-r3",
        },
        [AGENT_NOTE_KEY]: {
          body: "<!-- ai-erd:begin -->see {{harnessDocPath}} on {{serverName}}<!-- ai-erd:end -->",
          version: "HARNESS.AGENT_NOTE@harness-r1",
        },
      },
    })) as unknown as typeof fetch;

    const result = await fetchHarnessDocuments({
      endpoint: ENDPOINT, accessToken: "t", client: "ai-erd-cli", fetchImpl,
    });

    // ★/api/v1 이 아니다 — MCP 토큰은 REST 에서 거절된다.
    expect(vi.mocked(fetchImpl).mock.calls[0]![0])
      .toBe("https://ai-erd.com/mcp/harness/documents?client=ai-erd-cli");
    expect(result.doc).toBe("server doc {{projectName}} {{projectUuid}} {{endpoint}}");
    expect(result.versions[DOC_KEY]).toBe("HARNESS.DOC@harness-r3");
    expect(result.unavailableReason).toBeUndefined();
  });

  it("★못 받으면 «못 받았다»고 말한다", async () => {
    const failing = vi.fn(async () => jsonResponse({}, 503)) as unknown as typeof fetch;
    const throwing = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;

    expect((await fetchHarnessDocuments({ endpoint: ENDPOINT, fetchImpl: failing })).unavailableReason)
      .toContain("503");
    expect((await fetchHarnessDocuments({ endpoint: ENDPOINT, fetchImpl: throwing })).unavailableReason)
      .toContain("offline");
  });

  it("빈 본문은 «받은 것»으로 치지 않는다", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      documents: { [DOC_KEY]: { body: "   ", version: "x" } },
    })) as unknown as typeof fetch;

    const result = await fetchHarnessDocuments({ endpoint: ENDPOINT, fetchImpl });
    expect(result.doc).toBeUndefined();
    // ★HTTP 200 이었으므로 unavailableReason 은 없다 — 그래도 «왜 패키지 판을 쓰는지»는 남는다.
    expect(result.unavailableReason).toBeUndefined();
    expect(result.fallbacks[DOC_KEY]).toContain("no body");
  });

  it("★필수 변수가 빠진 본문은 받지 않는다", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      documents: { [DOC_KEY]: { body: "server doc with no placeholders", version: "HARNESS.DOC@harness-r9" } },
    })) as unknown as typeof fetch;

    const result = await fetchHarnessDocuments({ endpoint: ENDPOINT, fetchImpl });
    // 채울 자리가 없는 글은 채워도 프로젝트를 가리키지 못한다 — 쓰지 않는다.
    expect(result.doc).toBeUndefined();
    expect(result.versions[DOC_KEY]).toBeUndefined();
    expect(result.fallbacks[DOC_KEY]).toContain("{{projectName}}");
  });

  it("★관리 마커가 없는 AGENT_NOTE 는 받지 않는다", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      documents: {
        [AGENT_NOTE_KEY]: { body: "see {{harnessDocPath}} on {{serverName}}", version: "x" },
      },
    })) as unknown as typeof fetch;

    const result = await fetchHarnessDocuments({ endpoint: ENDPOINT, fetchImpl });
    // 마커가 없으면 우리 블록을 다시 못 찾아 재실행마다 덧붙고 undo 도 못 걷어낸다.
    expect(result.agentNote).toBeUndefined();
    expect(result.fallbacks[AGENT_NOTE_KEY]).toContain("ai-erd:begin");
  });

  it("★마커 «밖»에 글이 달린 AGENT_NOTE 는 받지 않는다", async () => {
    // 4차 독립 리뷰 I4 — 넣는 범위(본문 전체)와 빼는 범위(마커 사이)가 달라서,
    // 바깥 글이 init 마다 한 번씩 쌓이고 undo 로도 안 걷혔다.
    const fetchImpl = vi.fn(async () => jsonResponse({
      documents: {
        [AGENT_NOTE_KEY]: {
          body: "Preamble.\n<!-- ai-erd:begin -->\nRead {{harnessDocPath}} on {{serverName}}\n"
            + "<!-- ai-erd:end -->\nTrailing.",
          version: "x",
        },
      },
    })) as unknown as typeof fetch;

    const result = await fetchHarnessDocuments({ endpoint: ENDPOINT, fetchImpl });
    expect(result.agentNote).toBeUndefined();
    expect(result.fallbacks[AGENT_NOTE_KEY]).toContain("never removed by --undo");
  });

  it("서버가 말해 준 사유를 그대로 전한다", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      documents: { [DOC_KEY]: { body: "", version: "code", reason: "no usable registry version for HARNESS.DOC" } },
    })) as unknown as typeof fetch;

    const result = await fetchHarnessDocuments({ endpoint: ENDPOINT, fetchImpl });
    expect(result.fallbacks[DOC_KEY]).toBe("no usable registry version for HARNESS.DOC");
  });
});

describe("서버 본문과 패키지 기본값이 같은 채움 경로를 쓴다", () => {
  const values = { projectName: "Billing", projectUuid: "p-1", endpoint: ENDPOINT };

  it("서버 본문이 있으면 그것을 채운다", () => {
    const rendered = renderHarnessDoc(values, "Project: {{projectName}} ({{projectUuid}}) at {{endpoint}}");
    expect(rendered).toBe("Project: Billing (p-1) at https://ai-erd.com/mcp");
  });

  it("없으면 패키지 기본값을 «같은 방식으로» 채운다", () => {
    const rendered = renderHarnessDoc(values);
    expect(rendered).toContain("**Billing**");
    expect(rendered).toContain("p-1");
    expect(rendered).not.toContain("{{projectName}}");
  });

  it("AGENTS.md 블록도 마찬가지다", () => {
    expect(renderAgentNote("see {{harnessDocPath}} on {{serverName}}"))
      .toBe("see .ai-erd/HARNESS.md on ai-erd");
    expect(renderAgentNote()).not.toContain("{{harnessDocPath}}");
  });
});
