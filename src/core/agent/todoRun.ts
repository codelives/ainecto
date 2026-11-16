import type { DaemonLog } from "../term/daemonLog";
import type { AgentLogRecord } from "./log";
import { clip, type AgentReply } from "./reply";
import { AgentToolError, type AgentTools } from "./tools";

/**
 * ★에이전트 할 일(자동 실행된 칸반 카드 — KAN-1113)을 serve 가 처리하는 한 곳. 받는 종류는 {@link TODO_KINDS} 둘.
 *
 * <pre>
 * 가져가기    list_agent_todos(이름 붙은 연결 · agent me) → update_agent_todos claim(임대) — 임대는 서버가 준 claimExpiresAt 의 절반마다 renew
 * 카드 배정   (CARD_ASSIGNED) 수락 대기면 accept(할 일이 닫힌다 → runs.json 에 적는다) → 할 일 칸이면 start → workId(카드 work 또는 start_work)
 * 다시 켬     (RESUME) runs.json 에 남은 카드 — ★서버에서 다시 읽어 아직 내 작업(수락됨·진행 중·안 막힘·같은 workId)일 때만 잇는다
 * 답을 받음   (DECISION_ANSWERED) 같은 카드·같은 workId·같은 실행 대화 — 답 댓글을 지시문에 넣는다. 다 돌면 complete
 * 실행       실행 대화에 시작 글(send_auto_run_message — 카드 uuid 로 서버가 같은 대화를 준다) → Chat 과 같은 실행기로 한 차례
 *            → Agent 답 글을 실행 대화에 → 카드를 다시 읽어 막혔으면(판단 요청) 기다리고, 진행 중이면 결과 넘기기({@link handOverResult})
 * 판단 요청   Agent 가 한다(지시문): QUESTION 댓글 → block(주인) → report_work_progress BLOCKED → 멈춤
 * 승인       사람만 — 주인이 웹에서 한다(서버가 검토자·요청자에 따라 request_review 를 대신). 여기서 request_review·approve 하지 않는다
 * </pre>
 * 서버 호출은 전부 {@link AgentTools}(요청 1줄 + 응답 1줄). 한 건의 처리도 {@code todo_run} + {@code todo_run_result} 두 줄(같은 todoId).
 */
export const TODO_KINDS = ["CARD_ASSIGNED", "DECISION_ANSWERED"] as const;
export type TodoKind = (typeof TODO_KINDS)[number];
/** 한 건의 종류 — 서버 할 일 둘 + 이 PC 가 다시 켜서 잇는 카드(RESUME — 서버 할 일이 아니다, runs.json). */
export type RunKind = TodoKind | "RESUME";

export interface AgentTodo {
  /** 서버 할 일 id — RESUME 은 {@link resumeTodo} 가 지은 로컬 id. */
  todoId: string;
  kind: RunKind;
  cardUuid: string;
  /** 할 일이 가리키는 댓글(답 댓글) — 없으면 undefined. */
  commentId?: number;
  /** RESUME: runs.json 에 적힌 workId — 카드의 지금 작업과 다르면 잇지 않는다. */
  workId?: string;
}

/** runs.json 한 줄 → 다시 켜서 잇는 한 건. */
export function resumeTodo(entry: { cardUuid: string; workId?: string }): AgentTodo {
  return { todoId: `resume:${entry.cardUuid}`, kind: "RESUME", cardUuid: entry.cardUuid, ...(entry.workId ? { workId: entry.workId } : {}) };
}

/** list_agent_todos 한 장 → 받는 할 일(카드를 가리키는 두 종류만) · 다음 장 커서. */
export function todosIn(res: Record<string, unknown>): { items: AgentTodo[]; next?: string } {
  const raw = Array.isArray(res.items) ? res.items : [];
  const items = raw.flatMap((value): AgentTodo[] => {
    const item = record(value);
    const target = record(item.target);
    const kind = item.kind;
    if (typeof item.todoId !== "string" || !isTodoKind(kind) || target.type !== "KANBAN_CARD" || typeof target.uuid !== "string") {
      return [];
    }
    return [{ todoId: item.todoId, kind, cardUuid: target.uuid,
      ...(typeof target.commentId === "number" ? { commentId: target.commentId } : {}) }];
  });
  const last = raw.length > 0 ? record(raw[raw.length - 1]).todoId : undefined;
  return { items, ...(res.hasMore === true && typeof last === "string" ? { next: last } : {}) };
}

