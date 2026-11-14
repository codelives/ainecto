import { readFileSync } from "node:fs";
import { AgentCallError } from "../src/core/agent/http";
import { finish, logRecords, spawned, startServe, until } from "./support/agentServeWorld";

const DOC_A = "a".repeat(32);
const DOC_B = "b".repeat(32);

describe("ainecto agent serve", () => {
  it("★K4 — 서버가 같은 요청을 다시 줘도 Claude 에는 한 번만 넣고 답도 한 번", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "hello");
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    w.server.offer("t1", "conv-a", "hello");
    w.server.offer("t2", "conv-a", "next");
    const second = await until(() => w.server.replies()[1]);
    const result = await finish(w);

    expect(reply).toMatchObject({ turnUuid: "t1", conversationUuid: "conv-a", status: "DONE", documentUuids: [] });
    expect(String(reply.reply)).toMatch(/^got hello #1 in sess-/);
    expect(String(second.reply)).toMatch(/^got next #2 in sess-/);   // 같은 프로세스의 두 번째 줄
    expect(w.server.replies()).toHaveLength(2);
    expect(spawned(w)).toHaveLength(1);
    const records = logRecords(w);
    expect(records.filter((r) => r.event === "offer" && r.duplicate === true)).toHaveLength(2);
    expect(records.filter((r) => r.event === "agent_request").map((r) => r.turnUuid)).toEqual(["t1", "t2"]);
    expect(records.filter((r) => r.event === "agent_response").map((r) => r.turnUuid)).toEqual(["t1", "t2"]);
    expect(result).toEqual({ exitCode: 0, reason: "signal" });
    expect(w.server.calls.at(-1)?.op).toBe("close");
  });

  it("★서버가 준 맥락(대화의 프로젝트·열린 문서)을 Claude stdin 한 줄 앞머리로 넣는다", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "이 프로젝트에 문서 만들어", {
      project: { uuid: "p-1", name: "MCP 완주 테스트", workspaceUuid: "w-1", workspaceName: "라이언" },
      openDocument: { uuid: "d".repeat(32), title: "원고", type: "markdown" },
    });
    const reply = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "맥락 없음");
    const plain = await until(() => w.server.replies()[1]);
    await finish(w);
    // 가짜 claude 는 stdin 한 줄을 그대로 «got <글>» 로 돌려준다.
    expect(String(reply.reply)).toContain('got [AiNecto context — "this project" / "this document" mean these] project «MCP 완주 테스트» (projectUuid p-1, workspace «라이언» w-1) · open document «원고» (documentUuid ' + "d".repeat(32) + ", markdown)\n\n이 프로젝트에 문서 만들어 #1");
    expect(String(plain.reply)).toMatch(/^got 맥락 없음 #2/);
  });

  it("대화가 바뀌면 앞 프로세스를 내리고, 돌아오면 그 대화의 세션으로 --resume", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "one");
    const first = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-b", "two");
    await until(() => w.server.replies()[1]);
    w.server.offer("t3", "conv-a", "three");
    const third = await until(() => w.server.replies()[2]);
    await finish(w);

    const sessionA = /in (sess-\d+)$/.exec(String(first.reply))?.[1];
    expect(sessionA).toBeDefined();
    expect(spawned(w)).toEqual([[], [], ["--resume", sessionA]]);
    expect(String(third.reply)).toBe(`got three #1 in ${sessionA}`);
    expect(JSON.parse(readFileSync(w.sessionsPath, "utf8")).conversations["conv-a"].sessionId).toBe(sessionA);
    const exits = logRecords(w).filter((r) => r.event === "process_exit");
    expect(exits.length).toBeGreaterThanOrEqual(2);
  });

  it("문서는 쓰기 도구 결과에서만 · schema 를 어긴 답은 FAILED", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "write-doc");
    const doc = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "bad-schema");
    const bad = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(doc.documentUuids).toEqual([DOC_B]);
    expect(doc.documentUuids).not.toContain(DOC_A);
    expect(bad).toMatchObject({ status: "FAILED", errorCode: "SCHEMA_VIOLATION" });
    expect(String(bad.reply)).toContain('"documents"');
  });

  it("기한(B3)을 넘기면 그 프로세스를 내리고 FAILED TURN_TIMEOUT · 다음 요청은 새 프로세스", async () => {
    const w = startServe({ turnTimeoutMs: 300 });
    w.server.offer("t1", "conv-a", "hang");
    const timedOut = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-a", "after");
    const after = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(timedOut).toMatchObject({ status: "FAILED", errorCode: "TURN_TIMEOUT" });
    expect(after.status).toBe("DONE");
    expect(spawned(w)).toHaveLength(2);
    expect(logRecords(w).find((r) => r.event === "agent_response" && r.turnUuid === "t1")?.outcome).toBe("timeout");
  });

  it("프로세스가 죽으면 FAILED AGENT_EXITED — 응답 줄은 남는다", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "crash");
    const crashed = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(crashed).toMatchObject({ status: "FAILED", errorCode: "AGENT_EXITED" });
    expect(logRecords(w).find((r) => r.event === "agent_response")?.outcome).toBe("exited");
  });

  it("서버가 link 를 모르면(재시작) 다시 하지 않고 끝낸다 · 다른 PC 가 오면 끝낸다", async () => {
    const lost = startServe();
    lost.server.push(new AgentCallError("No such agent link.", "poll", 404, "LINK_NOT_FOUND"));
    expect(await lost.done).toEqual({ exitCode: 1, reason: "link_not_found" });
    expect(lost.server.calls.filter((c) => c.op === "close")).toHaveLength(0);

    const replaced = startServe();
    replaced.server.push({ state: "CLOSED", reason: "REPLACED" });
    expect(await replaced.done).toEqual({ exitCode: 1, reason: "replaced" });
  });

  it("네트워크 실패는 B2 간격으로 다시 한다", async () => {
    const w = startServe();
    w.server.push(new AgentCallError("poll failed: ECONNRESET", "poll"));
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(reply.status).toBe("DONE");
  });

  it("★웹 «중단» — poll 의 stops 가 진행 중 차례를 멈추고 STOPPED(그때까지 만든 문서) · 같은 세션으로 다음 요청을 잇는다", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "write-then-hang");
    await until(() => logRecords(w).find((r) => r.event === "agent_request" && r.turnUuid === "t1"));
    await new Promise((r) => setTimeout(r, 100));
    w.server.push({ state: "OPEN", offers: [], stops: ["t1"] });
    const stopped = await until(() => w.server.replies()[0]);
    w.server.push({ state: "OPEN", offers: [], stops: ["t1"] });   // 답이 갈 때까지 서버가 다시 실어도 한 번만
    w.server.offer("t2", "conv-a", "next");
    const next = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(stopped).toMatchObject({ turnUuid: "t1", status: "STOPPED", documentUuids: ["c".repeat(32)], createdDocumentUuids: ["c".repeat(32)] });
    expect(stopped.errorCode).toBeUndefined();
    const sessionId = /in (sess-\d+)$/.exec(String(next.reply))?.[1];
    expect(String(next.reply)).toBe(`got next #2 in ${sessionId}`);   // 같은 프로세스·같은 세션의 두 번째 줄
    expect(spawned(w)).toHaveLength(1);
    expect(JSON.parse(readFileSync(w.sessionsPath, "utf8")).conversations["conv-a"].sessionId).toBe(sessionId);
    expect(w.server.replies()).toHaveLength(2);
    const stops = logRecords(w).filter((r) => r.event === "stop_request");
    expect(stops).toEqual([expect.objectContaining({ turnUuid: "t1", running: true })]);
    expect(logRecords(w).find((r) => r.event === "agent_response" && r.turnUuid === "t1")?.status).toBe("STOPPED");
  });

  it("시작 전에 멈춘 차례는 Agent 에 넣지 않고 STOPPED", async () => {
    const w = startServe();
    w.server.push({ state: "OPEN", offers: [{ turnUuid: "t1", conversationUuid: "conv-a", text: "hang" }], stops: ["t1"] });
    const stopped = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(stopped).toMatchObject({ turnUuid: "t1", status: "STOPPED", documentUuids: [] });
  });

  it("open 에 features(stop)를 알린다 · 옛 서버가 400 INVALID 로 거절하면 features 없이 다시 연다", async () => {
    const w = startServe();
    await until(() => w.server.calls.find((c) => c.op === "poll"));
    await finish(w);
    expect(w.server.calls[0]).toMatchObject({ op: "open", body: { features: ["stop"] } });

    const old = startServe({ oldServer: true });
    old.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => old.server.replies()[0]);
    await finish(old);
    const opens = old.server.calls.filter((c) => c.op === "open");
    expect(opens).toHaveLength(2);
    expect(opens[1]?.body.features).toBeUndefined();
    expect(reply.status).toBe("DONE");
    expect(logRecords(old).some((r) => r.event === "open_without_features")).toBe(true);
  });
});
