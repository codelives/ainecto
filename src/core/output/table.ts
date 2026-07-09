export interface TableOptions {
  columns?: string[];
}

export function renderTable(data: unknown, options: TableOptions = {}): string | undefined {
  const rows = extractRows(data);
  if (!rows.length || !rows.every(isRecord)) {
    return undefined;
  }

  const columns = options.columns?.length ? options.columns : inferColumns(rows);
  if (!columns.length) {
    return undefined;
  }

  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => formatCell(row[column]).length)));
  const header = columns.map((column, index) => column.padEnd(widths[index] ?? column.length)).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) => columns.map((column, index) => formatCell(row[column]).padEnd(widths[index] ?? column.length)).join("  "));

  return [header, divider, ...body].join("\n");
}

function extractRows(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  if (isRecord(data)) {
    for (const key of ["items", "projects", "workspaces", "folders", "documents", "tasks", "attachments", "results", "data"]) {
      const value = data[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
  }
  return [];
}

function inferColumns(rows: Record<string, unknown>[]): string[] {
  const preferred = ["uuid", "id", "name", "title", "status", "type", "projectUuid", "documentUuid", "createdAt", "updatedAt"];
  const keys = new Set(rows.flatMap((row) => Object.keys(row)));
  const columns = preferred.filter((key) => keys.has(key));
  if (columns.length > 0) {
    return columns.slice(0, 6);
  }
  return [...keys].slice(0, 6);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
