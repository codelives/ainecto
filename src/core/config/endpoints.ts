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
 * OAuth 메타데이터(issuer·resource·authorization_servers)도 ainecto.com 이다.
 */
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

/**
 * ★<b>이 env 의 기본 주소와 «정확히» 같은가.</b>
 *
 * <p>{@link isDefaultEndpoint} 는 prod·dev 를 둘 다 «기본»으로 보는 넓은 판정이라,
 * 「env=prod 인데 endpoint 만 dev」 같은 입력을 기본으로 착각한다. 그 판정으로 설정에서
 * {@code --endpoint} 를 빼면, 조회한 주소와 세션이 붙는 주소가 갈라진다
 * (2026-09-23 독립 재리뷰 I7).
 */
export function isDefaultEndpointFor(env: AinectoEnv, endpoint: string): boolean {
  return normalizeEndpoint(endpoint) === DEFAULT_ENDPOINTS[env];
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

/**
 * 직무 프로필을 고치는 설정 화면 — ★이 MCP 서버와 같은 출처의 홈페이지 설정(기본 탭 = 계정).
 * 규칙은 웹 앱과 같다(ainecto-front {@code src/lib/homepage.ts} 의 {@code /home/settings}, 같은 출처 배포).
 */
export function profileSettingsUrl(endpoint: string): string {
  return `${new URL(endpoint).origin}/home/settings`;
}
