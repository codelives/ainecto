/**
 * CLI 버전. ★진실원은 {@code package.json} 이고 빌드(tsup define)가 그 값을 박는다 —
 * 상수로 또 적으면 릴리스 때 한쪽만 올라가 조용히 거짓이 된다.
 * 번들을 거치지 않는 실행(vitest·tsx)에서는 값이 없으므로 "dev" 로 떨어진다.
 */
declare const __AI_ERD_CLI_VERSION__: string | undefined;

export const CLI_VERSION: string =
  typeof __AI_ERD_CLI_VERSION__ === "string" ? __AI_ERD_CLI_VERSION__ : "dev";

export const CLI_USER_AGENT = `@ai-erd/mcp ${CLI_VERSION}`;
