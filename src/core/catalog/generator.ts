import { createHash } from "node:crypto";
import type { GeneratedToolDefinition, JsonSchema, McpToolListItem, PayloadMode, ToolGroup } from "./types";

const PREFIX = "mcp__ainecto__";
const DESTRUCTIVE_PREFIXES = [
  "delete_",
  "remove_",
  "archive_",
  "unarchive_",
  "restore_",
  "move_",
  "erd_delete_",
  "erd_remove_",
  "task_delete_",
  "testcase_delete_",
];

export function generateCatalog(tools: McpToolListItem[], sourceCatalog: "prod" | "dev"): GeneratedToolDefinition[] {
  return tools
    .map((tool) => normalizeTool(tool, sourceCatalog))
    .sort((a, b) => a.mcpName.localeCompare(b.mcpName));
}

export function normalizeTool(tool: McpToolListItem, sourceCatalog: "prod" | "dev"): GeneratedToolDefinition {
  if (!tool.name.startsWith(PREFIX)) {
    throw new Error(`Unsupported tool name "${tool.name}". Expected ${PREFIX} prefix.`);
  }
  const stripped = tool.name.slice(PREFIX.length);
  const group = inferGroup(stripped);
  const inputSchema = normalizeSchema(tool.inputSchema ?? { type: "object", properties: {} });
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((value): value is string => typeof value === "string").sort()
    : [];
  const definition = {
    mcpName: tool.name,
    commandPath: generateCommandPath(stripped, group),
    group,
    description: tool.description ?? "",
    inputSchema,
    required,
    payloadMode: inferPayloadMode(stripped, inputSchema),
    destructive: inferDestructive(stripped, tool),
    sourceCatalog,
    schemaHash: "",
  } satisfies GeneratedToolDefinition;
  return { ...definition, schemaHash: computeSchemaHash(definition) };
}

export function inferGroup(strippedName: string): ToolGroup {
  if (strippedName.startsWith("erd_")) return "erd";
  if (strippedName.startsWith("flow_")) return "flow";
  if (strippedName.startsWith("testcase_")) return "testcase";
  if (strippedName.startsWith("readme_")) return "readme";
  if (strippedName.includes("attachment") || strippedName.includes("upload")) return "attachment";
  if (strippedName.startsWith("task_")) return "task";
  if (strippedName.includes("workspace")) return "workspace";
  if (strippedName.includes("document")) return "document";
  return "generic";
}

export function generateCommandPath(strippedName: string, group: ToolGroup): string[] {
  if (group !== "generic" && strippedName.startsWith(`${group}_`)) {
    return [group, snakeToKebab(strippedName.slice(group.length + 1))];
  }

  const [verb, ...rest] = strippedName.split("_");
  if (verb && rest.length > 0 && isVerb(verb)) {
    return [rest.join("-"), verb];
  }

  return ["tools", "run", snakeToKebab(strippedName)];
}

export function inferPayloadMode(strippedName: string, inputSchema: JsonSchema): PayloadMode {
  if (strippedName.includes("upload") || strippedName.includes("attachment_upload")) {
    return "binary-upload";
  }
  const properties = inputSchema.properties;
  if (!isRecord(properties)) {
    return "flags";
  }
  const values = Object.values(properties);
  if (values.length === 0) {
    return "flags";
  }
  if (values.every(isScalarSchema)) {
    return "flags";
  }
  return "file-json";
}

export function inferDestructive(strippedName: string, tool: McpToolListItem): boolean {
  if (tool.annotations?.destructiveHint === true) {
    return true;
  }
  return DESTRUCTIVE_PREFIXES.some((prefix) => strippedName.startsWith(prefix));
}

export function computeSchemaHash(tool: Omit<GeneratedToolDefinition, "schemaHash">): string {
  return createHash("sha256")
    .update(stableStringify({
      name: tool.mcpName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
    .digest("hex")
    .slice(0, 16);
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function serializeGeneratedCatalog(tools: GeneratedToolDefinition[]): string {
  return [
    "import type { GeneratedToolDefinition } from \"./types\";",
    "",
    "export const generatedTools = [",
    ...tools.map((tool) => `  ${JSON.stringify(tool)},`),
    "] satisfies GeneratedToolDefinition[];",
    "",
  ].join("\n");
}

function normalizeSchema(schema: JsonSchema): JsonSchema {
  return JSON.parse(stableStringify(schema)) as JsonSchema;
}

function isScalarSchema(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const type = value.type;
  return type === "string" || type === "number" || type === "integer" || type === "boolean";
}

function isVerb(value: string): boolean {
  return [
    "list",
    "get",
    "create",
    "update",
    "delete",
    "move",
    "restore",
    "archive",
    "unarchive",
    "search",
  ].includes(value);
}

function snakeToKebab(value: string): string {
  return value.replaceAll("_", "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
