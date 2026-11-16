import type { AgentToolCallOptions, AgentTools } from "../../src/core/agent/tools";
import { AgentToolError } from "../../src/core/agent/tools";

/** 가짜 카드 — 서버 카드 상세의 칸 중 serve 가 읽는 것. */
export interface FakeCard {
  uuid: string;
  key: string;
  title: string;
  description?: string;
  status: "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "DONE";
  assignmentState?: "PENDING" | "ACCEPTED";
  blocked: boolean;
  ownerUserId: string;
  workId?: string;
  /** Agent 답이 실행 대화에 오면(차례 끝) 카드의 막힘을 이 값으로 — Agent 가 차례 안에서 block·unblock 을 한 것처럼. */
  blockedAfterTurn?: boolean;
}

interface FakeTodo {
  todoId: string;
  kind: string;
  cardUuid: string;
  commentId?: number;
  state: "OPEN" | "CLAIMED" | "DONE";
  note?: string;
}

/**
 * 가짜 서버 MCP 도구 레이어(메모리) — serve 가 부르는 도구만 서버 계약 모양으로 답한다. 부른 순서는 {@link calls}.
 */
export class FakeTools implements AgentTools {
  readonly calls: Array<{ tool: string; args: Record<string, unknown>; as?: string }> = [];
  readonly cards = new Map<string, FakeCard>();
  readonly todos: FakeTodo[] = [];
  readonly comments = new Map<string, Array<Record<string, unknown>>>();
  /** claim 을 거절할 할 일 → 오류 코드. */
  readonly claimRefusals = new Map<string, string>();
  /** claim 이 주는 임대 길이(ms). */
  claimMs = 30 * 60_000;
  /** renew 가 거절할 때의 오류 코드(없으면 허락). */
  renewError: string | undefined;
  /** 이 도구가 한 번 실패한다. */
  failOnce = new Map<string, string>();

  addCard(card: Partial<FakeCard> & { uuid: string }): FakeCard {
    const full: FakeCard = { key: "KAN-1", title: "카드", status: "TODO", assignmentState: "PENDING", blocked: false,
      ownerUserId: "user-owner", ...card };
    this.cards.set(full.uuid, full);
    return full;
  }

  addTodo(todoId: string, kind: string, cardUuid: string, commentId?: number): void {
    this.todos.push({ todoId, kind, cardUuid, state: "OPEN", ...(commentId !== undefined ? { commentId } : {}) });
  }

  tools(): string[] {
    return this.calls.map((c) => c.tool);
  }

  todo(todoId: string): FakeTodo | undefined {
    return this.todos.find((t) => t.todoId === todoId);
  }

  async list(): Promise<unknown[]> {
    return [];
  }

  async call(tool: string, args: Record<string, unknown>, options: AgentToolCallOptions = {}): Promise<Record<string, unknown>> {
    this.calls.push({ tool, args, ...(options.as ? { as: options.as } : {}) });
    const failure = this.failOnce.get(tool);
    if (failure) {
      this.failOnce.delete(tool);
      throw new AgentToolError(`${tool} failed`, tool, failure);
    }
    switch (tool) {
      case "list_agent_todos":
        return { items: this.todos.filter((t) => t.state === "OPEN").map((t) => ({ todoId: t.todoId, kind: t.kind, state: "OPEN",
          target: { type: "KANBAN_CARD", uuid: t.cardUuid, title: "카드", ...(t.commentId !== undefined ? { commentId: t.commentId } : {}) } })),
        hasMore: false };
      case "update_agent_todos":
        return { results: (args.items as Array<Record<string, unknown>>).map((item) => this.updateTodo(item)) };
      case "kanban_list_cards":
        return { cards: (args.cardUuids as string[]).map((uuid) => this.detail(this.card(uuid))) };
      case "kanban_card_action":
        return { card: this.detail(this.act(this.card(String(args.cardUuid)), String(args.action))) };
      case "start_work": {
        const card = this.card(String(args.cardUuid));
        card.workId ??= "work-started";
        return { workId: card.workId, name: card.title, status: "IN_PROGRESS" };
      }
      case "send_auto_run_message": {
        const card = this.card(String(args.cardUuid));
        if (card.blockedAfterTurn !== undefined && String(args.body).startsWith("got ")) card.blocked = card.blockedAfterTurn;
        return { conversationUuid: `conv-${card.uuid}`, messageUuid: `m-${this.calls.length}`, cardUuid: card.uuid, at: "2026-11-16T00:00:00Z" };
      }
      case "list_comments":
        return { comments: this.comments.get(String(args.cardUuid)) ?? [], count: 0 };
      case "create_comments":
        return { created: [{ id: 900 + this.calls.length }] };
      case "report_work_progress":
        return { workId: args.workId, checkId: `chk-${this.calls.length}` };
      default:
        throw new AgentToolError(`unknown tool ${tool}`, tool, "NOT_FOUND");
    }
  }

