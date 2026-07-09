import { readFile } from "node:fs/promises";

export interface PayloadSourceInput {
  file?: string;
  inline?: string;
  stdin?: NodeJS.ReadStream;
  stdinText?: string;
  stdinIsTTY?: boolean;
}

export interface ParsedPayload {
  value: unknown;
  source: "file" | "stdin" | "inline" | "empty";
  warnings: string[];
}

export async function parsePayloadSource(input: PayloadSourceInput): Promise<ParsedPayload> {
  const warnings: string[] = [];
  const stdinIsTTY = input.stdinIsTTY ?? input.stdin?.isTTY ?? true;
  const hasInline = input.inline !== undefined && input.inline !== "";
  const hasStdin = input.stdinText !== undefined || !stdinIsTTY;

  if (input.file) {
    if (hasInline || hasStdin) {
      warnings.push("Multiple payload sources were provided; --file takes precedence.");
    }
    const text = await readFileOrStdin(input.file, input);
    return { value: parseJson(text), source: input.file === "-" || input.file === "@-" ? "stdin" : "file", warnings };
  }

  if (hasStdin) {
    if (hasInline) {
      warnings.push("Multiple payload sources were provided; stdin takes precedence.");
    }
    const text = input.stdinText ?? await readAllStdin(input.stdin);
    if (!text.trim()) {
      return { value: {}, source: "empty", warnings };
    }
    return { value: parseJson(text), source: "stdin", warnings };
  }

  if (hasInline) {
    const inline = input.inline === "@-" ? await readAllStdin(input.stdin) : input.inline;
    return { value: parseJson(inline), source: "inline", warnings };
  }

  return { value: {}, source: "empty", warnings };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined || !text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON payload: ${detail}`);
  }
}

async function readFileOrStdin(file: string, input: PayloadSourceInput): Promise<string> {
  if (file === "-" || file === "@-") {
    return input.stdinText ?? await readAllStdin(input.stdin);
  }
  return readFile(file, "utf8");
}

async function readAllStdin(stdin: NodeJS.ReadStream | undefined): Promise<string> {
  if (!stdin) {
    return "";
  }
  stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of stdin) {
    text += chunk;
  }
  return text;
}
