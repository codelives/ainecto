import type { ToolPresentationEnrichment } from "./types";

export const enrichments = [
  {
    mcpName: "mcp__ainecto__list_projects",
    outputHint: "table",
    displayName: "List projects",
    examples: ["ainecto tools call mcp__ainecto__list_projects --json"],
  },
] satisfies ToolPresentationEnrichment[];
