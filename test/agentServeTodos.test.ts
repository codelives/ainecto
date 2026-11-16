import { finish, logRecords, spawned, startServe, until } from "./support/agentServeWorld";
import { FakeTools } from "./support/fakeTools";

const CARD = "c".repeat(32);
const CARD_B = "d".repeat(32);

/** 도구 이름만 — 순서 대조용. */
const named = (tools: FakeTools, name: string) => tools.calls.filter((c) => c.tool === name);

describe("ainecto agent serve — 에이전트 할 일(자동 실행 카드, KAN-1113)", () => {
  it("★배정된 카드: claim → accept → start → 실행 대화 시작 글 → Chat 과 같은 실행기 한 차례 → 답 글 → 결과 댓글 → 검토 요청", async () => {
    const tools = new FakeTools();
    tools.addCard({ uuid: CARD, key: "KAN-7", title: "로그인 고치기", description: "로그인 버튼이 안 눌린다" });
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools, agentName: "pc-agent" } });
    await until(() => named(tools, "kanban_card_action").find((c) => c.args.action === "request_review"));
    await finish(w);

    expect(tools.tools()).toEqual([
      "list_agent_todos", "update_agent_todos", "kanban_list_cards", "kanban_card_action", "kanban_card_action",
      "send_auto_run_message", "send_auto_run_message", "kanban_list_cards", "create_comments", "kanban_card_action",
      ...tools.tools().slice(10),
    ]);
    expect(tools.calls[0]?.args).toEqual({ state: ["OPEN"], kinds: ["CARD_ASSIGNED", "DECISION_ANSWERED"], agent: "me" });
    expect(tools.calls[1]?.args).toEqual({ items: [{ todoId: "todo-1", action: "claim" }] });
    expect(named(tools, "kanban_card_action").map((c) => c.args.action)).toEqual(["accept", "start", "request_review"]);
    expect(named(tools, "start_work")).toHaveLength(0);   // start 결과의 card.work.workId 를 쓴다
    const [opening, answer] = named(tools, "send_auto_run_message");
    expect(opening?.args).toEqual({ cardUuid: CARD, workId: "work-1", body: "«로그인 고치기» 작업을 시작했어요." });
    // 가짜 claude 는 받은 글을 «got <글>» 로 돌려준다 — 지시문에 카드·workId·판단 요청 순서(주인 userId)가 들어갔다.
    const body = String(answer?.args.body);
    expect(body).toMatch(/^got \[AiNecto auto-run\] /);
    expect(body).toContain(`Card «로그인 고치기» (KAN-7, cardUuid ${CARD}, boardUuid board-1) · status IN_PROGRESS`);
    expect(body).toContain("workId work-1");
    expect(body).toContain("Description:\n로그인 버튼이 안 눌린다");
    expect(body).toContain("- [ ] 끝나면 검토 요청");
    expect(body).toContain(`2) kanban_card_action {cardUuid: "${CARD}", action: "block", reason: <one line>, responderIds: ["user-owner"]}`);
    expect(named(tools, "create_comments")[0]?.args).toEqual({ cardUuid: CARD, workId: "work-1", items: [{ body, resultReview: true }] });
    expect(named(tools, "kanban_card_action")[2]?.args).toEqual({ cardUuid: CARD, action: "request_review", workId: "work-1" });
    // 카드 배정 할 일은 accept 가 닫았다 — complete 를 보내지 않는다.
    expect(named(tools, "update_agent_todos").map((c) => (c.args.items as Array<{ action: string }>)[0]?.action)).toEqual(["claim"]);
    expect(spawned(w)).toHaveLength(1);
    const records = logRecords(w);
    expect(records.find((r) => r.event === "agent_request" && r.todoId === "todo-1")).toMatchObject({ conversationUuid: `conv-${CARD}` });
    expect(records.filter((r) => r.event === "todo_run").map((r) => r.todoId)).toEqual(["todo-1"]);
    expect(records.find((r) => r.event === "todo_run_result")).toMatchObject({ todoId: "todo-1", outcome: "review_requested",
      workId: "work-1", conversationUuid: `conv-${CARD}` });
    expect(w.printed).toContain("Auto-run cards handed to your agent «pc-agent» also run here (in Claude Code).");
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
    expect(second).toContain(`kanban_card_action {cardUuid: "${CARD}", action: "unblock"}`);
    expect(second).toMatch(/#2 in sess-\d+$/);   // 같은 Claude 프로세스·세션의 두 번째 차례
    expect(spawned(w)).toHaveLength(1);
    expect(named(tools, "list_comments")[0]?.args).toEqual({ cardUuid: CARD, workId: "work-1" });
    expect(named(tools, "kanban_card_action").map((c) => c.args.action)).toEqual(["accept", "start", "request_review"]);
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

  it("이 폴더에 에이전트 이름이 없으면 할 일은 받지 않고 시작 줄에 이유를 한 줄", async () => {
    const tools = new FakeTools();
    tools.addTodo("todo-1", "CARD_ASSIGNED", CARD);
    const w = startServe({ todos: { tools } });
    w.server.offer("t1", "conv-a", "hello");
    await until(() => w.server.replies()[0]);
    await finish(w);
    expect(tools.calls).toHaveLength(0);
    expect(w.printed).toContain("Auto-run cards are not taken here: this folder has no agent name. Run `ainecto init --agent NAME` here, then start `ainecto agent serve` again.");
  });
});
