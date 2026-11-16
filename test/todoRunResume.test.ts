import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentLogRecord } from "../src/core/agent/log";
import { AgentRunLog } from "../src/core/agent/runs";
import { resumeTodo, runTodo, type AgentTodo } from "../src/core/agent/todoRun";
import { AgentToolError, type AgentTools } from "../src/core/agent/tools";
import { DaemonLog } from "../src/core/term/daemonLog";

const CARD = "5295f2c5814e4f7589a12992776cd30d";

/** 서버 카드 한 장(kanban_list_cards · kanban_card_action 의 모양). */
function cardDetail(card: Record<string, unknown>) {
  return { card: { uuid: CARD, key: "KAN-381", title: "확인", status: "IN_PROGRESS", assignmentState: "ACCEPTED", blocked: false,
    archived: false, ...card }, work: { workId: "w1" } };
}

/** 진짜 runs.json(임시 폴더) + 진짜 로그 — 서버 도구만 대본으로. */
async function world(answer: (tool: string, args: Record<string, unknown>) => Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "todo-run-"));
  const log = new DaemonLog<AgentLogRecord>(join(dir, "agent.log"), join(dir, "agent.log.1"));
  const runs = new AgentRunLog(join(dir, "runs.json"), log);
  await runs.load();
  await runs.started(CARD, "w1", "codex");
  const calls: string[] = [];
  const tools: AgentTools = {
    call: async (tool, args) => {
      calls.push(tool);
      return answer(tool, args);
    },
    list: async () => [],
  };
  const deps = {
    tools, log, textMaxCharacters: 4000, signal: new AbortController().signal,
    runs: { started: (c: string, w?: string) => runs.started(c, w, "codex"), finished: (c: string) => runs.finished(c) },
    runAgent: async () => ({ status: "DONE" as const, reply: "끝" }),
  };
  const left = () => (JSON.parse(readFileSync(join(dir, "runs.json"), "utf8")) as { runs: Array<{ cardUuid: string }> }).runs
    .map((r) => r.cardUuid);
  const results = () => readFileSync(join(dir, "agent.log"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "todo_run_result");
  return { deps, calls, left, results };
}

const resume: AgentTodo = resumeTodo({ cardUuid: CARD, workId: "w1" });

describe("다시 켜서 잇기(runs.json) — 서버가 끝낸 실행은 남기지 않는다", () => {
  it("보관된 카드는 잇지 않고 줄을 지운다", async () => {
    const w = await world((tool) => {
      if (tool === "kanban_list_cards") return { cards: [cardDetail({ archived: true })] };
      throw new Error(`unexpected ${tool}`);
    });
    await expect(runTodo(w.deps, resume)).resolves.toBe("not_runnable");
    expect(w.calls).toEqual(["kanban_list_cards"]);
    expect(w.left()).toEqual([]);
  });

  it("★서버 거절(재시도 불가 — AUTO_RUN_NOT_FOUND)로 끝나면 줄을 지우고 결과 줄에 남긴다", async () => {
    const w = await world((tool) => {
      if (tool === "kanban_list_cards") return { cards: [cardDetail({})] };
      if (tool === "send_auto_run_message") {
        throw new AgentToolError("AUTO_RUN_NOT_FOUND: no auto-run conversation", tool, "AUTO_RUN_NOT_FOUND", false);
      }
      throw new Error(`unexpected ${tool}`);
    });
    await expect(runTodo(w.deps, resume)).rejects.toThrow("AUTO_RUN_NOT_FOUND");
    expect(w.left()).toEqual([]);
    expect(w.results().at(-1)).toMatchObject({ code: "AUTO_RUN_NOT_FOUND", runDropped: true });
  });

  it("네트워크·5xx(재시도할 만함)로 끊기면 줄을 남겨 다음에 잇는다", async () => {
    const w = await world((tool) => {
      if (tool === "kanban_list_cards") return { cards: [cardDetail({})] };
      throw new AgentToolError("fetch failed", tool, undefined, true);
    });
    await expect(runTodo(w.deps, resume)).rejects.toThrow("fetch failed");
    expect(w.left()).toEqual([CARD]);
    expect(w.results().at(-1)).not.toHaveProperty("runDropped");
  });
});
