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
 * ★2026-10-11 AiNecto 복귀(2단계)로 «사람이 보는 주소»가 다시 ainecto.com 이다. /mcp 는 두 도메인
 * 모두에서 동일하게 서빙되고(같은 인스턴스), ai-erd.com 의 기계 경로는 301 하지 않고 계속 받는다.
 * OAuth 메타데이터(issuer·resource·authorization_servers)는 줄곧 ainecto.com 이었다 — 이제 기본 주소와 맞는다.
 *
 * dev 도 2026-10-11 같은 날 dev.ai-erd.com → dev.ainecto.com 으로 옮겼다(두 도메인이 같은 dev 인스턴스).
 */
const DEFAULT_ENDPOINTS: Record<AinectoEnv, string> = {
  prod: "https://ainecto.com/mcp",
  dev: "https://dev.ainecto.com/mcp",
};

/**
 * 옛 기본값 — 이미 설정·클라이언트에 적어둔 사용자가 있다. isDefaultEndpoint 가 이것도 «기본»으로 본다
 * (그래서 AINECTO_TOKEN 도 이 주소에 보낸다). ai-erd.com·dev.ai-erd.com 은 2026-09-21~10-11 의 기본값이었다.
 */
const LEGACY_PROD_ENDPOINT = "https://ai-erd.com/mcp";
const LEGACY_DEV_ENDPOINT = "https://dev.ai-erd.com/mcp";
const LEGACY_DEFAULT_ENDPOINTS: readonly string[] = [
  LEGACY_PROD_ENDPOINT,
  LEGACY_DEV_ENDPOINT,
];

/**
 * ★<b>토큰 칸 대체 — 판정은 여기 한 곳이다.</b> 이 주소의 칸이 비었을 때 «대신 읽을» 옛 칸.
 *
 * <p>토큰 칸은 주소마다 하나라(tokenStore {@code tokenKey}), 기본 주소가 ai-erd.com → ainecto.com 으로
 * 돌아가면 ai-erd.com 칸에 로그인해 둔 사람이 새 칸에서 안 보인다. 서버의 토큰 검증은 issuer 와 고정
 * audience(mcp-server)만 보고 요청 호스트와 무관하므로, 옛 칸의 토큰은 새 주소에서도 유효하다.
 *
 * <p>쌍은 «새 기본 ← 옛 기본» env 마다 하나다(prod·dev). 사용자 지정 주소(--endpoint)·옛 주소 자신에는 대체가 없다.
 * 읽기만 대체한다 — 갱신·새 로그인은 새 칸에 쓰고, 옛 칸은 지우지 않는다(옛 CLI 가 계속 쓴다).
 */
const TOKEN_SLOT_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  [DEFAULT_ENDPOINTS.prod]: [LEGACY_PROD_ENDPOINT],
  [DEFAULT_ENDPOINTS.dev]: [LEGACY_DEV_ENDPOINT],
};

export function fallbackTokenEndpointsFor(endpoint: string): readonly string[] {
  return TOKEN_SLOT_FALLBACKS[normalizeEndpoint(endpoint)] ?? [];
}

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
 * <p>{@link isDefaultEndpoint} 는 prod·dev·옛 주소를 전부 «기본»으로 보는 넓은 판정이라,
 * 「env=prod 인데 endpoint 만 dev」 같은 입력을 기본으로 착각한다. 그 판정으로 설정에서
 * {@code --endpoint} 를 빼면, 조회한 주소와 세션이 붙는 주소가 갈라진다
 * (2026-09-23 독립 재리뷰 I7).
 */
export function isDefaultEndpointFor(env: AinectoEnv, endpoint: string): boolean {
  return normalizeEndpoint(endpoint) === DEFAULT_ENDPOINTS[env];
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
