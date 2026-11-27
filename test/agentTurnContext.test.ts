import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCallError } from "../src/core/agent/http";
import { agentPromptText, turnContextIn, unreadLine } from "../src/core/agent/prompt";
import { sessionChange, withoutSecrets } from "../src/core/agent/serve";
import { agentOwner, AgentSessionMap, usableEntry } from "../src/core/agent/sessions";
import { codexSpawned, finish, logRecords, OWNER, spawned, startServe, until, type World } from "./support/agentServeWorld";

/**
 * Connect C2(설계 connect-agent-dedicated-session r3 §4 C2 자동 인수 조건) — offer 의 {@code turnContextAvailable} 이 있으면 turn-context 를 한 번 부르고,
 * «아직 받지 않은 글 N개» 한 줄(실제 turnUuid·readKey·since)을 요청 앞에 넣는다. 커서는 «확인된 세션»일 때만 싣고, DONE 일 때만 next 를 저장한다(CAS).
 */
const LINK = "11111111-1111-4111-8111-111111111111";
const file = (w: World) => JSON.parse(readFileSync(w.sessionsPath, "utf8")) as {
  conversations: Record<string, Record<string, unknown>>; byAgent: Record<string, Record<string, Record<string, unknown>>>;
};
const entry = (w: World, conv: string, agent?: string): Record<string, unknown> =>
  (agent ? file(w).byAgent[agent]?.[conv] : file(w).conversations[conv]) ?? {};
const cursors = (w: World) => w.server.turnContextCalls().map((c) => c.cursor);