function isTodoKind(value: unknown): value is TodoKind {
  return typeof value === "string" && (TODO_KINDS as readonly string[]).includes(value);
}

/** 다음 renew 까지 — ★서버가 준 만료 시각까지 남은 시간의 절반(새 상수 없음). 읽을 수 없으면 undefined(연장하지 않는다). */
export function renewDelayMs(claimExpiresAt: unknown, nowMs: number): number | undefined {
  if (typeof claimExpiresAt !== "string") return undefined;
  const at = Date.parse(claimExpiresAt);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.floor((at - nowMs) / 2));
}

/** 카드 상세(kanban_list_cards cardUuids · kanban_card_action 결과의 card)에서 쓰는 칸. */
export interface CardFacts {
  uuid: string;
  key?: string;
  title: string;
  boardUuid?: string;
  status: string;
  assignmentState?: string;
  blocked: boolean;
  description?: string;
  criteria: Array<{ text: string; done: boolean }>;
  /** 담당자(자동 실행을 건 사람) — 판단 요청의 응답 대상. */
  ownerUserId?: string;
  workId?: string;
}

export function cardFactsOf(detail: unknown): CardFacts {
  const d = record(detail);
  const card = record(d.card);
  if (typeof card.uuid !== "string" || typeof card.status !== "string") {
    throw new AgentToolError("The card detail has no uuid or status.", "kanban_list_cards", "MCP_PROTOCOL_ERROR");
  }
  const work = record(d.work);
  const owner = record(card.assignee);
  return {
    uuid: card.uuid,
    ...(typeof card.key === "string" ? { key: card.key } : {}),
    title: str(card.title),
    ...(typeof d.boardUuid === "string" ? { boardUuid: d.boardUuid } : {}),
    status: card.status,
    ...(typeof card.assignmentState === "string" ? { assignmentState: card.assignmentState } : {}),
    blocked: card.blocked === true,
    ...(typeof d.description === "string" && d.description.trim() ? { description: d.description } : {}),
    criteria: (Array.isArray(d.criteria) ? d.criteria : []).flatMap((c) => {
      const v = record(c);
      return typeof v.text === "string" ? [{ text: v.text, done: v.done === true }] : [];
    }),
    ...(typeof owner.userId === "string" ? { ownerUserId: owner.userId } : {}),
    ...(typeof work.workId === "string" ? { workId: work.workId } : {}),
  };
}

/** 답 댓글 한 줄(지시문에 넣는다). */
export interface AnswerComment {
  id: number;
  author: string;
  kind: string;
  body: string;
  questionState?: string;
}

/**
 * 이어 가기의 답 댓글 — ★할 일이 가리키는 댓글의 스레드 + 아직 해결 안 된 질문의 스레드(오래된 순, 중복 없이). 순수 함수.
 * 스레드 = 뿌리 댓글과 그 답글(서버는 답글을 한 단계만 둔다).
 */
export function answerComments(listed: Record<string, unknown>, commentId: number | undefined): AnswerComment[] {
  const all = (Array.isArray(listed.comments) ? listed.comments : []).map(record).filter((c) => typeof c.id === "number");
  const rootOf = (c: Record<string, unknown>): number =>
    typeof c.rootCommentId === "number" ? c.rootCommentId : typeof c.parentCommentId === "number" ? c.parentCommentId : (c.id as number);
  const roots = new Set<number>();
  const pointed = all.find((c) => c.id === commentId);
  if (pointed) roots.add(rootOf(pointed));
  for (const c of all) {
    if (c.kind === "QUESTION" && c.questionState !== "RESOLVED" && c.parentCommentId == null) roots.add(c.id as number);
  }
  return all.filter((c) => roots.has(rootOf(c))).map((c) => ({
    id: c.id as number,
    author: str(record(c.author).displayName) || "?",
    kind: str(c.kind) || "COMMENT",
    body: str(c.body),
    ...(typeof c.questionState === "string" ? { questionState: c.questionState } : {}),
  }));
}

/**
 * Agent 에 넣는 지시문(순수 함수) — 카드 내용 · workId · 판단 요청 순서 · 이어 가기면 답 댓글. Agent 의 답(reply)은 실행 대화에 그대로 남는다.
 */
