import { homedir } from "node:os";
import { join } from "node:path";

/** `ainecto agent serve` 의 파일 자리 — ★한 곳. 폴더는 {@code ~/.ainecto/agent}, 0700. */
export interface AgentPaths {
  dir: string;
  /** Claude 의 cwd — 빈 폴더(K5). */
  work: string;
  /** 대화 uuid → Claude 세션 id. 대화가 바뀌면 {@code --resume}. */
  sessions: string;
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
    log: join(dir, "agent.log"),
    previousLog: join(dir, "agent.log.1"),
  };
}
