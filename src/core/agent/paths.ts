import { homedir } from "node:os";
import { join } from "node:path";

/** `ainecto agent serve` 의 파일 자리 — ★한 곳. 폴더는 {@code ~/.ainecto/agent}, 0700. */
export interface AgentPaths {
  dir: string;
  /** Agent 의 cwd — 빈 폴더(K5). */
  work: string;
  /** (대화 uuid, Agent) → 세션 값(Claude session_id · Codex threadId). 대화가 바뀌면 재개. */
  sessions: string;
  /** 이 PC 가 돌던 자동 실행 카드(수락 뒤 끊기면 다음에 켤 때 이어 간다 — runs.ts). */
  runs: string;
  /** JSON 한 줄 로그. */
  log: string;
  previousLog: string;
}

export function agentPaths(home: string = homedir()): AgentPaths {
  const dir = join(home, ".ainecto", "agent");
  return {
    dir,
    work: join(dir, "work"),
    sessions: join(dir, "sessions.json"),
    runs: join(dir, "runs.json"),
    log: join(dir, "agent.log"),
    previousLog: join(dir, "agent.log.1"),
  };
}
