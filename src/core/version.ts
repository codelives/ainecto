/**
 * CLI 버전. ★진실원은 {@code package.json} 이고 빌드(tsup define)가 그 값을 박는다 —
 * 상수로 또 적으면 릴리스 때 한쪽만 올라가 조용히 거짓이 된다.
 * 번들을 거치지 않는 실행(vitest·tsx)에서는 값이 없으므로 "dev" 로 떨어진다.
 */
declare const __AINECTO_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __AINECTO_CLI_VERSION__ === "string" ? __AINECTO_CLI_VERSION__ : "dev";

/**
 * npm 주 이름. ★이 이름을 박는 곳은 여기 하나다 — init 이 쓰는 {@code npx -y <이름> --role …},
 * MCP {@code clientInfo}, User-Agent, init 기록의 {@code generatedBy} 가 모두 이것을 쓴다.
 * {@code package.json} 의 name·{@code server.json} 의 패키지 식별자와 같아야 한다(시험이 대조한다).
 *
 * <p>옛 이름 {@code @ai-erd/mcp}·{@code ai-erd}·{@code @ai-erd/cli} 에도 같은 코드가 올라가지만
 * (scripts/publish.mjs), 그 판으로 init 해도 새 이름을 쓴다 — 새 저장소 설정이 옛 이름에 묶이지 않게.
 */
export const PACKAGE_NAME = "@ainecto/mcp";

/** 0.4.x 의 주 이름. 이미 깔린 저장소의 MCP 설정에 남아 있다 — «우리 브리지»로 알아볼 때만 쓴다. */
export const LEGACY_PACKAGE_NAME = "@ai-erd/mcp";

export const CLI_USER_AGENT = `${PACKAGE_NAME} ${CLI_VERSION}`;
