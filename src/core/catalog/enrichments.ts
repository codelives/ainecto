import type { ToolPresentationEnrichment } from "./types";

export const enrichments = [
  {
    mcpName: "list_projects",
    outputHint: "table",
    tableColumns: ["uuid", "name", "projectKey", "workspaceUuid", "updatedAt"],
    displayName: "List projects",
    examples: ["ai-erd projects list --env dev"],
  },
  {
    mcpName: "list_workspaces",
    outputHint: "table",
    tableColumns: ["uuid", "name", "updatedAt"],
    displayName: "List workspaces",
  },
  {
    mcpName: "list_folders",
    outputHint: "table",
    tableColumns: ["uuid", "name", "projectUuid", "parentFolderUuid", "updatedAt"],
    displayName: "List folders",
  },
  {
    mcpName: "list_documents",
    outputHint: "table",
    tableColumns: ["uuid", "title", "type", "projectUuid", "folderUuid", "updatedAt"],
    displayName: "List documents",
  },
  {
    mcpName: "search_documents",
    outputHint: "table",
    tableColumns: ["uuid", "title", "type", "projectUuid", "updatedAt"],
    displayName: "Search documents",
  },
  {
    mcpName: "list_attachments",
    outputHint: "table",
    tableColumns: ["uuid", "filename", "contentType", "sizeBytes", "documentUuid"],
    displayName: "List attachments",
  },
  {
    mcpName: "erd_list_tables",
    outputHint: "table",
    tableColumns: ["uuid", "name", "schema_name", "display_order"],
    displayName: "List ERD tables",
  },
  {
    mcpName: "erd_list_refs",
    outputHint: "table",
    tableColumns: ["uuid", "name", "from_table_uuid", "to_table_uuid", "relationship"],
    displayName: "List ERD refs",
  },
  {
    mcpName: "erd_list_enums",
    outputHint: "table",
    tableColumns: ["uuid", "name", "display_order"],
    displayName: "List ERD enums",
  },
  {
    mcpName: "erd_list_table_groups",
    outputHint: "table",
    tableColumns: ["uuid", "name", "display_order"],
    displayName: "List ERD table groups",
  },
  {
    mcpName: "task_list_tasks",
    outputHint: "table",
    tableColumns: ["uuid", "title", "statusUuid", "assigneeId", "updatedAt"],
    displayName: "List tasks",
  },
  {
    mcpName: "task_list_statuses",
    outputHint: "table",
    tableColumns: ["uuid", "name", "displayOrder"],
    displayName: "List task statuses",
  },
  {
    mcpName: "enable_shares",
    aliases: ["shares enable"],
    displayName: "Enable shares",
  },
  {
    mcpName: "disable_shares",
    aliases: ["shares disable"],
    displayName: "Disable shares",
  },
] satisfies ToolPresentationEnrichment[];
