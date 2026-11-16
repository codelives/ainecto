import { readFile, rename, writeFile } from "node:fs/promises";
import type { DaemonLog } from "../term/daemonLog";
import { isNodeError, PRIVATE_FILE_MODE } from "../fs/privateFiles";
import type { AgentLogRecord } from "./log";

/** 이 PC 가 돌던 자동 실행 카드 한 줄 — ★PC 사실만(카드 상태는 서버가 진실원 — 이어 가기 직전에 다시 읽는다). */
export interface RunEntry {
  cardUuid: string;
  /** 그 카드의 AI 작업 — 수락 직후(작업 열기 전)에는 아직 없다. */
  workId?: string;
  /** 돌던 종류(claude-code · codex) — 다시 켜면 그 종류의 신원으로 잇는다. */
  agent?: string;
  startedAt: string;
}

/**
 * 이 PC 가 돌던 카드({@code ~/.ainecto/agent/runs.json}) — 카드 배정 할 일은 수락하면 닫혀서, 그 뒤 PC 가 꺼지면 다시 가져갈 할 일이 없다.
 * 그 빈자리만 메운다: 수락하면 적고, 끝(검토 요청·판단 요청·진행 중 아님·Agent 실패·서버 거절)이면 지운다. 멈춤·네트워크·5xx 로 끊기면 남아서 다음에 켤 때 이어 간다.
 * ★다른 PC 는 이 파일이 없으니 이어 가지 않는다. 답을 받은 할 일은 임대가 이어 가기를 맡는다(여기 적지 않는다).
 * 파일이 없거나 깨졌으면 빈 것으로 시작하고 로그 한 줄({@code runs_load}).
 */
export class AgentRunLog {
  private runs = new Map<string, RunEntry>();

  constructor(private readonly path: string, private readonly log: DaemonLog<AgentLogRecord>) {}

  /** 읽어서 남은 줄을 돌려준다 — 결과는 로그 한 줄. */
  async load(): Promise<RunEntry[]> {
    let reason: string | undefined;
    const runs = new Map<string, RunEntry>();
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as { runs?: unknown };
      for (const value of Array.isArray(parsed.runs) ? parsed.runs : []) {
        const e = (value ?? {}) as Partial<RunEntry>;
        if (typeof e.cardUuid === "string" && typeof e.startedAt === "string") {
          runs.set(e.cardUuid, { cardUuid: e.cardUuid, ...(typeof e.workId === "string" ? { workId: e.workId } : {}),
            ...(typeof e.agent === "string" ? { agent: e.agent } : {}), startedAt: e.startedAt });
        }
      }
    } catch (error) {
      reason = isNodeError(error, "ENOENT") ? "missing" : `unreadable: ${error instanceof Error ? error.message : String(error)}`;
      runs.clear();
    }
    this.runs = runs;
    this.log.write({ event: "runs_load", entries: runs.size, ...(reason ? { reason } : {}) });
    if (reason?.startsWith("unreadable")) await this.save();   // 깨진 파일은 비운다
    return [...runs.values()];
  }

  /** 돌기 시작(수락 직후) · 작업이 열리면 workId 를 더한다 — 처음 적은 시각은 그대로. */
  async started(cardUuid: string, workId: string | undefined, agent: string): Promise<void> {
    const before = this.runs.get(cardUuid);
    this.runs.set(cardUuid, { cardUuid, ...(workId ?? before?.workId ? { workId: workId ?? before?.workId } : {}), agent,
      startedAt: before?.startedAt ?? new Date().toISOString() });
    await this.save();
  }

  async finished(cardUuid: string): Promise<void> {
    if (!this.runs.delete(cardUuid)) return;
    await this.save();
  }

  private async save(): Promise<void> {
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, runs: [...this.runs.values()] }, null, 2)}\n`, { mode: PRIVATE_FILE_MODE });
    await rename(tmp, this.path);
  }
}
