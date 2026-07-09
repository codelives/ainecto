export interface CliErrorShape {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface CliSuccessShape {
  ok: true;
  data: unknown;
  warnings?: string[];
}

export function renderSuccess(data: unknown, options: { json?: boolean; warnings?: string[] } = {}): string {
  if (options.json) {
    const shape: CliSuccessShape = { ok: true, data };
    if (options.warnings?.length) {
      shape.warnings = options.warnings;
    }
    return `${JSON.stringify(shape, null, 2)}\n`;
  }
  const warnings = options.warnings?.length ? `${options.warnings.map((warning) => `Warning: ${warning}`).join("\n")}\n` : "";
  return `${warnings}${renderHuman(data)}\n`;
}

export function renderError(error: unknown, options: { json?: boolean } = {}): string {
  const shape = toErrorShape(error);
  if (options.json) {
    return `${JSON.stringify(shape, null, 2)}\n`;
  }
  return `Error: ${shape.error.message}\n`;
}

export function toErrorShape(error: unknown): CliErrorShape {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: string; details?: unknown };
    return {
      ok: false,
      error: {
        code: maybe.code ?? "CLI_ERROR",
        message: error.message,
        details: maybe.details,
      },
    };
  }
  return { ok: false, error: { code: "CLI_ERROR", message: String(error) } };
}

function renderHuman(data: unknown): string {
  if (Array.isArray(data)) {
    return data.map((item) => renderHuman(item)).join("\n");
  }
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data, null, 2);
}
