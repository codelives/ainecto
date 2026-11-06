import { defineConfig } from "tsup";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  entry: {
    "bin/mcp": "src/bin/mcp.ts",
    "bin/ainecto": "src/bin/ainecto.ts",
  },
  format: ["esm"],
  target: "node18",
  platform: "node",
  sourcemap: true,
  clean: true,
  splitting: false,
  dts: false,
  define: { __AINECTO_CLI_VERSION__: JSON.stringify(version) },
  // ★node-pty 는 네이티브 선택 의존성이라 묶지 않는다 — term 데몬이 실행 때 불러온다(src/core/term/session.ts).
  external: ["node-pty"],
  // ★묶는 패키지도 Node 가 실행 때 고르는 파일(main)과 같은 것을 고른다. @xterm/* 는 main(CJS)·module(ESM)
  //   내보내기 모양이 달라, 번들(module)과 tsx·vitest(main)가 서로 다른 코드를 보게 된다.
  esbuildOptions(options) {
    options.mainFields = ["main", "module"];
  },
});
