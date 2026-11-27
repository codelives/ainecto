import { createRequire } from "node:module";

/**
 * 이 빌드가 묶은 @xterm/headless 판 — ★진실원은 설치된 그 패키지의 package.json 이고 빌드(tsup define)가 그 값을 박는다(version.ts 와 같은 방식).
 * holder 는 자기 판으로, 계산 모듈(compute.ts)은 «나는 이 판의 Terminal 에 맞춰 만들어졌다»로 같은 값을 싣는다 — 둘이 다르면 holder 가 모듈을 받지 않는다(세션 유지 구조 3-2).
 * 번들을 거치지 않는 실행(vitest·tsx)은 node_modules 의 것을 읽는다.
 */
declare const __AINECTO_XTERM_VERSION__: string | undefined;

export const XTERM_VERSION: string = typeof __AINECTO_XTERM_VERSION__ === "string"
  ? __AINECTO_XTERM_VERSION__
  : (createRequire(import.meta.url)("@xterm/headless/package.json") as { version: string }).version;
