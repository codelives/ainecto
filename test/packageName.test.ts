import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/core/version";

describe("패키지 이름 SSOT", () => {
  const root = join(__dirname, "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));

  it("package.json·server.json·코드가 같은 주 이름과 버전을 쓴다", () => {
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(server.packages[0].identifier).toBe(PACKAGE_NAME);
    expect(server.name).toBe(pkg.mcpName);
    // ★시험판(0.14.0-next.1 등)은 MCP Registry 에 올리지 않는다(사용자 결정 2026-11-12, npm 꼬리표 next 로만) —
    //   그동안 server.json 은 마지막 정식 판에 머문다. 정식 판이면 셋이 같아야 한다.
    if (pkg.version.includes("-")) {
      expect(server.version).not.toContain("-");
      expect(server.packages[0].version).toBe(server.version);
    } else {
      expect(server.version).toBe(pkg.version);
      expect(server.packages[0].version).toBe(pkg.version);
    }
  });

  it("bin 은 명령 ainecto 와 범위 뗀 주 이름(mcp)의 브리지 둘뿐이다", () => {
    expect(pkg.bin).toEqual({
      [PACKAGE_NAME.split("/")[1]!]: "dist/bin/mcp.js",
      ainecto: "dist/bin/ainecto.js",
    });
  });
});
