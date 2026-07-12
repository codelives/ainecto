export type AinectoEnv = "prod" | "dev";

export interface EndpointResolutionInput {
  env?: AinectoEnv;
  endpoint?: string;
  envVars?: NodeJS.ProcessEnv;
}

export interface ResolvedEndpoint {
  env: AinectoEnv;
  endpoint: string;
  source: "flag" | "env" | "default";
}

const DEFAULT_ENDPOINTS: Record<AinectoEnv, string> = {
  prod: "https://ainecto.com/mcp",
  dev: "https://dev.ainecto.com/mcp",
};

export function resolveEndpoint(input: EndpointResolutionInput = {}): ResolvedEndpoint {
  const envVars = input.envVars ?? process.env;
  const env = input.env ?? "prod";

  if (input.endpoint) {
    return { env, endpoint: normalizeEndpoint(input.endpoint), source: "flag" };
  }

  if (envVars.AINECTO_MCP_ENDPOINT) {
    return { env, endpoint: normalizeEndpoint(envVars.AINECTO_MCP_ENDPOINT), source: "env" };
  }

  return { env, endpoint: DEFAULT_ENDPOINTS[env], source: "default" };
}

export function normalizeEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  assertTrustedEndpointUrl(url, "MCP endpoint");
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function isDefaultEndpoint(endpoint: string): boolean {
  const normalized = normalizeEndpoint(endpoint);
  return Object.values(DEFAULT_ENDPOINTS).includes(normalized);
}

export function assertTrustedEndpointUrl(value: string | URL, label = "URL"): void {
  const url = typeof value === "string" ? new URL(value) : value;
  if (url.protocol === "https:") {
    return;
  }
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return;
  }
  throw new Error(`${label} must use https, except http is allowed for localhost loopback endpoints.`);
}

export function assertLoopbackRedirectUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
    return;
  }
  throw new Error("OAuth redirect URI must be an http localhost loopback URL.");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "[::1]";
}

export function assertEnv(value: string | undefined): AinectoEnv | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "prod" || value === "dev") {
    return value;
  }
  throw new Error(`Invalid --env value "${value}". Expected "prod" or "dev".`);
}
