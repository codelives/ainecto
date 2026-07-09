import type { GeneratedToolDefinition, JsonSchema } from "../../core/catalog/types";
import { parsePayloadSource, type ParsedPayload } from "../../core/input/payloadSource";
import { CliCommandError } from "./errors";

export interface ParsedCommandArgs {
  args: Record<string, unknown>;
  yes: boolean;
  warnings: string[];
}

export async function parseGeneratedCommandArgs(
  tool: GeneratedToolDefinition,
  argv: string[],
  stdin: NodeJS.ReadStream,
): Promise<ParsedCommandArgs> {
  const parsed = parseArgv(argv);
  const payload = await parsePayload(tool, parsed, stdin);
  const args = payloadToArgs(payload.value);
  const properties = getSchemaProperties(tool.inputSchema);

  for (const [key, value] of Object.entries(parsed.flags)) {
    if (key === "yes") {
      continue;
    }
    const schemaKey = resolveSchemaKey(key, properties);
    if (!schemaKey) {
      throw new CliCommandError("UNKNOWN_FLAG", `Unknown flag --${key} for ${tool.commandPath.join(" ")}.`, {
        flag: key,
        mcpName: tool.mcpName,
      });
    }
    args[schemaKey] = coerceFlagValue(value, properties[schemaKey], schemaKey);
  }

  for (const required of tool.required) {
    if (args[required] === undefined || args[required] === "") {
      throw new CliCommandError("MISSING_REQUIRED_FLAG", `Missing required argument "${required}" for ${tool.commandPath.join(" ")}.`, {
        required,
        flag: `--${camelToKebab(required)}`,
        mcpName: tool.mcpName,
      });
    }
  }

  return {
    args,
    yes: parsed.yes,
    warnings: payload.warnings,
  };
}

function payloadToArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new CliCommandError("INVALID_PAYLOAD", "Generated command payload must be a JSON object.", { value });
  }
  return { ...value };
}

interface ParsedArgv {
  flags: Record<string, string | boolean>;
  yes: boolean;
  file?: string;
  inline?: string;
}

function parseArgv(argv: string[]): ParsedArgv {
  const flags: Record<string, string | boolean> = {};
  const inline: string[] = [];
  let file: string | undefined;
  let yes = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (arg === "--file" || arg === "-f") {
      file = requireValue(arg, argv[++index]);
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      yes = true;
      flags.yes = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const eqIndex = withoutPrefix.indexOf("=");
      if (eqIndex >= 0) {
        const key = withoutPrefix.slice(0, eqIndex);
        flags[key] = withoutPrefix.slice(eqIndex + 1);
        continue;
      }
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        flags[withoutPrefix] = true;
        continue;
      }
      flags[withoutPrefix] = next;
      index += 1;
      continue;
    }
    inline.push(arg);
  }

  return {
    flags,
    yes,
    file,
    inline: inline.length > 0 ? inline.join(" ") : undefined,
  };
}

async function parsePayload(
  tool: GeneratedToolDefinition,
  parsed: ParsedArgv,
  stdin: NodeJS.ReadStream,
): Promise<ParsedPayload> {
  if (tool.payloadMode === "file-json" || parsed.file || parsed.inline) {
    return parsePayloadSource({
      file: parsed.file,
      inline: parsed.inline,
      stdin,
    });
  }

  return { value: {}, source: "empty", warnings: [] };
}

function resolveSchemaKey(flag: string, properties: Record<string, JsonSchema>): string | undefined {
  if (properties[flag]) {
    return flag;
  }
  const normalized = flag.toLowerCase();
  return Object.keys(properties).find((key) => camelToKebab(key) === normalized);
}

function coerceFlagValue(value: string | boolean, schema: JsonSchema | undefined, key: string): unknown {
  const type = schema?.type;
  if (type === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    if (value === "true") return true;
    if (value === "false") return false;
    throw new CliCommandError("INVALID_FLAG_VALUE", `Flag "${key}" must be a boolean.`, { key, value });
  }
  if (type === "integer") {
    if (typeof value === "boolean" || !/^-?\d+$/.test(value)) {
      throw new CliCommandError("INVALID_FLAG_VALUE", `Flag "${key}" must be an integer.`, { key, value });
    }
    return Number.parseInt(value, 10);
  }
  if (type === "number") {
    if (typeof value === "boolean" || Number.isNaN(Number(value))) {
      throw new CliCommandError("INVALID_FLAG_VALUE", `Flag "${key}" must be a number.`, { key, value });
    }
    return Number(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return value;
}

function getSchemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  const properties = schema.properties;
  if (!isRecord(properties)) {
    return {};
  }
  const result: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (isRecord(value)) {
      result[key] = value;
    }
  }
  return result;
}

export function camelToKebab(value: string): string {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).toLowerCase();
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new CliCommandError("FLAG_REQUIRES_VALUE", `${flag} requires a value.`, { flag });
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
