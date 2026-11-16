import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ainectoBridge } from "../src/core/agent/agents";
import type { AgentLogRecord } from "../src/core/agent/log";
import { answerComments, renewDelayMs, todosIn } from "../src/core/agent/todoRun";
import { AgentToolError, createAgentTools } from "../src/core/agent/tools";
import { McpRpcError } from "../src/core/mcp/rpcClient";
import { DaemonLog } from "../src/core/term/daemonLog";

function toolsWith(toolsCall: (name: string, args: unknown) => Promise<unknown>) {
  const path = join(mkdtempSync(join(tmpdir(), "agent-tools-")), "agent.log");
  const log = new DaemonLog<AgentLogRecord>(path, `${path}.1`);
  const tools = createAgentTools({ client: { toolsCall, toolsList: async () => [{ name: "x" }] }, log });
  const lines = () => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { tools, lines };
}

describe("serve 의 서버 MCP 도구 입구(tools.ts)", () => {
  it("★호출마다 요청 1줄 + 응답 1줄(같은 callId) · 앞머리 붙인 서버 도구 이름 · 결과 JSON 객체", async () => {
    const seen: string[] = [];
    const { tools, lines } = toolsWith(async (name) => {
      seen.push(name);
      return { content: [{ type: "text", text: '{"items":[],"hasMore":false}' }] };
    });
    expect(await tools.call("list_agent_todos", { agent: "me" })).toEqual({ items: [], hasMore: false });
    expect(seen).toEqual(["mcp__ainecto__list_agent_todos"]);
    const [request, response] = lines();
    expect(request).toMatchObject({ event: "agent_call", op: "tool", tool: "list_agent_todos", bytes: 14 });
    expect(response).toMatchObject({ event: "agent_call_response", op: "tool", tool: "list_agent_todos", ok: true, callId: request?.callId });
  });

  it("★서버 거절(JSON-RPC data.code)은 코드를 살려 던지고 응답 줄에도 남긴다 · 네트워크 실패는 다시 해 볼 만하다", async () => {
    const refused = toolsWith(async () => {
      throw new McpRpcError("CLAIMED_BY_OTHER: taken", "MCP_ERROR", { code: 409, message: "taken", data: { code: "CARD_CHANGED" } });
    });
    const error = await refused.tools.call("kanban_card_action", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentToolError);
    expect(error).toMatchObject({ tool: "kanban_card_action", code: "CARD_CHANGED", retryable: false });
    expect(refused.lines()[1]).toMatchObject({ event: "agent_call_response", ok: false, code: "CARD_CHANGED", error: "CLAIMED_BY_OTHER: taken" });

    const offline = toolsWith(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await offline.tools.call("list_agent_todos", {}).catch((e: unknown) => e)).toMatchObject({ retryable: true, message: "fetch failed" });
    expect(offline.lines()[1]).toMatchObject({ ok: false, error: "fetch failed" });

    const isError = toolsWith(async () => ({ isError: true, content: [{ type: "text", text: "nope" }] }));
    expect(await isError.tools.call("start_work", {}).catch((e: unknown) => e)).toMatchObject({ tool: "start_work", message: "nope" });
  });

  it("도구 목록도 같은 입구", async () => {
    const { tools, lines } = toolsWith(async () => ({}));
    expect(await tools.list()).toEqual([{ name: "x" }]);
    expect(lines().map((l) => [l.event, l.tool, l.ok])).toEqual([["agent_call", "tools/list", undefined], ["agent_call_response", "tools/list", true]]);
  });
});

describe("할 일 순수 함수(todoRun.ts)", () => {
  it("todosIn — 카드를 가리키는 두 종류만 · 다음 장은 마지막 todoId", () => {
    const page = todosIn({
      items: [
        { todoId: "a", kind: "CARD_ASSIGNED", target: { type: "KANBAN_CARD", uuid: "card-1" } },
        { todoId: "b", kind: "QUESTION_MENTION", target: { type: "DOCUMENT", uuid: "doc-1" } },
        { todoId: "c", kind: "DECISION_ANSWERED", target: { type: "KANBAN_CARD", uuid: "card-2", commentId: 7 } },
      ],
      hasMore: true,
    });
    expect(page).toEqual({ items: [{ todoId: "a", kind: "CARD_ASSIGNED", cardUuid: "card-1" },
      { todoId: "c", kind: "DECISION_ANSWERED", cardUuid: "card-2", commentId: 7 }], next: "c" });
    expect(todosIn({ items: [], hasMore: false })).toEqual({ items: [] });
  });

  it("renewDelayMs — 서버가 준 만료까지 남은 시간의 절반 · 못 읽으면 연장하지 않는다", () => {
    const now = Date.parse("2026-11-16T00:00:00Z");
    expect(renewDelayMs("2026-11-16T00:30:00Z", now)).toBe(15 * 60_000);
    expect(renewDelayMs("2026-11-15T23:59:00Z", now)).toBe(0);
    expect(renewDelayMs(undefined, now)).toBeUndefined();
    expect(renewDelayMs("not a date", now)).toBeUndefined();
  });

  it("answerComments — 가리킨 댓글의 스레드 + 해결 안 된 질문 스레드, 오래된 순", () => {
    const listed = { comments: [
      { id: 1, kind: "QUESTION", body: "끝난 질문", questionState: "RESOLVED", author: { displayName: "a" } },
      { id: 2, kind: "COMMENT", body: "수정 의견", author: { displayName: "주인" } },
      { id: 3, kind: "COMMENT", parentCommentId: 2, rootCommentId: 2, body: "보충", author: { displayName: "주인" } },
      { id: 4, kind: "QUESTION", body: "열린 질문", questionState: "UNANSWERED", author: { displayName: "agent" } },
      { id: 5, kind: "COMMENT", body: "무관", author: { displayName: "남" } },
    ] };
    expect(answerComments(listed, 3).map((c) => c.id)).toEqual([2, 3, 4]);
    expect(answerComments(listed, undefined).map((c) => c.id)).toEqual([4]);
  });
});

describe("Agent 브리지 — serve 의 에이전트 이름", () => {
  it("이름이 있으면 --agent 로 실어 Agent 의 도구 호출도 같은 이름의 연결 · 없으면 그대로", () => {
    expect(ainectoBridge("/n", "/c.js", "https://dev.ainecto.com/mcp", "pc-agent").args)
      .toEqual(["/c.js", "--endpoint", "https://dev.ainecto.com/mcp", "mcp", "--agent", "pc-agent"]);
    expect(ainectoBridge("/n", "/c.js", "https://dev.ainecto.com/mcp").args)
      .toEqual(["/c.js", "--endpoint", "https://dev.ainecto.com/mcp", "mcp"]);
  });
});
