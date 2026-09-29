import { describe, expect, it } from "vitest";
import { buildCommandDescriptors } from "../src/adapters/cli/commandBuilder";
import { generatedTools } from "../src/core/catalog/generated.prod";
import { enrichments } from "../src/core/catalog/enrichments";

describe("commandBuilder", () => {
  it("builds generated command descriptors without requiring enrichment", () => {
    expect(buildCommandDescriptors(generatedTools, enrichments)).toContainEqual(
      expect.objectContaining({
        mcpName: "list_projects",
        commandPath: ["projects", "list"],
      }),
    );
  });

  it("★표시 정보(별칭)는 긴 이름·짧은 이름 어느 카탈로그에도 붙는다", () => {
    // prod 카탈로그는 짧은 이름, dev 는 아직 긴 이름이다. 정확한 문자열로만 맞추면
    // prod 에서 `shares enable` 별칭이 조용히 사라졌다(0.4.1 재동기화 때 시험이 잡았다).
    const tool = generatedTools.find((t) => t.mcpName === "enable_shares")!;
    const legacy = { ...tool, mcpName: "mcp__ainecto__enable_shares" };
    const [short, long] = buildCommandDescriptors([tool, legacy], enrichments);
    expect(short!.aliases).toEqual(["shares enable"]);
    expect(long!.aliases).toEqual(["shares enable"]);
  });
});
