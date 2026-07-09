import type { GeneratedToolDefinition, ToolPresentationEnrichment } from "../../core/catalog/types";

export interface CliCommandDescriptor {
  mcpName: string;
  commandPath: string[];
  description: string;
  aliases: string[];
}

export function buildCommandDescriptors(
  tools: readonly GeneratedToolDefinition[],
  enrichments: readonly ToolPresentationEnrichment[],
): CliCommandDescriptor[] {
  const enrichmentByName = new Map(enrichments.map((enrichment) => [enrichment.mcpName, enrichment]));
  return tools.map((tool) => {
    const enrichment = enrichmentByName.get(tool.mcpName);
    return {
      mcpName: tool.mcpName,
      commandPath: tool.commandPath,
      description: enrichment?.displayName ?? tool.description,
      aliases: enrichment?.aliases ?? [],
    };
  });
}

export function assertUniqueCommandPaths(tools: readonly GeneratedToolDefinition[]): void {
  const seen = new Map<string, string>();
  for (const tool of tools) {
    const key = tool.commandPath.join(" ");
    const existing = seen.get(key);
    if (existing) {
      throw new Error(`Duplicate generated command path "${key}" for ${existing} and ${tool.mcpName}.`);
    }
    seen.set(key, tool.mcpName);
  }
}
