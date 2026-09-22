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

/**
 * 기본 MCP 엔드포인트.
 *
 * ★2026-09-21 도메인 전환으로 ai-erd.com 이 «사람이 보는 주소»가 됐고, /mcp 는 두 도메인
 * 모두에서 동일하게 서빙된다(둘 다 같은 인스턴스). 그래서 기본값을 새 도메인으로 옮긴다.
 *
 * ⚠단, OAuth 메타데이터는 아직 ainecto.com 을 가리킨다:
 *   WWW-Authenticate  resource_metadata=https://ainecto.com/.well-known/oauth-protected-resource/mcp
 *   protected-resource  resource=https://ainecto.com/mcp · authorization_servers=[https://ainecto.com]
 *   authorization-server  issuer=https://ainecto.com
 * issuer 는 «발급자 이름»이라 바꾸면 기존 토큰이 전부 무효가 되어 동결돼 있다(전환 계획서 §4-1).
 *
 * 이 CLI 는 issuer/resource 를 요청 호스트와 «대조하지 않고» 서버가 준 메타데이터를 그대로
 * 따라가므로 영향이 없다. ⚠엄격하게 대조하는 다른 MCP 클라이언트는 resource 불일치를
 * 문제 삼을 수 있다 — 그때는 --endpoint 나 AINECTO_MCP_ENDPOINT 로 옛 주소를 쓸 수 있다.
 *
 * 옛 주소도 계속 동작한다. 끊지 않는다.
 */
const DEFAULT_ENDPOINTS: Record<AinectoEnv, string> = {
  prod: "https://ai-erd.com/mcp",
  dev: "https://dev.ai-erd.com/mcp",
};

/** 옛 기본값 — 이미 설정에 적어둔 사용자가 있다. isDefaultEndpoint 가 이것도 «기본»으로 본다. */
const LEGACY_DEFAULT_ENDPOINTS: readonly string[] = [
  "https://ainecto.com/mcp",
  "https://dev.ainecto.com/mcp",
];

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
  return Object.values(DEFAULT_ENDPOINTS).includes(normalized)
    || LEGACY_DEFAULT_ENDPOINTS.includes(normalized);
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
