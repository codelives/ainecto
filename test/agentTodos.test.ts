import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_MCP_CLIENT_NAMES, ainectoBridge } from "../src/core/agent/agents";
import type { AgentLogRecord } from "../src/core/agent/log";
import { answerComments, renewDelayMs, todosIn } from "../src/core/agent/todoRun";
import { folderKind, identitiesIn, openAgentsBody } from "../src/core/agent/serve";
import { AgentToolError, createAgentTools, toolsAs } from "../src/core/agent/tools";
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
    expect(seen).toEqual(["list_agent_todos"]);
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

  it("★as = 그 신원으로 부른다 — 신원(종류·이름)마다 클라이언트 하나(이름·종류 헤더) · 요청 줄에 agent·agentName", async () => {
    const used: string[] = [];
    const path = join(mkdtempSync(join(tmpdir(), "agent-tools-")), "agent.log");
    const log = new DaemonLog<AgentLogRecord>(path, `${path}.1`);
    const client = (label: string) => ({ toolsCall: async () => { used.push(label); return { content: [{ type: "text", text: "{}" }] }; },
      toolsList: async () => [] });
    const made: string[] = [];
    const tools = createAgentTools({ client: client("serve"),
      clientAs: (id) => { made.push(`${id.agent}/${id.name}`); return client(id.name); }, log });
    const codex = { agent: "codex", name: "codex" } as const;
    await tools.call("send_auto_run_message", {}, { as: codex });
    await toolsAs(tools, codex).call("kanban_card_action", {});
    await tools.call("list_agent_todos", {}, { as: { agent: "claude-code", name: "tester" } });
    await tools.call("list_agent_todos", {});
    expect(used).toEqual(["codex", "codex", "tester", "serve"]);
    expect(made).toEqual(["codex/codex", "claude-code/tester"]);   // 신원마다 하나
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.event === "agent_call").map((l) => [l.agent, l.agentName]))
      .toEqual([["codex", "codex"], ["codex", "codex"], ["claude-code", "tester"], [undefined, undefined]]);
  });

  it("Agent 종류 헤더 값 = 서버 AgentTypeResolver 표의 이름", () => {
    expect(AGENT_MCP_CLIENT_NAMES).toEqual({ "claude-code": "claude-code", codex: "codex-mcp-client" });
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

describe("link 열기의 종류별 신원(계약 5-1)", () => {
  const agents = [{ id: "claude-code", ready: true, auth: "subscription" }, { id: "codex", ready: true }] as const;

  it("폴더 이름은 할 일을 돌리는 한 종류에만 — 준비된 기본 Agent, 없으면 처음 준비된 것", () => {
    expect(openAgentsBody(agents, "tester")).toEqual([
      { id: "claude-code", ready: true, auth: "subscription", name: "tester" }, { id: "codex", ready: true }]);
    expect(openAgentsBody(agents, undefined)).toEqual([{ id: "claude-code", ready: true, auth: "subscription" }, { id: "codex", ready: true }]);
    expect(folderKind([{ id: "claude-code", ready: false }, { id: "codex", ready: true }])).toBe("codex");
    expect(folderKind([{ id: "claude-code", ready: false }])).toBeUndefined();
  });

  it("응답 agents[] → 신원(agentUuid·name 이 있고 이 PC 에 어댑터가 있는 것) · null 신원은 건너뛰고 이유(AGENT_LIMIT)만", () => {
    const adapters = new Map([["claude-code", {}], ["codex", {}]] as const);
    expect(identitiesIn([
      { id: "claude-code", kindLabel: "Claude Code", ready: true, agentUuid: "u-claude", name: "tester", error: null },
      { id: "codex", kindLabel: "Codex", ready: true, agentUuid: null, name: null, error: "AGENT_LIMIT" },
      { id: "antigravity", ready: true, agentUuid: "u-x", name: "x" },
    ], adapters)).toEqual({ identities: [{ agent: "claude-code", agentUuid: "u-claude", name: "tester" }],
      refused: [{ agent: "codex", error: "AGENT_LIMIT" }] });
    expect(identitiesIn([{ id: "codex", ready: false, agentUuid: null, name: null, error: null }], adapters))
      .toEqual({ identities: [], refused: [] });
    expect(identitiesIn(undefined, adapters)).toEqual({ identities: [], refused: [] });   // 옛 서버
    expect(identitiesIn([{ id: "codex", agentUuid: "u-codex", name: "codex" }], new Map([["claude-code", {}]] as const)))
      .toEqual({ identities: [], refused: [] });   // 이 PC 에 없는 종류
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