  private card(uuid: string): FakeCard {
    const card = this.cards.get(uuid);
    if (!card) throw new AgentToolError("card not found", "kanban_list_cards", "KANBAN_CARD_NOT_FOUND");
    return card;
  }

  private act(card: FakeCard, action: string): FakeCard {
    if (action === "accept") {
      card.assignmentState = "ACCEPTED";
      for (const t of this.todos) if (t.cardUuid === card.uuid && t.kind === "CARD_ASSIGNED") t.state = "DONE";
    } else if (action === "start") {
      card.status = "IN_PROGRESS";
      card.workId ??= "work-1";
    } else if (action === "request_review") {
      card.status = "IN_REVIEW";
    } else if (action === "unblock") {
      card.blocked = false;
    }
    return card;
  }

  private detail(card: FakeCard): Record<string, unknown> {
    return {
      boardUuid: "board-1",
      card: { uuid: card.uuid, key: card.key, title: card.title, status: card.status, assignmentState: card.assignmentState,
        blocked: card.blocked, assignee: { userId: card.ownerUserId, name: "주인" } },
      description: card.description ?? null,
      criteria: [{ text: "끝나면 검토 요청", done: false }],
      work: card.workId ? { workId: card.workId, name: card.title, status: "IN_PROGRESS" } : null,
    };
  }

  private updateTodo(item: Record<string, unknown>): Record<string, unknown> {
    const todoId = String(item.todoId);
    const todo = this.todo(todoId);
    if (!todo) return { todoId, ok: false, error: "NOT_FOUND" };
    const expires = () => new Date(Date.now() + this.claimMs).toISOString();
    switch (item.action) {
      case "claim": {
        const refusal = this.claimRefusals.get(todoId);
        if (refusal) return { todoId, ok: false, error: refusal };
        if (todo.state !== "OPEN") return { todoId, ok: false, error: "CLAIMED_BY_OTHER" };
        todo.state = "CLAIMED";
        return { todoId, ok: true, state: "CLAIMED", leaseToken: `lease-${todoId}`, claimExpiresAt: expires() };
      }
      case "renew":
        if (this.renewError) return { todoId, ok: false, error: this.renewError };
        if (todo.state === "DONE") return { todoId, ok: false, error: "ALREADY_DONE" };
        return { todoId, ok: true, state: "CLAIMED", leaseToken: `lease-${todoId}`, claimExpiresAt: expires() };
      case "complete":
        if (todo.kind === "CARD_ASSIGNED") return { todoId, ok: false, error: "BUSINESS_ACTION_REQUIRED" };
        todo.state = "DONE";
        todo.note = typeof item.note === "string" ? item.note : undefined;
        return { todoId, ok: true, state: "DONE" };
      case "release":
        if (todo.state === "DONE") return { todoId, ok: false, error: "ALREADY_DONE" };
        todo.state = "OPEN";
        return { todoId, ok: true, state: "OPEN" };
      default:
        return { todoId, ok: false, error: "INVALID" };
    }
  }
}
