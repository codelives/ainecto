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

/** 번들(tsup)로 도는가 — 배포물·로컬 빌드는 참, vitest·tsx 의 소스 실행은 거짓. holder 자기 사본(term holderImage)은 번들일 때만 만든다. */
export const CLI_BUNDLED: boolean = typeof __AINECTO_CLI_VERSION__ === "string";

declare const __AINECTO_CLI_BUILD__: string | undefined;
declare const __AINECTO_CLI_RELEASE__: boolean | undefined;

/** 빌드 식별(커밋 짧은 SHA, 커밋 안 된 변경이면 «-dirty») — tsup 이 박는다. 번들 밖·git 없는 빌드는 undefined. */
export const CLI_BUILD: string | undefined =
  typeof __AINECTO_CLI_BUILD__ === "string" && __AINECTO_CLI_BUILD__ !== "" ? __AINECTO_CLI_BUILD__ : undefined;

/**
 * 서버(PC 연결 open)·로그에 알리는 판 — 게시 빌드는 판 그대로, 로컬 빌드는 {@code <판>-dev+<빌드>}(KAN-1113 #1890 D: 같은 판 번호의
 * 로컬 빌드와 게시판을 가른다). ★npx 판 고정({@link bridgePackageSpec})에는 쓰지 않는다 — 그쪽은 npm 에 있는 판이어야 한다. 순수 함수.
 */
export function cliVersionLabel(version: string, build: string | undefined, release: boolean): string {
  return release || build === undefined ? version : `${version}-dev+${build}`;
}

/** 게시 빌드인가(scripts/publish.mjs 가 박는다) — 로컬 빌드·번들 밖은 거짓. ★자동 업그레이드는 게시판만 한다(로컬 빌드는 절대 안 갈아탄다). */
export const CLI_RELEASE: boolean = typeof __AINECTO_CLI_RELEASE__ === "boolean" && __AINECTO_CLI_RELEASE__;

export const CLI_VERSION_LABEL: string = cliVersionLabel(CLI_VERSION, CLI_BUILD, CLI_RELEASE);

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
