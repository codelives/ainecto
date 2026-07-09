import { describe, expect, it } from "vitest";
import { buildCommandDescriptors } from "../src/adapters/cli/commandBuilder";
import { generatedTools } from "../src/core/catalog/generated.prod";
import { enrichments } from "../src/core/catalog/enrichments";

describe("commandBuilder", () => {
  it("builds generated command descriptors without requiring enrichment", () => {
    expect(buildCommandDescriptors(generatedTools, enrichments)).toEqual([
      expect.objectContaining({
        mcpName: "mcp__ainecto__list_projects",
        commandPath: ["projects", "list"],
      }),
    ]);
  });
});
