import { readFileSync } from "node:fs";
import { AgentCallError } from "../src/core/agent/http";
import { codexSpawned, finish, logRecords, spawned, startServe, until } from "./support/agentServeWorld";
import { FakeTools } from "./support/fakeTools";

const CARD = "c".repeat(32);
const CARD_B = "d".repeat(32);

/** 도구 이름만 — 순서 대조용. */
const named = (tools: FakeTools, name: string) => tools.calls.filter((c) => c.tool === name);

describe("ainecto agent serve — 에이전트 할 일(자동 실행 카드, KAN-1113)", () => {
  it("★배정된 카드: claim → accept → start → 실행 대화 시작 글 → Chat 과 같은 실행기 한 차례(이름 붙은 브리지) → 답 글 → 결과 검토 요청 댓글 → CHECKPOINT", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, key: "KAN-7", title: "로그인 고치기", description: "로그인 버튼이 안 눌린다" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools, agentName: "pc-agent" } });
    await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    await finish(w);

    expect(tools.tools()).toEqual([
      "list_agent_todos", "update_agent_todos", "kanban_list_cards", "kanban_card_action", "kanban_card_action",
      "send_auto_run_message", "send_auto_run_message", "kanban_list_cards", "create_comments", "report_work_progress",
      ...tools.tools().slice(10),
    ]);
    expect(tools.calls[0]?.args).toEqual({ state: ["OPEN"], kinds: ["CARD_ASSIGNED", "DECISION_ANSWERED"], agent: "u-claude-code" });
    expect(tools.calls[1]?.args).toEqual({ items: [{ todoId: "todo-1", action: "claim" }] });
    // ★request_review 는 부르지 않는다 — 승인은 주인이 웹에서(서버가 검토 요청을 대신 한다).
    expect(named(tools, "kanban_card_action").map((c) => c.args.action)).toEqual(["accept", "start"]);
    expect(named(tools, "start_work")).toHaveLength(0);   // start 결과의 card.work.workId 를 쓴다
    const [opening, answer] = named(tools, "send_auto_run_message");
    expect(opening?.args).toEqual({ cardUuid: CARD, workId: "work-1", body: "«로그인 고치기» 작업을 시작했어요." });
    // ★모든 호출(목록·임대·수락·글·결과 댓글)이 그 종류의 신원으로 — 이름(X-AiNecto-Agent-Name) + 종류(X-AiNecto-Agent).
    expect(tools.calls.every((c) => c.as?.agent === "claude-code" && c.as.name === "pc-agent")).toBe(true);
    // 폴더 이름은 할 일을 돌리는 한 종류에만 실려 open 에 간다(계약 5-1).
    expect(w.server.calls[0]?.body.agents).toEqual([{ id: "claude-code", ready: true, name: "pc-agent" }]);
    // 가짜 claude 는 받은 글을 «got <글>» 로 돌려준다 — 지시문에 카드·workId·판단 요청 순서(주인 userId)가 들어갔다.
    const body = String(answer?.args.body);
    expect(body).toMatch(/^got \[AiNecto auto-run\] /);
    expect(body).toContain(`Card «로그인 고치기» (KAN-7, cardUuid ${CARD}, boardUuid board-1) · status IN_PROGRESS`);
    expect(body).toContain("workId work-1");
    expect(body).toContain("Description:\n로그인 버튼이 안 눌린다");
    expect(body).toContain("- [ ] 끝나면 검토 요청");
    expect(body).toContain(`2) kanban_card_action {cardUuid: "${CARD}", action: "block", reason: <one line>, responderIds: ["user-owner"]}`);
    expect(named(tools, "create_comments")[0]?.args).toEqual({ cardUuid: CARD, workId: "work-1",
      items: [{ kind: "COMMENT", body, resultReview: true }] });
    expect(named(tools, "report_work_progress")[0]?.args).toEqual({ workId: "work-1", status: "CHECKPOINT" });
    // 카드 배정 할 일은 accept 가 닫았다 — complete 를 보내지 않는다.
    expect(named(tools, "update_agent_todos").map((c) => (c.args.items as Array<{ action: string }>)[0]?.action)).toEqual(["claim"]);
    expect(spawned(w)).toEqual([["--agent", "pc-agent"]]);   // 할 일 차례 = 이 serve 의 이름 붙은 브리지
    // 다 돌았다 — runs.json 에 남지 않는다(다시 켜도 잇지 않는다).
    expect(JSON.parse(readFileSync(w.runsPath, "utf8"))).toEqual({ version: 1, runs: [] });
    const records = logRecords(w);
    expect(records.find((r) => r.event === "runs_load")).toEqual({ event: "runs_load", entries: 0, reason: "missing", ts: expect.anything() });
    expect(records.find((r) => r.event === "agent_request" && r.todoId === "todo-1")).toMatchObject({ conversationUuid: `conv-${CARD}` });
    expect(records.filter((r) => r.event === "todo_run").map((r) => r.todoId)).toEqual(["todo-1"]);
    expect(records.find((r) => r.event === "todo_run_result")).toMatchObject({ todoId: "todo-1", outcome: "review_requested",
      workId: "work-1", conversationUuid: `conv-${CARD}` });
    expect(w.printed).toContain("Auto-run cards handed to Claude Code (pc-agent) run here.");
  });

  it("★판단 요청으로 막히면 검토 요청 없이 기다린다 · 답(DECISION_ANSWERED)이 오면 같은 대화·같은 세션·같은 workId 로 답 댓글을 넣어 잇고 complete", async () => {
    const tools = new FakeTools();
    const card = tools.addCard({ uuid: CARD, title: "결정 필요", blockedAfterTurn: true });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools, agentName: "pc-agent" }, pollHoldSeconds: 0.05 });
    await until(() => logRecords(w).find((r) => r.event === "todo_run_result" && r.todoId === "todo-1"));
    expect(named(tools, "create_comments")).toHaveLength(0);
    expect(card.status).toBe("IN_PROGRESS");

    // 사람이 답했다 — 알림 쪽이 «판단에 답함» 할 일을 연다.
    card.blockedAfterTurn = false;
    tools.comments.set(CARD, [
      { id: 10, kind: "QUESTION", body: "A 와 B 중 어느 쪽?", questionState: "ANSWERED", author: { displayName: "에이전트" } },
      { id: 11, kind: "COMMENT", parentCommentId: 10, rootCommentId: 10, body: "B 로 해 주세요", author: { displayName: "주인" } },
      { id: 12, kind: "COMMENT", body: "상관없는 댓글", author: { displayName: "남" } },
    ]);
    tools.addTodo("todo-2", "DECISION_ANSWERED", CARD, 11);
    await until(() => tools.todo("todo-2")?.state === "DONE" ? true : undefined);
    await finish(w);

    const records = logRecords(w);
    expect(records.filter((r) => r.event === "todo_run_result").map((r) => r.outcome)).toEqual(["decision_requested", "review_requested"]);
    const second = String(named(tools, "send_auto_run_message").filter((c) => String(c.args.body).startsWith("got "))[1]?.args.body);
    expect(second).toMatch(/^got \[AiNecto auto-run — continue\] /);
    expect(second).toContain("- #10 QUESTION (ANSWERED) by 에이전트: A 와 B 중 어느 쪽?\n- #11 COMMENT by 주인: B 로 해 주세요");
    expect(second).not.toContain("상관없는 댓글");
    expect(second).toContain(`kanban_card_action with args {cardUuid: "${CARD}", action: "unblock"}`);
    expect(second).toMatch(/#2 in sess-\d+$/);   // 같은 Claude 프로세스·세션의 두 번째 차례
    expect(spawned(w)).toHaveLength(1);
    expect(named(tools, "list_comments")[0]?.args).toEqual({ cardUuid: CARD, workId: "work-1" });
    expect(named(tools, "kanban_card_action").map((c) => c.args.action)).toEqual(["accept", "start"]);
    expect(named(tools, "create_comments")).toHaveLength(1);
    expect(tools.todo("todo-2")?.note).toBe("Worked the card and asked for review.");
  });

  it("남이 쥔 할 일은 건너뛰고 다음 것 · 한 번에 하나만 가져간다(앞 것이 끝나야 다음 claim)", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "남의 것" });
    // 답을 받은 할 일(끝날 때까지 임대를 쥔다) — 멈추면 놓아야 다시 켤 때 바로 가져간다.
    tools.addCard({ uuid: CARD_B, title: "내 것", description: "@hang", status: "IN_PROGRESS", assignmentState: "ACCEPTED", workId: "work-b" });
    tools.addTodo("todo-other", "CARD_ASSIGNED", CARD);
    tools.addTodo("todo-mine", "DECISION_ANSWERED", CARD_B);
    tools.addTodo("todo-later", "CARD_ASSIGNED", CARD);
    tools.claimRefusals.set("todo-other", "CLAIMED_BY_OTHER");
    const w = startServe({ todos: { tools, agentName: "pc-agent" }, pollHoldSeconds: 0.05 });
    await until(() => logRecords(w).find((r) => r.event === "agent_request" && r.todoId === "todo-mine"));
    await new Promise((r) => setTimeout(r, 300));   // 몇 주기 — 도는 동안 다른 것을 가져가지 않는다
    const claims = named(tools, "update_agent_todos").map((c) => (c.args.items as Array<{ todoId: string; action: string }>)[0]);
    expect(claims).toEqual([{ todoId: "todo-other", action: "claim" }, { todoId: "todo-mine", action: "claim" }]);
    await finish(w);
    // 멈추면 돌던 것을 놓는다 — 다시 켜면 바로 가져간다.
    const records = logRecords(w);
    expect(records.filter((r) => r.event === "todo_lease").map((r) => [r.todoId, r.action, r.ok])).toEqual([
      ["todo-other", "claim", false], ["todo-mine", "claim", true], ["todo-mine", "release", true]]);
    expect(records.find((r) => r.event === "todo_run_result")).toMatchObject({ todoId: "todo-mine", outcome: "stopped" });
    expect(tools.todo("todo-mine")?.state).toBe("OPEN");
  });

  it("★임대는 서버가 준 만료 시각의 절반마다 renew · 사람이 직접 닫았으면(CLOSED_BY_HUMAN) 그 차례를 멈춘다", async () => {
    const tools = new FakeTools();
    tools.claimMs = 400;
    tools.addCard({ uuid: CARD, title: "답 기다림", status: "IN_PROGRESS", assignmentState: "ACCEPTED", workId: "work-9", description: "@hang" });
    tools.addTodo("todo-1", "DECISION_ANSWERED", CARD);
    const w = startServe({ todos: { tools, agentName: "pc-agent" } });
    await until(() => logRecords(w).filter((r) => r.event === "todo_lease" && r.action === "renew").length >= 2 ? true : undefined);
    tools.renewError = "CLOSED_BY_HUMAN";
    const result = await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    await finish(w);

    expect(result).toMatchObject({ todoId: "todo-1", outcome: "agent_failed", workId: "work-9" });
    const records = logRecords(w);
    expect(records.find((r) => r.event === "stop_request")).toMatchObject({ turnUuid: "todo:todo-1", running: true });
    expect(records.find((r) => r.event === "agent_response" && r.todoId === "todo-1")).toMatchObject({ status: "STOPPED" });
    expect(records.filter((r) => r.event === "todo_lease" && r.action === "renew").at(-1)).toMatchObject({ ok: false, error: "CLOSED_BY_HUMAN" });
    expect(named(tools, "kanban_card_action")).toHaveLength(0);   // 진행 중 카드 — 수락·시작 없이 같은 workId
    expect(String(named(tools, "send_auto_run_message").at(-1)?.args.body)).toBe("중단했어요. 그때까지 한 일(문서·카드)은 남아 있어요.");
  });

  it("도구가 실패하면 todo_run_result 에 그 도구·코드를 남기고 임대는 그대로(끝나면 다시 가져간다) · Chat 은 그대로 돈다", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "실패" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    tools.failOnce.set("kanban_card_action", "CARD_CHANGED");
    const w = startServe({ todos: { tools, agentName: "pc-agent" } });
    const result = await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(result).toMatchObject({ todoId: "todo-1", outcome: "error: kanban_card_action failed", tool: "kanban_card_action", code: "CARD_CHANGED" });
    expect(String(reply.reply)).toMatch(/^got hello #1/);
    expect(tools.todo("todo-1")?.state).toBe("CLAIMED");
  });

  it("★--agent 이름은 할 일 차례에만 — Chat 차례는 이름 없는 연결 그대로 · 같은 대화라도 이름이 바뀌면 세션을 새로(같은 세션 값으로 재개)", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "카드" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools, agentName: "pc-agent" } });
    await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    w.server.offer("t1", `conv-${CARD}`, "same conversation from Chat");
    const reply = await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-other", "other");
    await until(() => w.server.replies()[1]);
    await finish(w);
    const first = /in (sess-\d+)$/.exec(String(named(tools, "send_auto_run_message")[1]?.args.body))?.[1];
    expect(first).toBeDefined();
    expect(spawned(w)).toEqual([["--agent", "pc-agent"], ["--resume", first], []]);
    expect(String(reply.reply)).toBe(`got same conversation from Chat #1 in ${first}`);
  });

  it("★수락 뒤 끊기면 runs.json(카드·workId·시작 시각)이 남고, 다시 켜면 서버에서 카드를 다시 읽어 아직 내 작업일 때만 같은 workId 로 잇는다", async () => {
    const tools = new FakeTools();
    const card = tools.addCard({ uuid: CARD, title: "긴 일", description: "@hang" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const first = startServe({ todos: { tools, agentName: "pc-agent" } });
    await until(() => logRecords(first).find((r) => r.event === "agent_request"));
    await finish(first);   // PC 끔 — 할 일은 수락이 이미 닫았다
    const saved = JSON.parse(readFileSync(first.runsPath, "utf8")) as { runs: Array<Record<string, unknown>> };
    expect(saved.runs).toEqual([{ cardUuid: CARD, workId: "work-1", agent: "claude-code", startedAt: expect.any(String) }]);
    expect(logRecords(first).find((r) => r.event === "todo_run_result")).toMatchObject({ outcome: "stopped" });
    expect(tools.todos.filter((t) => t.state === "OPEN")).toHaveLength(0);

    // 다른 카드 하나는 그새 사람이 막아 두었다 — 잇지 않고 지운다.
    tools.addCard({ uuid: CARD_B, title: "막힌 카드", status: "IN_PROGRESS", assignmentState: "ACCEPTED", workId: "work-b", blocked: true });
    card.description = "이어서";
    const before = tools.calls.length;
    const second = startServe({ todos: { tools, agentName: "pc-agent" },
      runsFile: JSON.stringify({ version: 1, runs: [...saved.runs, { cardUuid: CARD_B, workId: "work-b", startedAt: "2026-11-16T00:00:00Z" }] }) });
    await until(() => logRecords(second).filter((r) => r.event === "todo_run_result").length >= 2 ? true : undefined);
    await finish(second);

    const records = logRecords(second);
    expect(records.find((r) => r.event === "runs_load")).toMatchObject({ entries: 2 });
    expect(records.filter((r) => r.event === "todo_run_result").map((r) => [r.todoId, r.outcome])).toEqual([
      [`resume:${CARD}`, "review_requested"], [`resume:${CARD_B}`, "not_runnable"]]);
    const later = tools.calls.slice(before);
    expect(later.filter((c) => c.tool === "kanban_card_action")).toHaveLength(0);   // 이미 수락·시작된 카드 — 같은 workId
    const prompt = String(later.find((c) => c.tool === "send_auto_run_message" && String(c.args.body).startsWith("got "))?.args.body);
    expect(prompt).toMatch(/^got \[AiNecto auto-run — resume\] /);
    expect(prompt).toContain("workId work-1");
    expect(later.find((c) => c.tool === "send_auto_run_message")?.args.body).toBe("이 PC 가 다시 켜져 «긴 일» 작업을 이어 가요.");
    expect(JSON.parse(readFileSync(second.runsPath, "utf8"))).toEqual({ version: 1, runs: [] });
  });

  it("runs.json 이 깨졌으면 조용히 비우고 로그 한 줄 · 할 일은 그대로 받는다", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "카드" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools, agentName: "pc-agent" }, runsFile: "{not json" });
    await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    await finish(w);
    const load = logRecords(w).filter((r) => r.event === "runs_load");
    expect(load).toHaveLength(1);
    expect(load[0]).toMatchObject({ entries: 0, reason: expect.stringMatching(/^unreadable: /) });
    expect(JSON.parse(readFileSync(w.runsPath, "utf8"))).toEqual({ version: 1, runs: [] });
    expect(logRecords(w).find((r) => r.event === "todo_run_result")).toMatchObject({ outcome: "review_requested" });
  });

  it("★Agent 가 차례 안에서 finish_work 를 불러 작업이 끝났어도 결과 넘기기는 끝난다 — CHECKPOINT 거절(WORK_NOT_IN_PROGRESS)은 경고로 남긴다 · 지시문은 finish_work 를 막는다", async () => {
    // dev 실측 11-16 카드 bfa5cc81: Claude Code 가 finish_work → 작업 DONE(카드는 IN_PROGRESS) → 결과 댓글 뒤 CHECKPOINT 가 거절돼 «error» 로 끝났다.
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "일찍 끝낸 작업", finishWorkDuringTurn: true });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools } });
    const result = await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    await finish(w);
    expect(result).toMatchObject({ outcome: "review_requested", warning: "report_work_progress: WORK_NOT_IN_PROGRESS" });
    expect(named(tools, "create_comments")).toHaveLength(1);
    expect(JSON.parse(readFileSync(w.runsPath, "utf8"))).toEqual({ version: 1, runs: [] });
    const prompt = String(named(tools, "send_auto_run_message")[1]?.args.body);
    expect(prompt).toContain("Do not run operation finish_work");
  });

  it("★폴더 이름이 없어도 받는다 — 서버가 준 종류 신원(이름 = 종류 id)으로", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "카드" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools } });
    await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    await finish(w);
    expect(w.server.calls[0]?.body.agents).toEqual([{ id: "claude-code", ready: true }]);
    expect(w.printed).toContain("Auto-run cards handed to Claude Code (claude-code) run here.");
    expect(spawned(w)).toEqual([["--agent", "claude-code"]]);
    expect(logRecords(w).find((r) => r.event === "todo_run_result")).toMatchObject({ outcome: "review_requested" });
  });

  it("★종류 둘 — 각자 자기 agentUuid 로 받고, 그 종류의 어댑터·신원으로 돈다(한 줄로 하나씩)", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "클로드 몫" });
    tools.addCard({ uuid: CARD_B, title: "코덱스 몫" });
    tools.addTodo("todo-claude", "CARD_ASSIGNED", CARD, undefined, "u-claude-code");
    tools.addTodo("todo-codex", "CARD_ASSIGNED", CARD_B, undefined, "u-codex");
    const w = startServe({ todos: { tools, agentName: "tester" }, installed: ["claude-code", "codex"], pollHoldSeconds: 0.05 });
    await until(() => logRecords(w).filter((r) => r.event === "todo_run_result").length >= 2 ? true : undefined);
    await finish(w);

    expect(w.server.calls[0]?.body.agents).toEqual([{ id: "claude-code", ready: true, name: "tester" }, { id: "codex", ready: true }]);
    expect(w.printed).toContain("Auto-run cards handed to Claude Code (tester) and Codex (codex) run here.");
    expect(named(tools, "list_agent_todos").map((c) => c.args.agent)).toEqual(expect.arrayContaining(["u-claude-code", "u-codex"]));
    const records = logRecords(w);
    expect(records.filter((r) => r.event === "agent_request").map((r) => [r.todoId, r.agent])).toEqual([
      ["todo-claude", "claude-code"], ["todo-codex", "codex"]]);
    expect(records.filter((r) => r.event === "todo_run_result").map((r) => r.outcome)).toEqual(["review_requested", "review_requested"]);
    // 한 번에 하나 — 둘째 할 일의 시작은 첫째의 끝 뒤.
    const order = records.filter((r) => r.event === "todo_run" || r.event === "todo_run_result").map((r) => `${r.event}:${r.todoId}`);
    expect(order).toEqual(["todo_run:todo-claude", "todo_run_result:todo-claude", "todo_run:todo-codex", "todo_run_result:todo-codex"]);
    // 각 할 일의 호출은 그 신원으로 · 브리지 이름도 그 신원.
    const asOf = (cardUuid: string) => new Set(tools.calls.filter((c) => c.args.cardUuid === cardUuid).map((c) => `${c.as?.agent}/${c.as?.name}`));
    expect([...asOf(CARD)]).toEqual(["claude-code/tester"]);
    expect([...asOf(CARD_B)]).toEqual(["codex/codex"]);
    expect(spawned(w)).toEqual([["--agent", "tester"]]);
    expect(codexSpawned(w)).toEqual([["app-server", "--agent", "codex"]]);
    expect(String(named(tools, "send_auto_run_message").find((c) => c.args.cardUuid === CARD_B && String(c.args.body).startsWith("got "))
      ?.args.body)).toMatch(/^got \[AiNecto auto-run\] /);
  });

  it("★신원이 null 인 종류(AGENT_LIMIT)는 건너뛰고 알린다 — 다른 종류는 그대로 받는다", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, title: "카드" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    tools.addTodo("todo-codex", "CARD_ASSIGNED", CARD_B, undefined, "u-codex");
    const w = startServe({ todos: { tools }, installed: ["claude-code", "codex"], openAgents: [
      { id: "claude-code", kindLabel: "Claude Code", ready: true, agentUuid: "u-claude-code", name: "claude-code", error: null },
      { id: "codex", kindLabel: "Codex", ready: true, agentUuid: null, name: null, error: "AGENT_LIMIT" },
    ] });
    await until(() => logRecords(w).find((r) => r.event === "todo_run_result"));
    await finish(w);
    expect(named(tools, "list_agent_todos").map((c) => c.args.agent).every((a) => a === "u-claude-code")).toBe(true);
    expect(tools.todo("todo-codex")?.state).toBe("OPEN");
    expect(w.printed).toContain("Codex: AiNecto refused its agent identity (AGENT_LIMIT), so auto-run cards for Codex are not taken here. "
      + "Archive an agent you no longer use in AiNecto, then run `ainecto start` again.");
    expect(w.printed).toContain("Auto-run cards handed to Claude Code (claude-code) run here.");
  });

  it("신원이 하나도 없으면(옛 서버 — 응답에 agents 없음) 할 일은 받지 않고 한 줄 · Chat 은 그대로", async () => {
    const tools = new FakeTools();
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools }, openAgents: null });
    w.server.offer("t1", "conv-a", "hello");
    await until(() => w.server.replies()[0]);
    await finish(w);
    expect(tools.calls).toHaveLength(0);
    expect(w.printed).toContain("Auto-run cards are not taken here: AiNecto did not give this connection an agent identity (update the server, or sign in to Claude Code or Codex).");
  });

  it("★폴더 이름을 서버가 거절하면(400 AGENT_NAME_INVALID) 분명한 안내와 함께 끝낸다", async () => {
    const tools = new FakeTools();
    const w = startServe({ todos: { tools, agentName: "Bad Name" },
      openError: new AgentCallError("name must be lowercase", "open", 400, "AGENT_NAME_INVALID") });
    const result = await w.done;
    expect(result).toEqual({ exitCode: 1, reason: "agent_name_invalid" });
    expect(w.printed).toEqual(["AiNecto did not accept the agent name «Bad Name» in this folder's .ainecto/agent.local (name must be lowercase). "
      + "Set a valid name with `ainecto init --agent NAME` (or delete .ainecto/agent.local), then run `ainecto start` again."]);
    expect(w.server.calls.map((c) => c.op)).toEqual(["open"]);
  });

  it("agents[].name 을 모르는 서버는 이름을 빼고 다시 연다(그런 서버는 todos 도 모른다 — stop 은 그대로)", async () => {
    const tools = new FakeTools();
    const w = startServe({ todos: { tools, agentName: "tester" }, rejectNames: true });
    await until(() => named(tools, "list_agent_todos")[0]);
    await finish(w);
    const opens = w.server.calls.filter((c) => c.op === "open").map((c) => c.body);
    expect(opens.map((b) => [b.agents, b.features])).toEqual([
      [[{ id: "claude-code", ready: true, name: "tester" }], ["stop", "todos"]],
      [[{ id: "claude-code", ready: true, name: "tester" }], ["stop"]],
      [[{ id: "claude-code", ready: true }], ["stop"]]]);
    expect(w.printed).toContain("Auto-run cards handed to Claude Code (claude-code) run here.");
  });

  it("★할 일을 받는 serve 는 open 에 todos 를 알린다(서버가 자동 실행 «켜짐»으로 보는 표시 — Edwin #1890) · 모르는 서버면 todos 만 빼고 다시 연다", async () => {
    const tools = new FakeTools();
    const w = startServe({ todos: { tools, agentName: "tester" } });
    await until(() => named(tools, "list_agent_todos")[0]);
    await finish(w);
    expect(w.server.calls.filter((c) => c.op === "open").map((c) => c.body.features)).toEqual([["stop", "todos"]]);

    const oldTools = new FakeTools();
    const old = startServe({ todos: { tools: oldTools, agentName: "tester" }, rejectTodos: true });
    await until(() => named(oldTools, "list_agent_todos")[0]);
    await finish(old);
    const opens = old.server.calls.filter((c) => c.op === "open").map((c) => c.body);
    expect(opens.map((b) => [b.agents, b.features])).toEqual([
      [[{ id: "claude-code", ready: true, name: "tester" }], ["stop", "todos"]],
      [[{ id: "claude-code", ready: true, name: "tester" }], ["stop"]]]);
    expect(logRecords(old).filter((r) => r.event === "open_without_features").map((r) => r.features)).toEqual([["features.todos"]]);
  });
});
