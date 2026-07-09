import type { ToolPresentationEnrichment } from "./types";

export const enrichments = [
  {
    mcpName: "mcp__ainecto__list_projects",
    outputHint: "table",
    tableColumns: ["uuid", "name", "projectKey", "workspaceUuid", "updatedAt"],
    displayName: "List projects",
    examples: ["ainecto projects list --env dev"],
  },
  {
    mcpName: "mcp__ainecto__list_workspaces",
    outputHint: "table",
    tableColumns: ["uuid", "name", "updatedAt"],
    displayName: "List workspaces",
  },
  {
    mcpName: "mcp__ainecto__list_folders",
    outputHint: "table",
    tableColumns: ["uuid", "name", "projectUuid", "parentFolderUuid", "updatedAt"],
    displayName: "List folders",
  },
  {
    mcpName: "mcp__ainecto__list_documents",
    outputHint: "table",
    tableColumns: ["uuid", "title", "type", "projectUuid", "folderUuid", "updatedAt"],
    displayName: "List documents",
  },
  {
    mcpName: "mcp__ainecto__search_documents",
    outputHint: "table",
    tableColumns: ["uuid", "title", "type", "projectUuid", "updatedAt"],
    displayName: "Search documents",
  },
  {
    mcpName: "mcp__ainecto__list_attachments",
    outputHint: "table",
    tableColumns: ["uuid", "filename", "contentType", "sizeBytes", "documentUuid"],
    displayName: "List attachments",
  },
  {
    mcpName: "mcp__ainecto__erd_list_tables",
    outputHint: "table",
    tableColumns: ["uuid", "name", "schema_name", "display_order"],
    displayName: "List ERD tables",
  },
  {
    mcpName: "mcp__ainecto__erd_list_refs",
    outputHint: "table",
    tableColumns: ["uuid", "name", "from_table_uuid", "to_table_uuid", "relationship"],
    displayName: "List ERD refs",
  },
  {
    mcpName: "mcp__ainecto__erd_list_enums",
    outputHint: "table",
    tableColumns: ["uuid", "name", "display_order"],
    displayName: "List ERD enums",
  },
  {
    mcpName: "mcp__ainecto__erd_list_table_groups",
    outputHint: "table",
    tableColumns: ["uuid", "name", "display_order"],
    displayName: "List ERD table groups",
  },
  {
    mcpName: "mcp__ainecto__task_list_tasks",
    outputHint: "table",
    tableColumns: ["uuid", "title", "statusUuid", "assigneeId", "updatedAt"],
    displayName: "List tasks",
  },
  {
    mcpName: "mcp__ainecto__task_list_statuses",
    outputHint: "table",
    tableColumns: ["uuid", "name", "displayOrder"],
    displayName: "List task statuses",
  },
  {
    mcpName: "mcp__ainecto__enable_shares",
    aliases: ["shares enable"],
    displayName: "Enable shares",
  },
  {
    mcpName: "mcp__ainecto__disable_shares",
    aliases: ["shares disable"],
    displayName: "Disable shares",
  },
] satisfies ToolPresentationEnrichment[];