const PROMPT_HEADS: Readonly<Record<RunKind, string>> = {
  CARD_ASSIGNED: "[AiNecto auto-run] The person handed you this kanban card with auto-run. Do the work with the AiNecto tools.",
  DECISION_ANSWERED: "[AiNecto auto-run — continue] The person answered on this card (or asked for changes). Continue the same work.",
  RESUME: "[AiNecto auto-run — resume] This machine stopped while you were working this card. Continue the same work: "
    + "first check what is already done with report_work_progress (CHECKPOINT).",
};

export function todoPromptText(input: { kind: RunKind; card: CardFacts; workId: string; answers: AnswerComment[] }): string {
  const { card, workId } = input;
  const owner = card.ownerUserId ?? "the card's assignee";
  const lines: string[] = [
    PROMPT_HEADS[input.kind],
    "",
    `Card «${card.title}» (${card.key ? `${card.key}, ` : ""}cardUuid ${card.uuid}${card.boardUuid ? `, boardUuid ${card.boardUuid}` : ""}) · status ${card.status}${card.blocked ? " · blocked" : ""}`,
    `AI work: workId ${workId} — send this workId with every AiNecto call for this card and report each step with report_work_progress (read each response before going on).`,
  ];
  if (card.description) lines.push("", "Description:", card.description);
  if (card.criteria.length > 0) {
    lines.push("", "Done criteria:", ...card.criteria.map((c) => `- [${c.done ? "x" : " "}] ${c.text}`));
  }
  if (input.answers.length > 0) {
    lines.push("", "Comments to read (oldest first):",
      ...input.answers.map((a) => `- #${a.id} ${a.kind}${a.questionState ? ` (${a.questionState})` : ""} by ${a.author}: ${a.body}`));
    lines.push("", "First read them: report_work_progress (it lists the comments to read — send `read` with its checkId), "
      + "resolve_comments for the questions that are answered, and if the card is blocked, kanban_card_action "
      + `{cardUuid: "${card.uuid}", action: "unblock"}`
      + ". Then continue the work.");
  }
  lines.push("",
    "If you need the person's decision, do not guess. Ask and stop:",
    `1) create_comments {cardUuid: "${card.uuid}", workId: "${workId}", items: [{kind: "QUESTION", body: <your question>}]}`,
    `2) kanban_card_action {cardUuid: "${card.uuid}", action: "block", reason: <one line>, responderIds: ["${owner}"]}`,
    `3) report_work_progress {workId: "${workId}", stepId: <the step>, status: "BLOCKED"}`,
    "Then answer with what you asked. You will be called again on this card when they answer.",
    "",
    "Do not request review, approve, or finish the card yourself — this PC posts your answer as the result and asks the person to review it.",
    "Do not call finish_work: the AI work stays open until the person approves the result (finishing it early blocks the hand-over).",
    "Your answer (reply) is shown to the person in this card's auto-run conversation: say what you did, or what you asked.");
  return lines.join("\n");
}

/** 한 건을 처리한 끝. */
export type TodoOutcome =
  /** 결과 댓글(결과 검토 요청)까지 했다. */
  | "review_requested"
  /** Agent 가 판단을 요청하고 멈췄다(카드 막힘) — 답이 오면 DECISION_ANSWERED 로 다시 온다. */
  | "decision_requested"
  /** 카드가 이미 진행 중이 아니다(검토 중·완료·보관) — 할 일이 없다. */
  | "not_runnable"
  /** Agent 차례가 실패했다(답 글은 실행 대화에 남겼다). */
  | "agent_failed"
  /** serve 가 멈추는 중 — 중간에 그만뒀다(임대가 끝나면 다시 가져간다). */
  | "stopped";

/** runs.json 의 쓰기 두 가지(runs.ts) — 없으면 적지 않는다. */
export interface RunTracker {
  started(cardUuid: string, workId?: string): Promise<void>;
  finished(cardUuid: string): Promise<void>;
}

export interface TodoRunDeps {
  /** ★그 할 일 신원의 입구(tools.ts toolsAs) — 수락·진행·글·결과 댓글이 그 신원으로 기록된다(사람만 승인 규칙도). */
  tools: AgentTools;
  runs?: RunTracker;
  log: DaemonLog<AgentLogRecord>;
  textMaxCharacters: number;
  /** serve 가 멈추는 중이면 aborted. */
  signal: AbortSignal;
  /** ★Chat 요청과 같은 실행기 — 이 대화의 Agent 세션에 한 차례. */
  runAgent(input: { todoId: string; conversationUuid: string; text: string }): Promise<AgentReply>;
}

