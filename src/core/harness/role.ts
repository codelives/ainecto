/**
 * 세션 역할 — AI-ERD Harness 의 「하나의 세션은 하나의 역할만 가진다」를 클라이언트 쪽에서
 * 실어 나르는 부분.
 *
 * ★0.4.2: 역할의 «저장 위치»는 하나다 — init 이 저장소에 쓴 {@code .mcp.json}·{@code .cursor/mcp.json}
 *   의 {@code ai-erd} 항목의 {@code --role}(판정은 {@code repositoryRole.ts} 한 곳). 로그인은 서버마다
 *   한 번이고 토큰은 역할을 싣지 않는다. 역할은 요청마다 {@link ROLE_HEADER} 로 실리고, 서버는 그 헤더로
 *   도구 목록·거절·인자 판정을 전부 적용한다. 역할은 작업 가드레일이지 보안 경계가 아니다(2026-09-29
 *   사용자 결정 Q1) — 같은 토큰으로 헤더를 빼면 제한이 없다.
 *
 *   - 브리지({@code ai-erd mcp}): ① {@code --role} 인자(init 이 MCP 설정에 쓴다) ② {@code AI_ERD_ROLE}
 *     (Codex 처럼 설정이 전역뿐인 에이전트). 세션 시작 때 정해지고 세션 동안 바뀌지 않는다.
 *   - 셸 명령({@code ai-erd tools call …} 등): 저장소 역할. ①② 를 주면 저장소 역할과 같아야 한다(다르면 거절).
 *   - 저장소 밖: 역할 없음 = 제한 없음.
 *
 * ★에이전트가 «사용자의 답으로» 다음 세션의 역할을 적용하는 것은 허용한다(Q2): 고르는 것은 사람,
 *   적용({@code ai-erd init --role <role>})은 에이전트. 떠 있는 세션의 역할은 바뀌지 않는다.
 *
 * ⛔«도구로 역할을 선언»하는 길은 택하지 않았다. 에이전트가 «세션 도중에» 스스로 바꿀 수 있으면
 *   제약이 아니다 — 막히는 순간 「역할을 바꿔서 하겠습니다」가 가장 자연스러운 다음 수가 된다.
 *
 * ⚠강제하는 쪽은 서버다. 이 파일은 역할을 «전달»만 한다.
 */

export const HARNESS_ROLES = ["design", "development", "test", "validation"] as const;

export type HarnessRole = (typeof HARNESS_ROLES)[number];

/**
 * 역할을 싣던 OAuth scope 접두사(0.4.1 이하). 서버의 McpSessionRole.ROLE_SCOPE_PREFIX 와 같다.
 *
 * <p>0.4.2 부터 로그인은 이 scope 를 요구하지 않는다. 남은 쓰임은 하나 — 역할 없는 토큰 칸에
 * 이 scope 가 든 토큰을 «저장하지 않는» 가드({@code tokenStore.assertNoRoleScope}).
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
