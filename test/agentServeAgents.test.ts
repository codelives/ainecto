import { readFileSync } from "node:fs";
import { codexSpawned, finish, logRecords, spawned, startServe, until, type World } from "./support/agentServeWorld";

const C = "c".repeat(32);
const D = "d".repeat(32);
const BOARD = "e".repeat(32);
const CARD = "f".repeat(32);

/** 모든 요청 줄에 같은 짝의 응답 줄이 있다(요청 1줄 + 응답 1줄). */
function expectPairedLines(w: World): void {
  const records = logRecords(w);
  const rpc = records.filter((r) => r.event === "agent_rpc").map((r) => `${r.pid}:${r.id}`);
  const rpcDone = records.filter((r) => r.event === "agent_rpc_response").map((r) => `${r.pid}:${r.id}`);
  expect(rpcDone.sort()).toEqual(rpc.sort());
  const turns = records.filter((r) => r.event === "agent_request").map((r) => r.turnUuid);
  expect(records.filter((r) => r.event === "agent_response").map((r) => r.turnUuid)).toEqual(turns);
}

describe("ainecto agent serve — Claude Code · Codex 를 offer.agent 로 고른다", () => {
  it("open 에 설치된 Agent 를 싣고, agent 가 없는 요청은 Claude Code · codex 는 Codex 로 간다", async () => {
    const w = startServe({ installed: ["claude-code", "codex"] });
    w.server.offer("t1", "conv-a", "hello");
    const claude = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "hello", undefined, "codex");
    const codex = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(w.server.calls[0]).toEqual({ op: "open", body: { hostName: "test-host", cliVersion: "0.0.0",
      agents: [{ id: "claude-code", ready: true }, { id: "codex", ready: true }], features: ["stop"] } });
    expect(String(claude.reply)).toMatch(/^got hello #1 in sess-/);
    expect(codex).toMatchObject({ status: "DONE", documentUuids: [] });
    expect(String(codex.reply)).toMatch(/^got hello #1 in thr-\d+$/);
    expect(codexSpawned(w)).toEqual([["app-server"]]);
    const records = logRecords(w);
    expect(records.filter((r) => r.event === "agent_request").map((r) => r.agent)).toEqual(["claude-code", "codex"]);
    expect(records.filter((r) => r.event === "agent_rpc").map((r) => r.method))
      .toEqual(["initialize", "config/read", "thread/start", "turn/start"]);
    expectPairedLines(w);
  });

  it("Codex: 사용자 설정의 다른 MCP 서버는 끄고 AiNecto 만 띄운다(thread/start·resume 모두) · 끈 이름을 남긴다", async () => {
    const w = startServe({ installed: ["codex"] });
    w.server.offer("t1", "conv-a", "one", undefined, "codex");
    await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-b", "two", undefined, "codex");
    await until(() => w.server.replies()[1]);
    w.server.offer("t3", "conv-a", "three", undefined, "codex");
    await until(() => w.server.replies()[2]);
    await finish(w);

    const records = logRecords(w);
    expect(records.filter((r) => r.event === "agent_mcp_server").map((r) => r.name)).toEqual(["ainecto", "ainecto", "ainecto"]);
    expect(records.filter((r) => r.event === "agent_mcp_servers_off").map((r) => r.names))
      .toEqual([["node_repl", "openaiDeveloperDocs"], ["node_repl", "openaiDeveloperDocs"], ["node_repl", "openaiDeveloperDocs"]]);
    expectPairedLines(w);
  });

  it("구독 로그인(init apiKeySource none)으로 돌아도 멈추지 않고 답한다 — 출처 이름은 남긴다(운영도 구독 허용, 11-14)", async () => {
    const w = startServe({ installed: ["claude-code"] });
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(reply).toMatchObject({ status: "DONE" });
    expect(logRecords(w).find((r) => r.event === "agent_auth_source")).toMatchObject({ agent: "claude-code", apiKeySource: "none" });
    expectPairedLines(w);
  });

  it("키 변수가 있어 API 키로 돌면 그대로 답한다", async () => {
    const w = startServe({ installed: ["claude-code"], env: { ANTHROPIC_API_KEY: "test-placeholder-not-a-key" } });
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(reply).toMatchObject({ status: "DONE" });
    // 실제로 무엇으로 돌았는지는 차례마다 init 의 출처 이름으로 남긴다(키 값은 남기지 않는다).
    expect(logRecords(w).find((r) => r.event === "agent_auth_source")).toMatchObject({ agent: "claude-code", apiKeySource: "ANTHROPIC_API_KEY" });
    expect(readFileSync(w.logPath, "utf8")).not.toContain("test-placeholder-not-a-key");
  });

  it("같은 대화에서 두 Agent 를 번갈아도 각자 세션이 살아 있다(프로세스 하나씩 · 후속은 같은 세션)", async () => {
    const w = startServe({ installed: ["claude-code", "codex"] });
    w.server.offer("t1", "conv-a", "one", undefined, "codex");
    await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "two");
    await until(() => w.server.replies()[1]);
    w.server.offer("t3", "conv-a", "three", undefined, "codex");
    const third = await until(() => w.server.replies()[2]);
    w.server.offer("t4", "conv-a", "four");
    const fourth = await until(() => w.server.replies()[3]);
    await finish(w);

    expect(String(third.reply)).toMatch(/^got three #2 in thr-/);
    expect(String(fourth.reply)).toMatch(/^got four #2 in sess-/);
    expect(codexSpawned(w)).toHaveLength(1);
    expect(spawned(w)).toHaveLength(1);
  });

  it("Codex 대화가 바뀌면 앞 app-server 를 내리고, 돌아오면 그 대화의 thread 로 thread/resume", async () => {
    const w = startServe({ installed: ["codex"] });
    w.server.offer("t1", "conv-a", "one", undefined, "codex");
    const first = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-b", "two", undefined, "codex");
    await until(() => w.server.replies()[1]);
    w.server.offer("t3", "conv-a", "three", undefined, "codex");
    const third = await until(() => w.server.replies()[2]);
    await finish(w);

    const threadA = /in (thr-\d+)$/.exec(String(first.reply))?.[1];
    expect(threadA).toBeDefined();
    expect(String(third.reply)).toBe(`got three #1 in ${threadA}`);
    expect(codexSpawned(w)).toHaveLength(3);
    const file = JSON.parse(readFileSync(w.sessionsPath, "utf8"));
    expect(file.byAgent.codex["conv-a"].sessionId).toBe(threadA);
    expect(file.conversations).toEqual({});
    expect(logRecords(w).filter((r) => r.event === "agent_rpc").map((r) => r.method)).toContain("thread/resume");
    expectPairedLines(w);
  });

  for (const agent of ["claude-code", "codex"] as const) {
    it(`${agent}: 쓰기 도구 결과에서 문서·새 문서·카드를 싣는다(읽기 도구·다른 MCP 서버는 뺀다)`, async () => {
      const w = startServe({ installed: [agent] });
      w.server.offer("t1", "conv-a", "write-card", undefined, agent);
      const reply = await until(() => w.server.replies()[0]);
      await finish(w);

      expect(reply).toMatchObject({ status: "DONE", documentUuids: [C, D, BOARD], createdDocumentUuids: [C], cardUuids: [CARD] });
      expect(logRecords(w).find((r) => r.event === "agent_response")).toMatchObject({ documents: 3, createdDocuments: 1, cards: 1 });
    });
  }

  it("Codex 가 승인을 물어 오면 묻지 않고 거절하고 남긴다", async () => {
    const w = startServe({ installed: ["codex"] });
    w.server.offer("t1", "conv-a", "approval", undefined, "codex");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);

    expect(reply.status).toBe("DONE");
    expect(String(reply.reply)).toBe('answer {"action":"decline"}');
    expect(logRecords(w).find((r) => r.event === "agent_server_request"))
      .toMatchObject({ agent: "codex", method: "mcpServer/elicitation/request", answer: '{"action":"decline"}' });
  });

  it("Codex: 답 글이 schema JSON 이 아니면 SCHEMA_VIOLATION · turn 실패는 AGENT_ERROR(Codex 이름으로)", async () => {
    const w = startServe({ installed: ["codex"] });
    w.server.offer("t1", "conv-a", "bad-schema", undefined, "codex");
    const bad = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "fail", undefined, "codex");
    const failed = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(bad).toMatchObject({ status: "FAILED", errorCode: "SCHEMA_VIOLATION" });
    expect(String(bad.reply)).toContain("not json at all");
    expect(failed).toMatchObject({ status: "FAILED", errorCode: "AGENT_ERROR" });
    expect(String(failed.reply)).toBe("Codex 가 실패했어요(failed).\nmodel said no");
  });

  it("Codex 기한(B3)을 넘기면 turn/interrupt 뒤 내리고 FAILED TURN_TIMEOUT · 다음 요청은 새 app-server", async () => {
    const w = startServe({ installed: ["codex"], turnTimeoutMs: 300 });
    w.server.offer("t1", "conv-a", "hang", undefined, "codex");
    const timedOut = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "after", undefined, "codex");
    const after = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(timedOut).toMatchObject({ status: "FAILED", errorCode: "TURN_TIMEOUT" });
    expect(after.status).toBe("DONE");
    expect(codexSpawned(w)).toHaveLength(2);
    const interrupt = logRecords(w).find((r) => r.event === "agent_rpc_response" && r.method === "turn/interrupt");
    expect(interrupt).toMatchObject({ ok: true });
    expectPairedLines(w);
  });

  it("Codex «중단» — turn/interrupt 로 그 차례만 멈추고 STOPPED · 같은 app-server 로 다음 요청을 잇는다", async () => {
    const w = startServe({ installed: ["codex"] });
    w.server.offer("t1", "conv-a", "hang", undefined, "codex");
    await until(() => logRecords(w).find((r) => r.event === "agent_rpc" && r.method === "turn/start"));
    await new Promise((r) => setTimeout(r, 100));
    w.server.push({ state: "OPEN", offers: [], stops: ["t1"] });
    const stopped = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "after", undefined, "codex");
    const after = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(stopped).toMatchObject({ turnUuid: "t1", status: "STOPPED" });
    expect(after.status).toBe("DONE");
    expect(codexSpawned(w)).toHaveLength(1);
    expect(logRecords(w).find((r) => r.event === "agent_rpc_response" && r.method === "turn/interrupt")).toMatchObject({ ok: true });
    expectPairedLines(w);
  });

  it("Codex 재개가 실패하면(없는 thread) AGENT_EXITED 로 답하고 그 값을 버린다 — 다음 요청은 새 thread", async () => {
    const w = startServe({ installed: ["codex"], sessionsFile: { version: 2, conversations: {},
      byAgent: { codex: { "conv-x": { sessionId: "thr-gone", updatedAt: "2026-11-13T00:00:00Z" } } } } });
    w.server.offer("t1", "conv-x", "hello", undefined, "codex");
    const gone = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-x", "again", undefined, "codex");
    const again = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(gone).toMatchObject({ status: "FAILED", errorCode: "AGENT_EXITED" });
    expect(String(gone.reply)).toContain("thread not found: thr-gone");
    expect(again.status).toBe("DONE");
    expect(String(again.reply)).toMatch(/^got again #1 in thr-\d+$/);
    expect(JSON.parse(readFileSync(w.sessionsPath, "utf8")).byAgent.codex["conv-x"].sessionId).not.toBe("thr-gone");
    expectPairedLines(w);
  });

  it("이 PC 에 없는 Agent(설치 안 됨 · 모르는 id)로 온 요청은 FAILED AGENT_NOT_INSTALLED — 요청·응답 줄은 남는다", async () => {
    const w = startServe({ installed: ["claude-code"] });
    w.server.offer("t1", "conv-a", "hello", undefined, "codex");
    const missing = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "hello", undefined, "gemini");
    const unknown = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(missing).toMatchObject({ status: "FAILED", errorCode: "AGENT_NOT_INSTALLED", documentUuids: [] });
    expect(unknown).toMatchObject({ status: "FAILED", errorCode: "AGENT_NOT_INSTALLED" });
    expect(spawned(w)).toHaveLength(0);
    expectPairedLines(w);
  });
});