/** 할 일 한 건 처리 — 실패는 던진다(이유는 todo_run_result 줄에). */
export async function runTodo(deps: TodoRunDeps, todo: AgentTodo): Promise<TodoOutcome> {
  const started = Date.now();
  deps.log.write({ event: "todo_run", todoId: todo.todoId, kind: todo.kind, cardUuid: todo.cardUuid });
  let outcome: TodoOutcome | undefined;
  let workId: string | undefined;
  let conversationUuid: string | undefined;
  let failure: AgentToolError | Error | undefined;
  /** 끝까지 갔지만 남길 것(예: Agent 가 이미 finish_work 해서 CHECKPOINT 거절) — todo_run_result 에. */
  let warning: string | undefined;
  try {
    const ends = async (value: TodoOutcome): Promise<TodoOutcome> => {
      outcome = value;
      if (value !== "stopped") await deps.runs?.finished(todo.cardUuid);
      return value;
    };
    let card = await readCard(deps.tools, todo.cardUuid);
    if (todo.kind === "RESUME" && !resumable(card, todo.workId)) return await ends("not_runnable");
    if (todo.kind === "CARD_ASSIGNED" && card.assignmentState === "PENDING") {
      card = await act(deps.tools, card.uuid, "accept");
      await deps.runs?.started(card.uuid);   // ★할 일이 닫혔다 — 이제부터 끊기면 runs.json 이 잇는다
    }
    if (todo.kind !== "DECISION_ANSWERED" && card.status === "TODO") card = await act(deps.tools, card.uuid, "start");
    if (card.status !== "IN_PROGRESS") return await ends("not_runnable");
    workId = card.workId ?? await startWork(deps.tools, card.uuid);
    if (todo.kind !== "DECISION_ANSWERED") await deps.runs?.started(card.uuid, workId);
    conversationUuid = await postToRun(deps, card.uuid, workId, OPENINGS[todo.kind](card.title));
    const answers = todo.kind === "DECISION_ANSWERED"
      ? answerComments(await deps.tools.call("list_comments", { cardUuid: card.uuid, workId }), todo.commentId) : [];
    if (deps.signal.aborted) {
      outcome = "stopped";
      return outcome;
    }
    const reply = await deps.runAgent({ todoId: todo.todoId, conversationUuid,
      text: todoPromptText({ kind: todo.kind, card, workId, answers }) });
    if (deps.signal.aborted) {
      outcome = "stopped";
      return outcome;
    }
    await postToRun(deps, card.uuid, workId, reply.reply);
    if (reply.status !== "DONE") return await ends("agent_failed");
    const after = await readCard(deps.tools, card.uuid, workId);
    if (after.blocked) return await ends("decision_requested");
    if (after.status !== "IN_PROGRESS") return await ends("not_runnable");
    warning = await handOverResult(deps, after, workId, reply.reply);
    return await ends("review_requested");
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    deps.log.write({ event: "todo_run_result", todoId: todo.todoId, kind: todo.kind, cardUuid: todo.cardUuid,
      outcome: outcome ?? `error: ${failure?.message ?? "unknown"}`, ...(warning ? { warning } : {}),
      ...(failure instanceof AgentToolError ? { tool: failure.tool, ...(failure.code ? { code: failure.code } : {}) } : {}),
      ...(workId ? { workId } : {}), ...(conversationUuid ? { conversationUuid } : {}), ms: Date.now() - started });
  }
}

/** 실행 대화 시작 글 — 종류마다. */
const OPENINGS: Readonly<Record<RunKind, (title: string) => string>> = {
  CARD_ASSIGNED: (title) => `«${title}» 작업을 시작했어요.`,
  DECISION_ANSWERED: (title) => `답을 받아 «${title}» 작업을 이어 가요.`,
  RESUME: (title) => `이 PC 가 다시 켜져 «${title}» 작업을 이어 가요.`,
};

/** 다시 켜서 이을 카드인가 — ★서버의 지금 카드로만 판정(수락됨 · 할 일/진행 중 · 안 막힘 · 적어 둔 작업과 같은 작업). */
function resumable(card: CardFacts, workId: string | undefined): boolean {
  if (card.assignmentState !== "ACCEPTED" || card.blocked) return false;
  if (card.status !== "TODO" && card.status !== "IN_PROGRESS") return false;
  return !workId || !card.workId || card.workId === workId;
}

