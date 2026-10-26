import { HARNESS_DIR } from "./harnessDoc";
import { findGitRoot, readManagedFile } from "./repositoryFiles";

/**
 * 이 폴더의 에이전트 이름(ainecto-root·tester 같은 고정 일꾼) — ★이름은 토큰이 아니라 «폴더»에 붙는다.
 * {@code ainecto init --agent <이름>} 이 쓰고, 브리지({@code --agent} 가 없을 때)와 직접 명령이 읽는다.
 * 기기당 하나인 {@code ~/.ainecto/tokens.json} 과 섞지 않는다. 환경변수는 두지 않는다(같은 사실 두 곳 방지).
 */
export const AGENT_NAME_PATH = `${HARNESS_DIR}/agent.local`;

/**
 * 서버가 에이전트 이름을 거절할 때의 오류 코드(설계 §2 «이름 규칙»). init 은 이 거절을 기본 규칙으로 덮지 않고
 * 멈춘다 — 틀린 이름이 저장소 설정 파일에 들어가기 전에 드러나야 한다.
 */
export const AGENT_NAME_REJECTIONS: ReadonlySet<string> = new Set(["AGENT_NAME_INVALID", "AGENT_LIMIT"]);

/**
 * 입력을 실을 이름으로 — 앞뒤 공백만 걷는다. ★규칙(소문자·글자·길이)은 서버가 진실원이라 여기서 다시 검사하지 않는다.
 * 남는 것이 없으면 undefined(이름 없음).
 */
export function agentNameOf(raw: string | undefined): string | undefined {
  const name = raw?.trim();
  return name ? name : undefined;
}

/** 이 폴더(저장소 루트 — init 이 쓰는 자리와 같은 판정)의 {@link AGENT_NAME_PATH}. 없으면 undefined. */
export async function readAgentName(cwd: string): Promise<string | undefined> {
  const root = (await findGitRoot(cwd)) ?? cwd;
  return agentNameOf(await readManagedFile(root, AGENT_NAME_PATH));
}
