/**
 * CLI 버전. ★진실원은 {@code package.json} 이고 빌드(tsup define)가 그 값을 박는다 —
 * 상수로 또 적으면 릴리스 때 한쪽만 올라가 조용히 거짓이 된다.
 * 번들을 거치지 않는 실행(vitest·tsx)에서는 값이 없으므로 "dev" 로 떨어진다.
 */
declare const __AINECTO_CLI_VERSION__: string | undefined;

/** 번들을 거치지 않은 실행의 판 표시. */
const UNBUNDLED_VERSION = "dev";

export const CLI_VERSION: string =
  typeof __AINECTO_CLI_VERSION__ === "string" ? __AINECTO_CLI_VERSION__ : UNBUNDLED_VERSION;

/**
 * npm 주 이름. ★이 이름을 박는 곳은 여기 하나다 — init·setup 이 쓰는 {@code npx -y <이름>@<판>},
 * MCP {@code clientInfo}, User-Agent, init 기록의 {@code generatedBy} 가 모두 이것을 쓴다.
 * {@code package.json} 의 name·{@code server.json} 의 패키지 식별자와 같아야 한다(시험이 대조한다).
 *
 * <p>다른 이름 {@code ainecto}·{@code @ainecto/cli} 에도 같은 코드가 올라가지만(scripts/publish.mjs),
 * 그 판으로 init 해도 이 이름을 쓴다.
 */
export const PACKAGE_NAME = "@ainecto/mcp";

export const CLI_USER_AGENT = `${PACKAGE_NAME} ${CLI_VERSION}`;

/**
 * MCP 설정에 쓰는 브리지 패키지 지정 — ★이 CLI 판으로 «고정»한다(설계 결정 #6·D8). 고정하지 않으면
 * 게시 즉시 모든 저장소의 브리지가 새 판으로 바뀐다(0.7.x 의 --role 설정이 그랬다). 올리는 길은
 * {@code setup}/{@code init} 재실행이다. 판을 모르는 실행(vitest·tsx)에서는 고정하지 않는다 —
 * {@code @dev} 는 npm 에서 판이 아니라 배포 태그로 읽힌다.
 */
export function bridgePackageSpec(version: string = CLI_VERSION): string {
  return version === UNBUNDLED_VERSION ? PACKAGE_NAME : `${PACKAGE_NAME}@${version}`;
}