/**
 * ★결과를 사람에게 넘기는 한 곳(끝 단계) — 결과 댓글({@code resultReview} = «결과 검토 요청» — 주인에게 알림, 주인의 답글·수정 의견은
 * DECISION_ANSWERED 로 다시 온다) → report_work_progress CHECKPOINT(결과를 알리기 전 확인 — 이 보고에 글 칸은 없다).
 * 작업이 이미 끝나 있으면(WORK_NOT_IN_PROGRESS — Agent 가 finish_work) 넘기기는 끝난 것으로 보고 경고를 돌려준다.
 * ★request_review·approve 는 부르지 않는다 — 승인은 주인이 웹에서 하고, 그때 서버가 검토자·요청자에 따라 검토 요청을 대신 한다.
 */
async function handOverResult(deps: TodoRunDeps, card: CardFacts, workId: string, result: string): Promise<string | undefined> {
  await deps.tools.call("create_comments", { cardUuid: card.uuid, workId,
    items: [{ kind: "COMMENT", body: clip(result, deps.textMaxCharacters), resultReview: true }] });
  try {
    await deps.tools.call("report_work_progress", { workId, status: "CHECKPOINT" });
    return undefined;
  } catch (error) {
    // Agent 가 지시를 어기고 차례 안에서 finish_work 를 했다 — 결과 댓글(검토 요청)은 이미 남았다. 넘기기는 끝, 이유는 경고로(삼키지 않는다).
    if (error instanceof AgentToolError && error.code === "WORK_NOT_IN_PROGRESS") return `report_work_progress: ${error.code}`;
    throw error;
  }
}

async function readCard(tools: AgentTools, cardUuid: string, workId?: string): Promise<CardFacts> {
  const res = await tools.call("kanban_list_cards", { cardUuids: [cardUuid], ...(workId ? { workId } : {}) });
  const cards = Array.isArray(res.cards) ? res.cards : [];
  return cardFactsOf(cards[0]);
}

async function act(tools: AgentTools, cardUuid: string, action: "accept" | "start"): Promise<CardFacts> {
  const res = await tools.call("kanban_card_action", { cardUuid, action });
  return cardFactsOf(res.card);
}

async function startWork(tools: AgentTools, cardUuid: string): Promise<string> {
  const res = await tools.call("start_work", { cardUuid });
  const workId = typeof res.workId === "string" ? res.workId : record(res.work).workId;
  if (typeof workId !== "string") throw new AgentToolError("start_work returned no workId.", "start_work", "MCP_PROTOCOL_ERROR");
  return workId;
}

