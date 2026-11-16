import { defineConfig } from "tsup";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

/**
 * 빌드 식별 — 커밋 짧은 SHA(커밋 안 된 변경이 있으면 «-dirty»). 같은 판 번호의 다른 빌드를 가른다(KAN-1113 #1890 D).
 * git 이 없으면(압축본에서 빌드) 빈 값.
 */
function gitBuild(): string {
  try {
    const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const sha = git("rev-parse", "--short", "HEAD");
    return git("status", "--porcelain", "--untracked-files=no") === "" ? sha : `${sha}-dirty`;
  } catch {
    return "";
  }
}

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
  // ★게시 빌드(scripts/publish.mjs 가 AINECTO_RELEASE_BUILD=1 로 prepack)만 «게시판»이다 — 그 밖은 로컬 빌드(src/core/version.ts).
  define: {
    __AINECTO_CLI_VERSION__: JSON.stringify(version),
    __AINECTO_CLI_BUILD__: JSON.stringify(gitBuild()),
    __AINECTO_CLI_RELEASE__: JSON.stringify(process.env.AINECTO_RELEASE_BUILD === "1"),
  },
  // ★node-pty 는 네이티브 선택 의존성이라 묶지 않는다 — term 데몬이 실행 때 불러온다(src/core/term/session.ts).
  external: ["node-pty"],
  // ★묶는 패키지도 Node 가 실행 때 고르는 파일(main)과 같은 것을 고른다. @xterm/* 는 main(CJS)·module(ESM)
  //   내보내기 모양이 달라, 번들(module)과 tsx·vitest(main)가 서로 다른 코드를 보게 된다.
  esbuildOptions(options) {
    options.mainFields = ["main", "module"];
  },
});
