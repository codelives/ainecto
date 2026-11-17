import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ★설치 때 실행 0(사용자 2026-11-17, root REQ b1f76f76) — `npx -y ainecto` 가 설치하는 순간 코드를 돌리지 않게.
 * ⓐ 우리 package.json 에 설치 때 도는 스크립트가 생기면 실패한다(게시하는 세 이름이 모두 이 package.json 이다 — scripts/publish.mjs).
 * ⓑ 배포 의존성 중 설치 스크립트가 있는 것은 정확히 node-pty 그 판 하나다(동봉된 미리 빌드 확인 · 없으면 node-gyp).
 *   새 의존성이 생기거나 판이 바뀌면 사람이 보고 이 목록을 고친다.
 */
const ROOT = join(__dirname, "..");
const INSTALL_TIME_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];
const ALLOWED_INSTALL_SCRIPT_DEPENDENCIES = ["node_modules/node-pty@1.2.0-beta.18"];

describe("설치 때 실행 0", () => {
  it("ⓐ package.json 에 preinstall·install·postinstall·prepare 가 없다", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(Object.keys(pkg.scripts ?? {}).filter((name) => INSTALL_TIME_SCRIPTS.includes(name))).toEqual([]);
  });

  it("ⓑ 배포 의존성 중 설치 스크립트가 있는 것 = [node-pty 그 판] 정확히", () => {
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; dev?: boolean; hasInstallScript?: boolean }>;
    };
    const found = Object.entries(lock.packages)
      .filter(([path, entry]) => path !== "" && entry.hasInstallScript === true && entry.dev !== true)
      .map(([path, entry]) => `${path}@${entry.version ?? "?"}`)
      .sort();
    expect(found).toEqual(ALLOWED_INSTALL_SCRIPT_DEPENDENCIES);
  });
});
