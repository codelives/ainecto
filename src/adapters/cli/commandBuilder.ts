import type { GeneratedToolDefinition, ToolPresentationEnrichment } from "../../core/catalog/types";
import { bareToolName } from "../../core/catalog/generator";

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
  // ★맨 이름으로 맞춘다. prod 카탈로그는 짧은 이름(서버가 prefix 를 뗀 뒤 다시 받음), dev 카탈로그는
  //   아직 긴 이름이다. 정확히 같은 문자열로만 맞추면 한쪽의 별칭(`shares enable` 등)이 조용히 사라진다.
  const enrichmentByName = new Map(enrichments.map((enrichment) => [bareToolName(enrichment.mcpName), enrichment]));
  return tools.map((tool) => {
    const enrichment = enrichmentByName.get(bareToolName(tool.mcpName));
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
