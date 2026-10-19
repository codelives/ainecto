/**
 * 옛 세션 역할 입력 — ★0.8.0 에서 세션 역할(Design/Development/Test/Validation)이 없어졌다.
 * 도구 목록은 모든 세션이 같고, 무엇을 할 수 있는지는 서버가 사용자·리소스 권한으로만 정한다.
 *
 * <p>그래도 옛 입력은 «거절하지 않는다» — 0.7.x 의 {@code init} 이 쓴 저장소 설정
 * ({@code npx -y @ainecto/mcp --role design}, 버전 고정 없음)은 게시 즉시 이 판을 띄운다.
 * 여기서 {@code --role} 을 거절하면 그 저장소 전부의 연결이 끊긴다(설계 §2-3 R1).
 *
 * <p>받은 값은 «검사하지 않고» 두 군데에만 쓴다:
 * <ul>
 *   <li>stderr 안내 한 줄({@link LEGACY_ROLE_NOTICE}) — 사람이 설정을 정리하게.</li>
 *   <li>같은 헤더 {@link LEGACY_ROLE_HEADER} 로 서버에 실어 보냄 — 서버는 판정에 쓰지 않고
 *       {@code [mcp][legacy-role]} 로 기록만 한다. 새 헤더를 만들지 않으려고 옛 이름을 재사용한다.</li>
 * </ul>
 * ★관찰 기간(설계 §7-2 ⑤) 뒤 기록이 0건이면 이 파일과 브리지의 {@code --role} 받기를 함께 지운다.
 */

/** 서버가 기록용으로 읽는 헤더 — 서버 McpController 의 옛 역할 헤더와 같은 이름. */
export const LEGACY_ROLE_HEADER = "X-AiNecto-Role";

/** 0.7.x 가 Codex 처럼 전역 설정뿐인 에이전트에 안내하던 환경변수. */
export const LEGACY_ROLE_ENV_VAR = "AINECTO_ROLE";

export const LEGACY_ROLE_NOTICE =
  "AiNecto session roles were removed; access follows your AiNecto permissions. "
  + "Re-run `ainecto init` to tidy this repository.";

/**
 * 플래그(있으면) 아니면 {@link LEGACY_ROLE_ENV_VAR}. ★값을 검사하지 않는다 — 모르는 값도 받는다.
 * 빈 값은 «없음»이다.
 */
export function legacyRoleInput(flag: string | undefined, envVars: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = flag ?? envVars[LEGACY_ROLE_ENV_VAR];
  return value !== undefined && value.trim() ? value.trim() : undefined;
}
