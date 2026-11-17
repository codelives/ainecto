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

/** 사람용 오류 줄의 앞머리 — `ainecto start` 가 pc 세션 화면에서 «실패로 끝남»을 알아본다(한 곳). */
export const ERROR_LINE_PREFIX = "Error: ";

export function renderError(error: unknown, options: { json?: boolean } = {}): string {
  const shape = toErrorShape(error);
  if (options.json) {
    return `${JSON.stringify(shape, null, 2)}\n`;
  }
  return `${ERROR_LINE_PREFIX}${shape.error.message}\n`;
}

export function toErrorShape(error: unknown): CliErrorShape {
  if (error instanceof Error) {
    const maybe = error as Error & { code?: string; details?: unknown };
    return {
      ok: false,
      error: {
        code: maybe.code ?? "CLI_ERROR",
        message: error.message,
        details: redactSecrets(maybe.details),
      },
    };
  }
  return { ok: false, error: { code: "CLI_ERROR", message: String(error) } };
}

export function redactSecrets(value: unknown): unknown {
  return redactSecretsInner(value, new WeakSet<object>());
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

function redactSecretsInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactSecretString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsInner(item, seen));
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[circular]";
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = isSecretKey(key) ? "[redacted]" : redactSecretsInner(child, seen);
    }
    return output;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/-/g, "_");
  return normalized === "authorization"
    || normalized.includes("access_token")
    || normalized.includes("refresh_token")
    || normalized.includes("client_secret")
    || normalized.includes("token");
}

function redactSecretString(value: string): string {
  return value
    .replace(/("(?:authorization|access_token|refresh_token|client_secret|token)"\s*:\s*")([^"]*)(")/gi, "$1[redacted]$3")
    .replace(/((?:authorization|access_token|refresh_token|client_secret|token)=)([^&\s"']+)/gi, "$1[redacted]")
    .replace(/(authorization:\s*bearer\s+)([^\s,}]+)/gi, "$1[redacted]")
    .replace(/(bearer\s+)(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi, "$1[redacted]");
}
