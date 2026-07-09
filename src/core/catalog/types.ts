export type JsonSchema = Record<string, unknown>;

export type ToolGroup =
  | "generic"
  | "workspace"
  | "document"
  | "erd"
  | "flow"
  | "task"
  | "testcase"
  | "readme"
  | "attachment";

export type PayloadMode = "flags" | "json" | "file-json" | "binary-upload";

export interface GeneratedToolDefinition {
  mcpName: string;
  commandPath: string[];
  group: ToolGroup;
  description: string;
  inputSchema: JsonSchema;
  required: string[];
  payloadMode: PayloadMode;
  destructive: boolean;
  sourceCatalog: "prod" | "dev";
  schemaHash: string;
}

export interface ToolPresentationEnrichment {
  mcpName: string;
  outputHint?: "table" | "tree" | "json" | "text";
  tableColumns?: string[];
  aliases?: string[];
  displayName?: string;
  examples?: string[];
}

export interface McpToolListItem {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  annotations?: {
    destructiveHint?: boolean;
    readOnlyHint?: boolean;
  };
}