/** 실행 대화에 글 — 서버가 카드로 그 사람의 실행 대화를 찾아 준다. 대화 uuid 를 돌려준다. */
async function postToRun(deps: TodoRunDeps, cardUuid: string, workId: string, body: string): Promise<string> {
  const res = await deps.tools.call("send_auto_run_message", { cardUuid, workId, body: clip(body, deps.textMaxCharacters) });
  if (typeof res.conversationUuid !== "string") {
    throw new AgentToolError("send_auto_run_message returned no conversationUuid.", "send_auto_run_message", "MCP_PROTOCOL_ERROR");
  }
  return res.conversationUuid;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// ── 임대 ────────────────────────────────────────────────────────────────

/** 가져간 할 일 — 지금 쥔 임대 토큰과 서버가 준 만료 시각. */
export interface ClaimedTodo {
  todo: AgentTodo;
  leaseToken: string;
  claimExpiresAt?: string;
}

/** 임대를 잃은 이유 중 «일을 그만둬야 하는» 것 — 사람이 직접 했다 · 대체됐다 · 더는 못 본다. */
const STOP_WORK_ERRORS: ReadonlySet<string> = new Set(["CLOSED_BY_HUMAN", "SUPERSEDED", "ACCESS_LOST"]);

/** update_agent_todos 한 항목 — 결과 한 줄(항목별 결과). */
async function updateTodo(tools: AgentTools, item: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await tools.call("update_agent_todos", { items: [item] });
  return record(Array.isArray(res.results) ? res.results[0] : undefined);
}

/** claim — 임대를 받으면 그것, 남이 쥐었거나 닫혔으면 undefined(이유는 todo_lease 줄). 도구 실패는 던진다. */
export async function claimTodo(tools: AgentTools, log: DaemonLog<AgentLogRecord>, todo: AgentTodo): Promise<ClaimedTodo | undefined> {
  const result = await updateTodo(tools, { todoId: todo.todoId, action: "claim" });
  const ok = result.ok === true && typeof result.leaseToken === "string";
  log.write({ event: "todo_lease", todoId: todo.todoId, action: "claim", ok,
    ...(ok ? {} : { error: str(result.error) || "no leaseToken" }),
    ...(typeof result.claimExpiresAt === "string" ? { next: result.claimExpiresAt } : {}) });
  if (!ok) return undefined;
  return { todo, leaseToken: result.leaseToken as string,
    ...(typeof result.claimExpiresAt === "string" ? { claimExpiresAt: result.claimExpiresAt } : {}) };
}

export interface LeaseKeeper {
  /** 연장을 그만둔다(타이머 해제). */
  stop(): void;
}

/**
 * 임대 유지 — ★서버가 준 만료 시각까지 남은 시간의 절반마다 renew(새 상수 없음). 연장이 실패하면 그만두고, 일을 그만둬야 하는 이유
 * ({@link STOP_WORK_ERRORS})면 {@code onLost} 를 부른다. 수락으로 할 일이 닫힌 뒤(ALREADY_DONE)는 조용히 그만둔다 — 그때부터는 카드 작업이 잠금이다.
 */
export function keepLease(tools: AgentTools, log: DaemonLog<AgentLogRecord>, claimed: ClaimedTodo,
  onLost: (reason: string) => void, now: () => number = Date.now): LeaseKeeper {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (expiresAt: string | undefined) => {
    const delay = renewDelayMs(expiresAt, now());
    if (stopped || delay === undefined) return;
    timer = setTimeout(() => void renew(), delay);
    timer.unref?.();
  };
  const renew = async () => {
    if (stopped) return;
    let error: string | undefined;
    let next: string | undefined;
    try {
      const result = await updateTodo(tools, { todoId: claimed.todo.todoId, action: "renew", leaseToken: claimed.leaseToken });
      if (result.ok === true) {
        if (typeof result.leaseToken === "string") claimed.leaseToken = result.leaseToken;
        next = typeof result.claimExpiresAt === "string" ? result.claimExpiresAt : undefined;
        claimed.claimExpiresAt = next;
      } else {
        error = str(result.error) || "renew refused";
      }
    } catch (failure) {
      // 도구 실패(네트워크 등) — 이유는 도구 응답 줄에. 임대가 아직 남았으면 다음 절반에 다시 한다.
      error = failure instanceof Error ? failure.message : String(failure);
      next = claimed.claimExpiresAt;
    }
    log.write({ event: "todo_lease", todoId: claimed.todo.todoId, action: "renew", ok: error === undefined,
      ...(error ? { error } : {}), ...(next ? { next } : {}) });
    if (error !== undefined && STOP_WORK_ERRORS.has(error)) {
      stopped = true;
      onLost(error);
      return;
    }
    if (error !== undefined && next === undefined) return;   // 잃었다(LEASE_LOST·ALREADY_DONE …) — 연장만 그만둔다
    if (next !== undefined && Date.parse(next) <= now()) return;
    schedule(next);
  };
  schedule(claimed.claimExpiresAt);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * 끝난 할 일 닫기 — complete(한 줄 메모)·release(serve 가 멈춤 — 바로 다시 가져가게). 카드 할 일은 complete 가 거절된다
 * (BUSINESS_ACTION_REQUIRED — 카드 행동이 이미 닫았거나 닫는다). 실패는 남기고 삼키지 않는다(던지지는 않는다 — 임대는 끝나면 풀린다).
 */
/** @param note complete 의 한 줄 — 이 파일이 지은 짧은 고정 글만 넣는다(서버 상한 안 — 본문·Agent 답을 넣지 않는다). */
export async function closeTodo(tools: AgentTools, log: DaemonLog<AgentLogRecord>, claimed: ClaimedTodo,
  action: "complete" | "release", note?: string): Promise<void> {
  let error: string | undefined;
  try {
    const result = await updateTodo(tools, { todoId: claimed.todo.todoId, action, leaseToken: claimed.leaseToken,
      ...(action === "complete" && note ? { note } : {}) });
    if (result.ok !== true) error = str(result.error) || `${action} refused`;
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  log.write({ event: "todo_lease", todoId: claimed.todo.todoId, action, ok: error === undefined, ...(error ? { error } : {}) });
}