describe("Connect C2 — turn-context · 새 글 알림 줄 · DONE 때만 커서", () => {
  it("옛 API(offer 에 turnContextAvailable 없음) → 끝점을 부르지 않고 지금 그대로 · 커서 없음", async () => {
    const w = startServe();
    w.server.offer("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(w.server.turnContextCalls()).toHaveLength(0);
    expect(String(reply.reply)).toMatch(/^got hello #1 in sess-\d+$/);
    expect(entry(w, "conv-a").cursor).toBeUndefined();
  });

  it("신 API + 신 CLI → 차례마다 한 번 · 처음엔 커서 null(since 없음) · 살아 있는 세션의 다음 차례는 저장한 커서와 since", async () => {
    const w = startServe();
    w.server.offerWithContext("t1", "conv-a", "hello");
    const first = await until(() => w.server.replies()[0]);
    w.server.offerWithContext("t2", "conv-a", "again");
    const second = await until(() => w.server.replies()[1]);
    await finish(w);

    expect(w.server.turnContextCalls()).toEqual([{ linkId: LINK, turnUuid: "t1", cursor: null }, { linkId: LINK, turnUuid: "t2", cursor: "cur-t1" }]);
    expect(String(first.reply)).toContain("[AiNecto chat] 2 message(s) in this conversation have not reached you yet (you have not seen this conversation before).");
    // ★가짜 Claude 는 받은 입력을 답 글로 되말한다 — 서버로 가는 답 글에는 읽기 열쇠가 없다(코드 리뷰 C2 P0-3 a)
    expect(String(first.reply)).toContain('execute_read {"operation":"chat_list_messages","args":{"turnUuid":"t1","readKey":"[readKey]"}}');
    expect(JSON.stringify(w.server.replies())).not.toContain("rk-t");
    expect(String(first.reply)).toMatch(/\n\nhello #1 in sess-\d+$/);
    expect(String(second.reply)).toContain("(written since your last answer here)");
    expect(String(second.reply)).toContain('{"operation":"chat_list_messages","args":{"turnUuid":"t2","readKey":"[readKey]","since":"cur-t1"}}');
    expect(spawned(w)).toHaveLength(1);
    expect(entry(w, "conv-a")).toMatchObject({ cursor: "cur-t2", owner: OWNER, rev: 2 });
  });

  it("count == 0 → 알림 줄 없음 — 입력이 옛 API 와 바이트까지 같다 · next 는 저장", async () => {
    const w = startServe();
    w.server.turnContext = (body) => ({ count: 0, first: false, since: "c0", pageSize: 10, next: `cur-${String(body.turnUuid)}`, readKey: "rk" });
    w.server.offerWithContext("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(String(reply.reply)).toMatch(/^got hello #1 in sess-\d+$/);
    expect(entry(w, "conv-a").cursor).toBe("cur-t1");
    const zero = unreadLine("t1", { count: 0, first: true, pageSize: 10, next: "n", readKey: "k" });
    expect(zero).toBeUndefined();
    expect(agentPromptText("hello", undefined, zero)).toBe(agentPromptText("hello", undefined));
  });

  it("거절(진행 중 아님 · link 를 잊음 · 열람 권한 403) → 그 차례는 돌리지 않고 FAILED · serve 는 멈추지 않는다", async () => {
    const w = startServe();
    const refusals = [
      new AgentCallError("That request is not running on this PC now.", "turn-context", 404, "AGENT_TURN_NOT_RUNNING"),
      new AgentCallError("No such agent link.", "turn-context", 404, "LINK_NOT_FOUND"),
      new AgentCallError("Workspace is not readable", "turn-context", 403, "FORBIDDEN"),
    ];
    const base = w.server.turnContext;
    w.server.turnContext = (body) => refusals.shift() ?? base(body);
    w.server.offerWithContext("t1", "conv-a", "one");
    w.server.offerWithContext("t2", "conv-a", "two");
    w.server.offerWithContext("t3", "conv-a", "three");
    w.server.offerWithContext("t4", "conv-a", "four");
    const replies = await until(() => (w.server.replies().length === 4 ? w.server.replies() : undefined));
    const result = await finish(w);

    expect(replies.slice(0, 3).map((r) => [r.turnUuid, r.status, r.errorCode])).toEqual([
      ["t1", "FAILED", "AGENT_INTERNAL"], ["t2", "FAILED", "AGENT_INTERNAL"], ["t3", "FAILED", "AGENT_INTERNAL"]]);
    expect(String(replies[0]?.reply)).toContain("AGENT_TURN_NOT_RUNNING");
    expect(String(replies[2]?.reply)).toContain("FORBIDDEN");
    expect(String(replies[3]?.reply)).toMatch(/four #1 in sess-/);   // 거절된 셋은 Agent 에 들어가지 않았다
    expect(result).toEqual({ exitCode: 0, reason: "signal" });
    expect(entry(w, "conv-a")).toMatchObject({ cursor: "cur-t4", rev: 1 });
  });

  it("네트워크·5xx → 알림 줄 없이 돌린다 · next 가 없으니 커서는 그대로(없던 채로)", async () => {
    const w = startServe();
    w.server.turnContext = () => new AgentCallError("upstream", "turn-context", 503, "UNAVAILABLE");
    w.server.offerWithContext("t1", "conv-a", "hello");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(reply.status).toBe("DONE");
    expect(String(reply.reply)).toMatch(/^got hello #1 in sess-\d+$/);
    expect(entry(w, "conv-a").cursor).toBeUndefined();
    expect(entry(w, "conv-a").owner).toBe(OWNER);
  });

  it("FAILED · STOPPED · 기한 초과 → 커서 그대로 · 기한 뒤 새로 띄운 Claude(--resume)는 확인 전이라 처음 규칙(null)", async () => {
    const w = startServe({ turnTimeoutMs: 1_500 });
    w.server.offerWithContext("t1", "conv-a", "hello");
    const done = await until(() => w.server.replies()[0]);
    w.server.offerWithContext("t2", "conv-a", "bad-schema");
    const failed = await until(() => w.server.replies()[1]);
    expect(entry(w, "conv-a")).toMatchObject({ cursor: "cur-t1", rev: 2 });
    w.server.offerWithContext("t3", "conv-a", "hang");
    await until(() => w.server.turnContextCalls()[2]);
    await new Promise((r) => setTimeout(r, 150));
    w.server.push({ state: "OPEN", offers: [], stops: ["t3"] });
    const stopped = await until(() => w.server.replies()[2]);
    expect(entry(w, "conv-a")).toMatchObject({ cursor: "cur-t1", rev: 3 });
    w.server.offerWithContext("t4", "conv-a", "hang");
    const timedOut = await until(() => w.server.replies()[3]);
    w.server.offerWithContext("t5", "conv-a", "after");
    const after = await until(() => w.server.replies()[4]);
    await finish(w);

    expect([done.status, failed.status, stopped.status, timedOut.errorCode, after.status]).toEqual(["DONE", "FAILED", "STOPPED", "TURN_TIMEOUT", "DONE"]);
    const sessionId = /in (sess-\d+)$/.exec(String(done.reply))?.[1];
    expect(spawned(w)).toEqual([[], ["--resume", sessionId]]);
    expect(cursors(w)).toEqual([null, "cur-t1", "cur-t1", "cur-t1", null]);
    expect(entry(w, "conv-a")).toMatchObject({ sessionId, cursor: "cur-t5", owner: OWNER });
  });

  it("계정이 바뀜(칸의 owner 가 다름) → 재개 값·커서를 함께 쓰지 않는다 · 새 주인으로 다시 쓴다", async () => {
    const w = startServe({ sessionsFile: { version: 2,
      conversations: { "conv-a": { sessionId: "sess-old", cursor: "cur-old", owner: "https://other.test u-9", rev: 4 } } } });
    w.server.offerWithContext("t1", "conv-a", "hello");
    await until(() => w.server.replies()[0]);
    await finish(w);
    expect(spawned(w)).toEqual([[]]);
    expect(cursors(w)).toEqual([null]);
    expect(entry(w, "conv-a")).toMatchObject({ cursor: "cur-t1", owner: OWNER, rev: 5 });
    expect(entry(w, "conv-a").sessionId).not.toBe("sess-old");
  });

  it("옛 CLI 가 다시 쓴 칸(rev·cursor·owner 없음) → 재개는 예전대로 · 커서 없음 = 처음 규칙 · 주인을 모르면 살아 있는 세션도 커서 없음", async () => {
    const w = startServe({ sessionsFile: { version: 2, conversations: { "conv-a": { sessionId: "sess-old", updatedAt: "x" } } } });
    w.server.offerWithContext("t1", "conv-a", "hello");
    await until(() => w.server.replies()[0]);
    await finish(w);
    expect(spawned(w)).toEqual([["--resume", "sess-old"]]);
    expect(cursors(w)).toEqual([null]);
    expect(entry(w, "conv-a")).toMatchObject({ sessionId: "sess-old", cursor: "cur-t1", rev: 1 });

    const unknown = startServe({ owner: null });
    unknown.server.offerWithContext("t1", "conv-a", "one");
    await until(() => unknown.server.replies()[0]);
    unknown.server.offerWithContext("t2", "conv-a", "two");
    await until(() => unknown.server.replies()[1]);
    await finish(unknown);
    expect(cursors(unknown)).toEqual([null, null]);
    expect(entry(unknown, "conv-a").owner).toBeUndefined();
  });

  it("차례 사이에 다른 작성자가 그 칸을 바꿨다(rev 다름) → 이 차례의 쓰기는 버리고 로그 한 줄 · ★다음 차례는 옛 자식이 아니라 파일의 승자로", async () => {
    const w = startServe();
    const base = w.server.turnContext;
    w.server.turnContext = (body) => {
      if (body.turnUuid === "t1") {
        writeFileSync(w.sessionsPath, JSON.stringify({ version: 2, conversations: { "conv-a": { sessionId: "sess-other", cursor: "cur-other", owner: OWNER, rev: 7 } } }));
      }
      return base(body);
    };
    w.server.offerWithContext("t1", "conv-a", "hello");
    await until(() => w.server.replies()[0]);
    expect(entry(w, "conv-a")).toMatchObject({ sessionId: "sess-other", cursor: "cur-other", rev: 7 });
    w.server.offerWithContext("t2", "conv-a", "again");
    const second = await until(() => w.server.replies()[1]);
    await finish(w);
    expect(logRecords(w).filter((r) => r.event === "agent_session_unwritten")).toEqual([
      expect.objectContaining({ turnUuid: "t1", agent: "claude-code", conversationUuid: "conv-a", expectedRev: 0, change: "set", reason: "stale" })]);
    expect(spawned(w)).toEqual([[], ["--resume", "sess-other"]]);   // 옛 자식을 다시 쓰지 않고 승자로 다시 연다
    expect(String(second.reply)).toMatch(/again #1 in sess-other$/);
    expect(cursors(w)).toEqual([null, null]);   // 새로 띄운 Claude 는 확인 전 — 처음 규칙
    expect(entry(w, "conv-a")).toMatchObject({ sessionId: "sess-other", cursor: "cur-t2", rev: 8 });
  });

  it("Codex: thread/resume 응답의 id 가 칸과 같으면 확인됨 → 커서를 싣는다 · ★부르는 때는 resume 응답 뒤 · turn/start 전", async () => {
    const w = startServe({ installed: ["codex"], sessionsFile: { version: 2, conversations: {},
      byAgent: { codex: { "conv-a": { sessionId: "thr-A", cursor: "cur-old", owner: OWNER, rev: 1 } } } } });
    const base = w.server.turnContext;
    let rpcAtCall: string[] = [];
    w.server.turnContext = (body) => {
      rpcAtCall = logRecords(w).filter((r) => r.event === "agent_rpc" || r.event === "agent_rpc_response").map((r) => `${String(r.event)} ${String(r.method)}`);
      return base(body);
    };
    w.server.offerWithContext("t1", "conv-a", "hello", "codex");
    const reply = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(cursors(w)).toEqual(["cur-old"]);
    expect(rpcAtCall).toContain("agent_rpc_response thread/resume");
    expect(rpcAtCall.some((line) => line.endsWith(" turn/start"))).toBe(false);
    expect(String(reply.reply)).toContain('"since":"cur-old"');
    expect(entry(w, "conv-a", "codex")).toMatchObject({ sessionId: "thr-A", cursor: "cur-t1", rev: 2 });
  });

  it("Codex: thread/resume 이 다른 id 로 이어지면 → 처음 규칙(null) · next 는 새 thread 와 짝", async () => {
    const w = startServe({ installed: ["codex"], env: { FAKE_CODEX_RESUME_AS: "thr-B" }, sessionsFile: { version: 2, conversations: {},
      byAgent: { codex: { "conv-a": { sessionId: "thr-A", cursor: "cur-old", owner: OWNER, rev: 1 } } } } });
    w.server.offerWithContext("t1", "conv-a", "hello", "codex");
    await until(() => w.server.replies()[0]);
    await finish(w);
    expect(cursors(w)).toEqual([null]);
    expect(entry(w, "conv-a", "codex")).toMatchObject({ sessionId: "thr-B", cursor: "cur-t1", rev: 2 });
  });

  it("Antigravity: 차례마다 agy -p 를 새로 띄우므로 ★늘 처음 규칙(null) — 앞 프로세스가 밝힌 id 는 이번 프로세스의 확인이 아니다", async () => {
    const w = startServe({ installed: ["antigravity"] });
    w.server.offerWithContext("t1", "conv-a", "hello", "antigravity");
    await until(() => w.server.replies()[0]);
    const stored = entry(w, "conv-a", "antigravity");
    w.server.offerWithContext("t2", "conv-a", "again", "antigravity");
    await until(() => w.server.replies()[1]);
    await finish(w);
    expect(stored).toMatchObject({ cursor: "cur-t1", rev: 1 });
    expect(cursors(w)).toEqual([null, null]);

    const fresh = startServe({ installed: ["antigravity"], sessionsFile: { version: 2, conversations: {},
      byAgent: { antigravity: { "conv-a": { ...stored } } } } });
    fresh.server.offerWithContext("t3", "conv-a", "later", "antigravity");
    await until(() => fresh.server.replies()[0]);
    await finish(fresh);
    expect(cursors(fresh)).toEqual([null]);
  });
});

describe("sessions.json 칸 — 잠금 안 CAS(rev)", () => {
  const path = () => join(mkdtempSync(join(tmpdir(), "agent-sessions-cas-")), "sessions.json");

  it("같은 칸 두 작성자(커서 10 에서 30 → 20) → 뒤의 것은 버린다 · 옛 serve 의 forget 도 새 칸을 지우지 못한다 · 다른 칸·모르는 칸은 그대로", async () => {
    const p = path();
    writeFileSync(p, JSON.stringify({ version: 2, extra: { keep: true }, conversations: { "conv-b": { sessionId: "sess-b", updatedAt: "x" } },
      byAgent: { codex: { "conv-a": { sessionId: "S", cursor: "10", owner: OWNER, rev: 1 } } } }));
    const a = new AgentSessionMap(p);
    const b = new AgentSessionMap(p);
    const seenA = await a.read({ conversationUuid: "conv-a" }, "codex");
    const seenB = await b.read({ conversationUuid: "conv-a" }, "codex");
    expect(seenA).toEqual({ entry: { sessionId: "S", cursor: "10", owner: OWNER }, rev: 1 });
    expect(await a.write({ conversationUuid: "conv-a" }, "codex", seenA.rev, { sessionId: "S", cursor: "30", owner: OWNER })).toBe("written");
    expect(await b.write({ conversationUuid: "conv-a" }, "codex", seenB.rev, { sessionId: "S", cursor: "20", owner: OWNER })).toBe("stale");
    expect(await b.write({ conversationUuid: "conv-a" }, "codex", seenB.rev, undefined)).toBe("stale");
    const after = JSON.parse(readFileSync(p, "utf8"));
    expect(after.byAgent.codex["conv-a"]).toMatchObject({ sessionId: "S", cursor: "30", rev: 2 });
    expect(after.conversations["conv-b"]).toEqual({ sessionId: "sess-b", updatedAt: "x" });
    expect(after.extra).toEqual({ keep: true });
  });

  it("★지워도 세대가 남는다 — 옛 칸(rev 1)을 읽은 늦은 작성자는 지운 뒤 새로 쓴 칸(rev 1 아님)을 덮지도 지우지도 못한다(코드 리뷰 C2 P1-2)", async () => {
    const p = path();
    writeFileSync(p, JSON.stringify({ version: 2, conversations: { "conv-a": { sessionId: "OLD", cursor: "10", owner: OWNER, rev: 1 } } }));
    const late = new AgentSessionMap(p);
    const other = new AgentSessionMap(p);
    const seenLate = await late.read({ conversationUuid: "conv-a" }, "claude-code");
    expect(await other.write({ conversationUuid: "conv-a" }, "claude-code", 1, undefined)).toBe("written");
    expect(await other.read({ conversationUuid: "conv-a" }, "claude-code")).toEqual({ rev: 2 });
    expect(await other.write({ conversationUuid: "conv-a" }, "claude-code", 2, { sessionId: "NEW", cursor: "30", owner: OWNER })).toBe("written");
    expect(await late.write({ conversationUuid: "conv-a" }, "claude-code", seenLate.rev, { sessionId: "OLD", cursor: "20", owner: OWNER })).toBe("stale");
    expect(await late.write({ conversationUuid: "conv-a" }, "claude-code", seenLate.rev, undefined)).toBe("stale");
    expect(JSON.parse(readFileSync(p, "utf8")).conversations["conv-a"]).toMatchObject({ sessionId: "NEW", cursor: "30", rev: 3 });
  });

  it("파일을 읽지 못하면(ENOENT 밖 — 권한) 쓰지 않고 던진다 · 다른 대화의 칸이 그대로 남는다(코드 리뷰 C2 P2-1)", async () => {
    const p = path();
    const original = JSON.stringify({ version: 2, conversations: { "conv-old": { sessionId: "KEEP", updatedAt: "x" } } });
    writeFileSync(p, original);
    chmodSync(p, 0o000);
    try {
      const map = new AgentSessionMap(p);
      await expect(map.read({ conversationUuid: "conv-new" }, "claude-code")).rejects.toThrow();
      await expect(map.write({ conversationUuid: "conv-new" }, "claude-code", 0, { sessionId: "S" })).rejects.toThrow();
    } finally {
      chmodSync(p, 0o600);
    }
    expect(readFileSync(p, "utf8")).toBe(original);
    expect(await new AgentSessionMap(join(p, "..", "missing.json")).read({ conversationUuid: "c" }, "claude-code")).toEqual({ rev: 0 });
  });
});

describe("C2 순수 함수", () => {
  const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

  it("agentOwner — 로그인 토큰(JWT)의 sub + 서버 주소 · 읽지 못하면 undefined", () => {
    expect(agentOwner("https://dev.ainecto.com", jwt({ sub: "u-1" }))).toBe("https://dev.ainecto.com u-1");
    expect(agentOwner("https://ainecto.com", jwt({ sub: "u-1" }))).not.toBe(agentOwner("https://dev.ainecto.com", jwt({ sub: "u-1" })));
    expect(agentOwner("e", jwt({ sub: "" }))).toBeUndefined();
    expect(agentOwner("e", "opaque-token")).toBeUndefined();
    expect(agentOwner("e", "a.!!!.b")).toBeUndefined();
    expect(agentOwner("e", undefined)).toBeUndefined();
  });

  it("usableEntry — 둘 다 알려진 주인이 다를 때만 버린다", () => {
    const e = { sessionId: "s", cursor: "c", owner: "o1" };
    expect(usableEntry(e, "o2")).toBeUndefined();
    expect(usableEntry(e, "o1")).toBe(e);
    expect(usableEntry(e, undefined)).toBe(e);
    expect(usableEntry({ sessionId: "s" }, "o1")).toEqual({ sessionId: "s" });
  });

  it("turnContextIn — 꼴이 어긋난 답은 undefined(알림 없이 · 커서 그대로)", () => {
    const ok = { count: 3, first: false, since: "c", pageSize: 10, next: "n", readKey: "k" };
    expect(turnContextIn(ok)).toEqual(ok);
    expect(turnContextIn({ ...ok, since: null, first: true })).toEqual({ count: 3, first: true, pageSize: 10, next: "n", readKey: "k" });
    expect(turnContextIn({ ...ok, count: -1 })).toBeUndefined();
    expect(turnContextIn({ ...ok, next: "" })).toBeUndefined();
    expect(turnContextIn({ ...ok, readKey: undefined })).toBeUndefined();
    expect(turnContextIn({ ...ok, since: 3 })).toBeUndefined();
  });

  it("sessionChange — DONE 만 next · 그 밖엔 같은 세션 id 일 때만 커서를 지킨다 · 재개 세션이 끝나면 칸을 지운다", () => {
    const stored = { sessionId: "s1", cursor: "c1", owner: "o" };
    const base = { outcome: "result" as const, resumed: true, sessionRef: "s1", next: "n2", entry: stored, owner: "o" };
    expect(sessionChange({ ...base, status: "DONE" })).toEqual({ kind: "write", next: { sessionId: "s1", cursor: "n2", owner: "o" } });
    expect(sessionChange({ ...base, status: "FAILED" })).toEqual({ kind: "write", next: { sessionId: "s1", cursor: "c1", owner: "o" } });
    expect(sessionChange({ ...base, status: "STOPPED", next: undefined })).toEqual({ kind: "write", next: { sessionId: "s1", cursor: "c1", owner: "o" } });
    expect(sessionChange({ ...base, status: "FAILED", sessionRef: "s2" })).toEqual({ kind: "write", next: { sessionId: "s2", owner: "o" } });
    expect(sessionChange({ ...base, status: "DONE", sessionRef: "s2" })).toEqual({ kind: "write", next: { sessionId: "s2", cursor: "n2", owner: "o" } });
    expect(sessionChange({ ...base, status: "DONE", next: undefined, owner: undefined })).toEqual({ kind: "write", next: { sessionId: "s1", cursor: "c1" } });
    expect(sessionChange({ ...base, outcome: "timeout", status: "FAILED" })).toEqual({ kind: "write", next: undefined });
    expect(sessionChange({ ...base, outcome: "exited", resumed: false, status: "FAILED" })).toEqual({ kind: "keep" });
    expect(sessionChange({ ...base, outcome: "refused", status: "FAILED" })).toEqual({ kind: "keep" });
    expect(sessionChange({ ...base, sessionRef: undefined, status: "DONE" })).toEqual({ kind: "keep" });
  });
});

describe("Connect C2 r2 — 코드 리뷰 NO-GO 반례(connect-c2-code-review-astra62)", () => {
  const marker = () => join(mkdtempSync(join(tmpdir(), "codex-hold-")), "hold");

  it("P0-1 · 열람 403(turn-context 와 reply 둘 다) → 그 차례만 버리고 같은 연결에서 다음 차례 · serve 는 auth 로 멈추지 않는다", async () => {
    const w = startServe();
    const base = w.server.turnContext;
    const forbidden = () => new AgentCallError("User not authorized for workspace", "turn-context", 403);
    w.server.turnContext = (body) => (body.turnUuid === "t1" ? forbidden() : base(body));
    w.server.replyError = (body) => (body.turnUuid === "t1" ? new AgentCallError("User not authorized for workspace", "reply", 403) : undefined);
    w.server.offerWithContext("t1", "conv-a", "one");
    w.server.offerWithContext("t2", "conv-a", "two");
    const second = await until(() => w.server.replies()[1]);
    const result = await finish(w);
    expect(w.server.replies()[0]).toMatchObject({ turnUuid: "t1", status: "FAILED" });
    expect(second).toMatchObject({ turnUuid: "t2", status: "DONE" });
    expect(result).toEqual({ exitCode: 0, reason: "signal" });
  });

  it("P0-1 · 401 은 어디서든 로그인 거절 — turn-context 401 이면 serve 가 auth 로 멈춘다", async () => {
    const w = startServe();
    w.server.turnContext = () => new AgentCallError("invalid_token", "turn-context", 401);
    w.server.offerWithContext("t1", "conv-a", "one");
    const result = await w.done;
    expect(result).toEqual({ exitCode: 1, reason: "auth" });
  });

  it("P0-2 · Codex 준비(thread/start)가 답하지 않으면 → 차례 기한 안에 TURN_TIMEOUT · turn-context 0 · 다음 요청은 새 프로세스로", async () => {
    const hold = marker();
    writeFileSync(hold, "");
    const w = startServe({ installed: ["codex"], env: { FAKE_CODEX_HOLD_THREAD: hold }, turnTimeoutMs: 500 });
    const t0 = Date.now();
    w.server.offerWithContext("t1", "conv-a", "hello", "codex");
    const timedOut = await until(() => w.server.replies()[0]);
    const elapsed = Date.now() - t0;
    w.server.offerWithContext("t2", "conv-a", "again", "codex");
    const next = await until(() => w.server.replies()[1]);
    await finish(w);
    expect(timedOut).toMatchObject({ status: "FAILED", errorCode: "TURN_TIMEOUT" });
    expect(elapsed).toBeLessThan(3_000);
    expect(next.status).toBe("DONE");
    expect(w.server.turnContextCalls().map((c) => c.turnUuid)).toEqual(["t2"]);
  });

  it("P0-2 · Codex 준비 중 웹 «중단» → 바로 STOPPED · 자식을 내리고 큐가 나아간다 · 재개 값은 그대로(표지 있음·없음 둘 다)", async () => {
    for (const flagged of [true, false]) {
      const hold = marker();
      writeFileSync(hold, "");
      const w = startServe({ installed: ["codex"], env: { FAKE_CODEX_HOLD_THREAD: hold }, sessionsFile: { version: 2, conversations: {},
        byAgent: { codex: { "conv-a": { sessionId: "thr-A", cursor: "cur-old", owner: OWNER, rev: 1 } } } } });
      if (flagged) w.server.offerWithContext("t1", "conv-a", "hello", "codex");
      else w.server.offer("t1", "conv-a", "hello", undefined, "codex");
      await until(() => logRecords(w).find((r) => r.event === "agent_rpc" && (r.method === "thread/resume")));
      const t0 = Date.now();
      w.server.push({ state: "OPEN", offers: [], stops: ["t1"] });
      const stopped = await until(() => w.server.replies()[0]);
      const elapsed = Date.now() - t0;
      w.server.offer("t2", "conv-a", "again", undefined, "codex");
      const next = await until(() => w.server.replies()[1]);
      await finish(w);
      expect(stopped).toMatchObject({ turnUuid: "t1", status: "STOPPED" });
      expect(elapsed).toBeLessThan(3_000);
      expect(next.status).toBe("DONE");
      expect(String(next.reply)).toMatch(/in thr-A$/);   // 재개 값 thr-A 그대로 — 새 프로세스가 그것으로 이어 간다
      expect(w.server.turnContextCalls()).toHaveLength(0);
    }
  });

  it("P0-3 a · 답 글의 읽기 열쇠는 보내기 전에 가린다(Agent 가 되말한 것 · stderr 에 실린 것 모두) — 순수 함수", () => {
    const reply = { status: "FAILED" as const, reply: "args rk-1 … stderr: readKey=rk-1", documentUuids: [] };
    expect(withoutSecrets(reply, ["rk-1"]).reply).toBe("args [readKey] … stderr: readKey=[readKey]");
    expect(withoutSecrets(reply, [])).toBe(reply);
    expect(withoutSecrets(reply, [""])).toBe(reply);
  });

  it("P1-4 · 주인 조회가 실패해도 차례는 돈다(구 API 경로) — 재개 값·커서 없이 · 로그 한 줄", async () => {
    let calls = 0;
    const w = startServe({ owner: async () => {
      calls += 1;
      if (calls === 1) throw new Error("token refresh failed");
      return OWNER;
    } });
    w.server.offer("t1", "conv-a", "one");
    const first = await until(() => w.server.replies()[0]);
    await finish(w);
    expect(first.status).toBe("DONE");
    expect(logRecords(w).filter((r) => r.event === "agent_owner_unknown")).toHaveLength(1);
  });

  it("r2 P0-2 · 주인을 확인 못 한 차례는 sessions.json 을 건드리지 않는다 — rev 3 칸이 그대로 · 다음 정상 차례는 원래 세션으로 재개", async () => {
    let calls = 0;
    const original = { sessionId: "sess-orig", cursor: "cur-orig", owner: OWNER, rev: 3 };
    const w = startServe({ owner: async () => {
      calls += 1;
      if (calls === 1) throw new Error("token refresh failed");
      return OWNER;
    }, sessionsFile: { version: 2, conversations: { "conv-a": original } } });
    w.server.offerWithContext("t1", "conv-a", "one");
    const first = await until(() => w.server.replies()[0]);
    expect(first.status).toBe("DONE");
    expect(entry(w, "conv-a")).toMatchObject(original);   // 쓰기 0
    w.server.offerWithContext("t2", "conv-a", "two");
    const second = await until(() => w.server.replies()[1]);
    await finish(w);
    expect(spawned(w)).toEqual([[], ["--resume", "sess-orig"]]);
    expect(String(second.reply)).toMatch(/two #1 in sess-orig$/);
    expect(cursors(w)).toEqual([null, null]);
    expect(entry(w, "conv-a")).toMatchObject({ sessionId: "sess-orig", cursor: "cur-t2", owner: OWNER, rev: 4 });
  });

  it("r2 P0-2 · 계정이 바뀐 재연결의 첫 조회가 실패해도 앞 계정의 주인을 새 칸에 쓰지 않는다(캐시 없음)", async () => {
    const answers: Array<string | Error> = ["https://dev.ainecto.test acct-1", new Error("token refresh failed")];
    const otherEntry = { sessionId: "sess-b", cursor: "cur-b", owner: "https://dev.ainecto.test acct-2", rev: 2 };
    const w = startServe({ owner: async () => {
      const next = answers.shift() ?? "https://dev.ainecto.test acct-2";
      if (next instanceof Error) throw next;
      return next;
    }, sessionsFile: { version: 2, conversations: { "conv-b": otherEntry } } });
    w.server.offer("t1", "conv-a", "one");
    await until(() => w.server.replies()[0]);
    w.server.offer("t2", "conv-b", "two");
    await until(() => w.server.replies()[1]);
    await finish(w);
    expect(entry(w, "conv-b")).toMatchObject(otherEntry);
    expect(entry(w, "conv-a").owner).toBe("https://dev.ainecto.test acct-1");
  });

  it("r2 P0-1 · 저장된 thread 없이 첫 Codex 차례를 준비 중 멈추면(자식 정리 650ms) → 다음 요청은 새 자식에서 DONE(표지 있음·없음)", async () => {
    for (const flagged of [true, false]) {
      const hold = marker();
      writeFileSync(hold, "");
      const w = startServe({ installed: ["codex"], env: { FAKE_CODEX_HOLD_THREAD: hold, FAKE_CODEX_EXIT_DELAY_MS: "650" } });
      if (flagged) w.server.offerWithContext("t1", "conv-a", "hello", "codex");
      else w.server.offer("t1", "conv-a", "hello", undefined, "codex");
      await until(() => logRecords(w).find((r) => r.event === "agent_rpc" && r.method === "thread/start"));
      w.server.push({ state: "OPEN", offers: [], stops: ["t1"] });
      const stopped = await until(() => w.server.replies()[0]);
      if (flagged) w.server.offerWithContext("t2", "conv-a", "again", "codex");
      else w.server.offer("t2", "conv-a", "again", undefined, "codex");
      const next = await until(() => w.server.replies()[1]);
      await finish(w);
      expect(stopped).toMatchObject({ turnUuid: "t1", status: "STOPPED" });
      expect(next).toMatchObject({ turnUuid: "t2", status: "DONE" });
      expect(codexSpawned(w)).toHaveLength(2);
      expect(logRecords(w).filter((r) => r.event === "agent_rpc" && r.method === "turn/start")).toHaveLength(1);
    }
  });

  it("r2 P1-2 · 알림 조회 중 차례 기한이 끝나면 조회를 끊고 Agent 에 입력을 넣지 않는다(TURN_TIMEOUT · turn/start 0)", async () => {
    const w = startServe({ installed: ["codex"], turnTimeoutMs: 400 });
    w.server.turnContextDelayMs = 1_500;
    const t0 = Date.now();
    w.server.offerWithContext("t1", "conv-a", "hello", "codex");
    const timedOut = await until(() => w.server.replies()[0]);
    const elapsed = Date.now() - t0;
    await finish(w);
    expect(timedOut).toMatchObject({ status: "FAILED", errorCode: "TURN_TIMEOUT" });
    expect(elapsed).toBeLessThan(1_400);
    expect(logRecords(w).filter((r) => r.event === "agent_rpc" && r.method === "turn/start")).toHaveLength(0);
  });

  it.each(["stop", "timeout", "late-403"] as const)("r3 P0-1 · 입력 전에 끝난 차례(%s)는 재개 칸을 그대로 둔다 → 다음 차례가 원래 thread·커서로 DONE", async (variant) => {
    {
      const original = { sessionId: "thr-A", cursor: "cur-old", owner: OWNER, rev: 3 };
      const w = startServe({ installed: ["codex"], turnTimeoutMs: 600, sessionsFile: { version: 2, conversations: {},
        byAgent: { codex: { "conv-a": original } } } });
      w.server.turnContextDelayMs = 1_050;
      if (variant === "late-403") {
        const base = w.server.turnContext;
        w.server.turnContext = (body) => (body.turnUuid === "t1" ? new AgentCallError("forbidden", "turn-context", 403) : base(body));
      }
      w.server.offerWithContext("t1", "conv-a", "hello", "codex");
      await until(() => w.server.turnContextCalls()[0]);
      if (variant === "stop") w.server.push({ state: "OPEN", offers: [], stops: ["t1"] });
      const first = await until(() => w.server.replies()[0]);
      expect(first.status, variant).toBe(variant === "stop" ? "STOPPED" : "FAILED");
      if (variant !== "stop") expect(first.errorCode, variant).toBe("TURN_TIMEOUT");
      expect(entry(w, "conv-a", "codex"), variant).toMatchObject(original);   // 입력 전 종료 — 칸 그대로
      w.server.turnContextDelayMs = 0;
      w.server.offerWithContext("t2", "conv-a", "again", "codex");
      const second = await until(() => w.server.replies()[1]);
      await finish(w);
      expect(second.status, variant).toBe("DONE");
      expect(String(second.reply), variant).toMatch(/in thr-A$/);
      expect(cursors(w), variant).toEqual(["cur-old", "cur-old"]);
      expect(entry(w, "conv-a", "codex"), variant).toMatchObject({ sessionId: "thr-A", cursor: "cur-t2", rev: 4 });
      expect(logRecords(w).filter((r) => r.event === "agent_rpc" && r.method === "turn/start"), variant).toHaveLength(1);
    }
  });

  it("r4 P1 · 프롬프트를 조립하는 사이 기한이 지나면 → 입력 0(turn/start 0) · TURN_TIMEOUT · 재개 칸 그대로", async () => {
    const original = { sessionId: "thr-A", cursor: "cur-old", owner: OWNER, rev: 3 };
    const w = startServe({ installed: ["codex"], turnTimeoutMs: 5_000, sessionsFile: { version: 2, conversations: {},
      byAgent: { codex: { "conv-a": original } } } });
    const realNow = Date.now.bind(Date);
    const clock = vi.spyOn(Date, "now");
    try {
      // 맥락의 project 를 읽는 순간(= 조립 중) 다음 시계 읽기 한 번이 기한을 넘긴다 — 결정적으로 «조립 중 기한 초과»
      // (한 번만 — 시험의 until 기한·로그 시각은 실제 시계 그대로)
      const context = { get project() {
        clock.mockImplementationOnce(() => realNow() + 60_000);
        return undefined;
      } };
      w.server.push({ state: "OPEN", offers: [{ turnUuid: "t1", conversationUuid: "conv-a", text: "hello", agent: "codex", context,
        turnContextAvailable: true }] });
      const timedOut = await until(() => w.server.replies()[0]);
      clock.mockRestore();
      await finish(w);
      expect(timedOut).toMatchObject({ status: "FAILED", errorCode: "TURN_TIMEOUT" });
      expect(logRecords(w).filter((r) => r.event === "agent_rpc" && r.method === "turn/start")).toHaveLength(0);
      expect(entry(w, "conv-a", "codex")).toMatchObject(original);
    } finally {
      clock.mockRestore();
    }
  });

  it("r3 P1-1 · 주인을 묻는 사이 serve 가 멈추면 → 조회 0 · 입력 0 · sessions.json 쓰기 0", async () => {
    let release: () => void = () => {};
    const asked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let called = false;
    const w = startServe({ owner: async () => {
      called = true;
      await asked;
      return OWNER;
    } });
    w.server.offerWithContext("t1", "conv-a", "hello");
    await until(() => (called ? true : undefined));
    w.stop.abort();
    release();
    const result = await w.done;
    expect(result).toEqual({ exitCode: 0, reason: "signal" });
    expect(w.server.turnContextCalls()).toHaveLength(0);
    expect(spawned(w)).toHaveLength(0);
    expect(existsSync(w.sessionsPath)).toBe(false);
  });

  it("P1-6 · Chat 차례는 큐에서 나온 뒤 서버 답 처리가 끝날 때까지 «작업 중» — 알림 조회 중·답 보내는 중 모두", async () => {
    const w = startServe();
    const seen: boolean[] = [];
    const base = w.server.turnContext;
    w.server.turnContext = (body) => {
      seen.push(w.busy());
      return base(body);
    };
    w.server.onReply = () => {
      seen.push(w.busy());
    };
    expect(w.busy()).toBe(false);
    w.server.offerWithContext("t1", "conv-a", "hello");
    await until(() => w.server.replies()[0]);
    await until(() => (w.busy() ? undefined : true));
    await finish(w);
    expect(seen).toEqual([true, true]);
  });
});
