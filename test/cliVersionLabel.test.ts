import { describe, expect, it } from "vitest";
import { bridgePackageSpec, cliVersionLabel } from "../src/core/version";

/** KAN-1113 #1890 D — 같은 판 번호의 로컬 빌드와 게시판을 서버·로그가 가른다. npx 판 고정은 그대로 판 번호다. */
describe("cliVersionLabel", () => {
  it("게시 빌드는 판 그대로", () => {
    expect(cliVersionLabel("0.14.0-next.7", "abc1234", true)).toBe("0.14.0-next.7");
  });
  it("로컬 빌드는 «-dev+<빌드>»", () => {
    expect(cliVersionLabel("0.14.0-next.7", "abc1234", false)).toBe("0.14.0-next.7-dev+abc1234");
    expect(cliVersionLabel("0.14.0-next.7", "abc1234-dirty", false)).toBe("0.14.0-next.7-dev+abc1234-dirty");
  });
  it("빌드를 모르면(번들 밖·git 없음) 판 그대로", () => {
    expect(cliVersionLabel("dev", undefined, false)).toBe("dev");
  });
  it("npx 판 고정은 표시 판이 아니라 판 번호", () => {
    expect(bridgePackageSpec("0.14.0-next.7")).toBe("@ainecto/mcp@0.14.0-next.7");
  });
});
