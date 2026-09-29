/**
 * 세션 역할 — AI-ERD Harness 의 「하나의 세션은 하나의 역할만 가진다」를 클라이언트 쪽에서
 * 실어 나르는 부분.
 *
 * ★역할은 «세션 도중에는 바뀌지 않는 곳»(세션 시작 때 읽는 설정·환경)에서 온다. 그래서 출처를
 *   둘로만 둔다(아래 ①②). 역할은 작업 가드레일이지 보안 경계가 아니다 — 같은 사용자 권한으로 도는
 *   에이전트는 이미 로그인해 둔 다른 역할 토큰을 쓸 수 있다(2026-09-29 사용자 결정 Q1).
 *
 * ★에이전트가 «사용자의 답으로» 다음 세션의 역할을 적용하는 것은 허용한다(같은 날 Q2):
 *   - 고르는 것은 사람, 적용({@code ai-erd init --role <role>})은 에이전트가 대신할 수 있다.
 *   - 떠 있는 세션의 역할은 바뀌지 않는다 — init 은 셸 명령이고 결과는 다음 세션에만 닿는다.
 *   - 처음 받는 역할 토큰에는 브라우저 승인이 든다(이미 있으면 들지 않는다 — 수용한 한계).
 *   - 역할이 있는 세션은 그 세션 안에서 역할을 바꾸거나 풀 수 없다.
 *
 *   ① --role 플래그    MCP 서버 설정의 args 에 사람이 적는다
 *                      → Claude Code(.mcp.json) · Cursor(.cursor/mcp.json) 처럼
 *                        «프로젝트별» 설정이 있는 에이전트
 *   ② AI_ERD_ROLE      세션을 띄우는 환경변수
 *                      → Codex 처럼 MCP 설정이 «전역»뿐이라 프로젝트별로 못 나누는 에이전트
 *                      ★이 브리지 프로세스는 세션 시작 시점에 뜨고 그때의 환경을 물려받는다.
 *                        에이전트가 나중에 export 해도 이미 뜬 프로세스에는 닿지 않는다.
 *
 * ⛔«도구로 역할을 선언»하는 길은 택하지 않았다. 에이전트가 «세션 도중에» 스스로 바꿀 수 있으면
 *   제약이 아니다 — 막히는 순간 「역할을 바꿔서 하겠습니다」가 가장 자연스러운 다음 수가 된다.
 *
 * ⚠강제하는 쪽은 서버다. 이 파일은 역할을 «전달»만 한다. 브리지에서 도구를 걸러 봐야
 *   브리지를 안 거치는 연결(HTTP 직결)에는 아무 효과가 없기 때문이다.
 */

export const HARNESS_ROLES = ["design", "development", "test", "validation"] as const;

export type HarnessRole = (typeof HARNESS_ROLES)[number];

/**
 * ★역할을 싣는 OAuth scope 접두사. 서버의 McpSessionRole.ROLE_SCOPE_PREFIX 와 같아야 한다.
 *
 * <p>이것이 «진짜» 출처다. 아래 헤더는 역할 scope 토큰이 없을 때의 권고일 뿐이고,
 * 같은 토큰을 쥔 다른 경로(셸에서 CLI 직접 호출 등)는 헤더를 안 보낸다.
 */
export const ROLE_SCOPE_PREFIX = "ai-erd:role:";

/** 서버가 읽는 헤더 이름. 서버의 McpSessionRoleResolver.ROLE_HEADER 와 같아야 한다. */
export const ROLE_HEADER = "X-AI-ERD-Role";

/** 설정이 전역뿐인 에이전트(Codex 등)를 위한 환경변수. */
export const ROLE_ENV_VAR = "AI_ERD_ROLE";

export interface RoleResolutionInput {
  role?: string;
  envVars?: NodeJS.ProcessEnv;
}

export interface ResolvedRole {
  role?: HarnessRole;
  source: "flag" | "env" | "none";
}

export function resolveRole(input: RoleResolutionInput = {}): ResolvedRole {
  if (input.role !== undefined) {
    return { role: assertRole(input.role), source: "flag" };
  }
  const fromEnv = (input.envVars ?? process.env)[ROLE_ENV_VAR];
  if (fromEnv && fromEnv.trim()) {
    return { role: assertRole(fromEnv), source: "env" };
  }
  return { source: "none" };
}

/**
 * ⚠여기서는 «틀리면 멈춘다». 서버는 모르는 값을 FULL 로 받아 넘기지만, 그건 남의 설정이
 * 조용히 죽지 않게 하려는 것이고 — 이쪽은 방금 사람이 친 값이라 오타를 알려주는 편이 낫다.
 * 조용히 «역할 없음»으로 도는 것이 이 도구에서 가장 나쁜 실패다.
 */
export function assertRole(value: string): HarnessRole {
  const normalized = value.trim().toLowerCase();
  if ((HARNESS_ROLES as readonly string[]).includes(normalized)) {
    return normalized as HarnessRole;
  }
  throw new Error(
    `Invalid role "${value}". Expected one of: ${HARNESS_ROLES.join(", ")}.`,
  );
}

/** 사람이 읽는 이름. 서버의 거부 안내문과 같은 어휘를 쓴다. */
export function roleDisplayName(role: HarnessRole): string {
  return `${role.charAt(0).toUpperCase()}${role.slice(1)} Session`;
}
