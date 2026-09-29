import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { URLSearchParams } from "node:url";
import type { StoredTokenSet, TokenStore } from "./tokenStore";
import { registerPublicClient, type ClientRegistrationResult } from "./clientRegistration";
import { assertTrustedEndpointUrl, isDefaultEndpoint } from "../config/endpoints";
import { ROLE_SCOPE_PREFIX, type HarnessRole } from "../harness/role";

export interface OAuthClientOptions {
  /** 이 클라이언트가 쓰는 세션 역할. 토큰이 이 역할로 발급되고 저장된다. */
  role?: HarnessRole;
  endpoint: string;
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
  envVars?: NodeJS.ProcessEnv;
  /**
   * 브라우저를 연다. <b>열기에 실패하면 거절</b>하고, 성공이 확인되면(또는 아직 모르면) 가만히 있는다.
   * login 은 이 약속을 «기다리지 않고» 콜백 대기와 경주시킨다 — 여는 명령이 브라우저가 닫힐 때까지
   * 안 끝나는 환경에서 순서대로 기다리면 교착한다.
   */
  openBrowser?: (url: string) => Promise<void>;
  /**
   * 인가 URL 을 «브라우저를 열기 전에» 알린다. CLI 는 stderr 에 한 줄 쓴다 — 브라우저가 안 열려도
   * 사람이 직접 열 수 있고, 에이전트가 실행했다면 명령이 끝날 때 그 줄이 에이전트에게 닿는다.
   */
  onAuthorizeUrl?: (url: string) => void;
  /** 콜백을 기다리는 한도. 기본 5분 — 사람이 로그인하기엔 넉넉하고, 에이전트 셸 도구 최대 한도보다 짧다. */
  loginTimeoutMs?: number;
  /**
   * 토큰 저장소를 «읽기만» 한다 — 갱신하지 않는다(네트워크도, 토큰 파일 쓰기도 없다).
   * {@code init --dry-run} 이 쓴다: 「아무것도 바꾸지 않는다」에 사용자의 로그인 상태도 든다.
   * 갱신이 필요한(만료된) 토큰은 «없음»으로 본다.
   */
  readOnly?: boolean;
}

/** 로그인 대기 기본 한도(5분). */
export const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;

/**
 * 로그인이 «사람 쪽 사정으로» 끝나지 못한 이유. {@code code} 는 {@code --json} 의 {@code error.code} 로
 * 그대로 나간다(종료 코드는 다른 실패와 같은 1 — 받는 쪽은 메시지를 읽고 사람에게 옮긴다).
 */
export class OAuthLoginError extends Error {
  constructor(readonly code: "LOGIN_TIMEOUT" | "BROWSER_UNAVAILABLE" | "CALLBACK_UNAVAILABLE", message: string) {
    super(message);
    this.name = "OAuthLoginError";
  }
}

export interface OAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  issuer?: string;
  codeChallengeMethodsSupported: string[];
}

export interface TokenProvider {
  getAccessToken(): Promise<string | undefined>;
  refreshAfterUnauthorized(): Promise<string | undefined>;
}

export class OAuthClient implements TokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly envVars: NodeJS.ProcessEnv;
  private readonly openBrowserImpl: (url: string) => Promise<void>;

  constructor(private readonly options: OAuthClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.envVars = options.envVars ?? process.env;
    this.openBrowserImpl = options.openBrowser ?? openBrowser;
  }

  async getAccessToken(): Promise<string | undefined> {
    const envToken = this.envVars.AINECTO_TOKEN;
    if (envToken) {
      assertEnvTokenEndpointAllowed(this.options.endpoint, this.envVars);
      return envToken;
    }

    const stored = await this.options.tokenStore.load(this.options.endpoint, this.options.role);
    if (!stored) {
      return undefined;
    }

    if (!shouldRefresh(stored)) {
      return stored.accessToken;
    }
    if (this.options.readOnly) {
      return isExpired(stored) ? undefined : stored.accessToken;
    }
    // ★만료됐는데 갱신할 수단이 없으면 «토큰 없음»이다. 예전엔 만료된 토큰을 그대로 돌려줘서,
    //   init 은 로그인 대신 401 안내로 떨어졌고 다른 경로는 받을 게 뻔한 401 을 받으러 갔다
    //   (2026-09-29 독립 리뷰 P1-2). 아직 60초 창 안이면 쓸 수 있으므로 돌려준다.
    if (!stored.refreshToken) {
      return isExpired(stored) ? undefined : stored.accessToken;
    }

    return this.refreshStoredToken({ ...stored, refreshToken: stored.refreshToken });
  }

  async refreshAfterUnauthorized(): Promise<string | undefined> {
    const stored = await this.options.tokenStore.load(this.options.endpoint, this.options.role);
    if (this.options.readOnly || !stored?.refreshToken) {
      return undefined;
    }
    return this.refreshStoredToken({ ...stored, refreshToken: stored.refreshToken });
  }

  async login(): Promise<StoredTokenSet> {
    const pkce = generatePkcePair();
    const state = generateOAuthState();
    const loopback = await createLoopbackReceiver(state);

    try {
      const metadata = await discoverOAuthMetadata(this.options.endpoint, this.fetchImpl);
      const registration = metadata.registrationEndpoint
        ? await registerPublicClient(metadata.registrationEndpoint, loopback.redirectUri, this.fetchImpl)
        : { clientId: "ainecto-cli" };
      const authorizeUrl = new URL(metadata.authorizationEndpoint);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("client_id", registration.clientId);
      authorizeUrl.searchParams.set("redirect_uri", loopback.redirectUri);
      authorizeUrl.searchParams.set("code_challenge", pkce.codeChallenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("resource", this.options.endpoint);
      authorizeUrl.searchParams.set("state", state);
      // ★역할을 OAuth scope 로 요구한다. 새 역할 토큰은 브라우저에서 사람이 승인해야 발급된다.
      //   ⚠발급된 토큰은 저장소에 남아 그 뒤로는 승인 없이 쓰인다 — 역할은 작업 가드레일이지
      //   보안 경계가 아니다(2026-09-29 사용자 결정).
      if (this.options.role) {
        authorizeUrl.searchParams.set("scope", `mcp ${ROLE_SCOPE_PREFIX}${this.options.role}`);
      }

      assertTrustedEndpointUrl(authorizeUrl, "OAuth authorization URL");
      const url = authorizeUrl.toString();
      this.options.onAuthorizeUrl?.(url);
      // ★셋 중 먼저 오는 것이 결과다 — 콜백 도착 / 브라우저 열기 실패 / 시간 한도.
      //   예전엔 한도가 없고 열기 실패를 못 봐서, 브라우저가 없는 기계에서 말없이 영원히 기다렸다
      //   (2026-09-29 독립 리뷰 P1-2). 비TTY(에이전트가 실행)에서는 그 대기가 곧 멈춤이다.
      const browserFailure = this.openBrowserImpl(url).then(() => new Promise<never>(() => undefined));
      const code = await withTimeout(
        Promise.race([loopback.waitForCode(), browserFailure]),
        this.options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS,
      );
      const token = await exchangeToken(metadata.tokenEndpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: loopback.redirectUri,
        client_id: registration.clientId,
        code_verifier: pkce.codeVerifier,
        resource: this.options.endpoint,
        ...(registration.clientSecret ? { client_secret: registration.clientSecret } : {}),
      }, this.fetchImpl);

      const stored = toStoredToken(this.options.endpoint, token, metadata, registration);
      await this.options.tokenStore.save(this.options.endpoint, stored, this.options.role);
      return stored;
    } finally {
      await loopback.close();
    }
  }

  async logout(): Promise<void> {
    await this.options.tokenStore.delete(this.options.endpoint, this.options.role);
  }

  /** 부르는 쪽이 refresh token 이 있음을 이미 확인했다 — 타입이 그것을 요구한다. */
  private async refreshStoredToken(stored: StoredTokenSet & { refreshToken: string }): Promise<string | undefined> {
    const metadata = await discoverOAuthMetadata(this.options.endpoint, this.fetchImpl);
    const token = await exchangeToken(metadata.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: stored.clientId ?? "ainecto-cli",
      ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}),
      resource: this.options.endpoint,
    }, this.fetchImpl);
    const next = toStoredToken(this.options.endpoint, token, metadata, stored);
    await this.options.tokenStore.save(this.options.endpoint, next, this.options.role);
    return next.accessToken;
  }
}

export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/** 이미 만료됐는가. 만료 시각이 없으면 만료되지 않은 것으로 본다(서버가 수명을 안 알려 준 토큰). */
export function isExpired(token: Pick<StoredTokenSet, "expiresAt">, now = Date.now()): boolean {
  return token.expiresAt !== undefined && token.expiresAt <= now;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const minutes = timeoutMs / 60_000;
      const span = Number.isInteger(minutes) ? `${minutes} minute${minutes === 1 ? "" : "s"}` : `${timeoutMs} ms`;
      reject(new OAuthLoginError(
        "LOGIN_TIMEOUT",
        `Sign-in was not completed within ${span}. Nothing was saved — run the same command again.`,
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function shouldRefresh(token: Pick<StoredTokenSet, "expiresAt">, now = Date.now()): boolean {
  if (!token.expiresAt) {
    return false;
  }
  return token.expiresAt - now < 60_000;
}

export async function discoverOAuthMetadata(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<OAuthMetadata> {
  assertTrustedEndpointUrl(endpoint, "MCP endpoint");
  const resourceMetadataUrl = await discoverResourceMetadataUrl(endpoint, fetchImpl);
  assertTrustedEndpointUrl(resourceMetadataUrl, "OAuth protected resource metadata URL");
  const resourceMetadata = await fetchJson<Record<string, unknown>>(resourceMetadataUrl, fetchImpl);
  const authorizationServers = resourceMetadata.authorization_servers;
  if (!Array.isArray(authorizationServers) || typeof authorizationServers[0] !== "string") {
    throw new Error("OAuth protected resource metadata did not include authorization_servers.");
  }
  const authServer = authorizationServers[0];
  assertTrustedEndpointUrl(authServer, "OAuth authorization server");
  const metadataUrl = authServer.includes("/.well-known/")
    ? authServer
    : `${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  assertTrustedEndpointUrl(metadataUrl, "OAuth authorization server metadata URL");
  const metadata = await fetchJson<Record<string, unknown>>(metadataUrl, fetchImpl);
  if (typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
    throw new Error("OAuth authorization server metadata is missing authorization_endpoint or token_endpoint.");
  }
  assertTrustedEndpointUrl(metadata.authorization_endpoint, "OAuth authorization endpoint");
  assertTrustedEndpointUrl(metadata.token_endpoint, "OAuth token endpoint");
  if (typeof metadata.registration_endpoint === "string") {
    assertTrustedEndpointUrl(metadata.registration_endpoint, "OAuth client registration endpoint");
  }
  if (typeof metadata.issuer === "string") {
    assertTrustedEndpointUrl(metadata.issuer, "OAuth issuer");
  }
  const codeChallengeMethodsSupported = parseStringArray(metadata.code_challenge_methods_supported);
  if (!codeChallengeMethodsSupported.includes("S256")) {
    throw new Error("OAuth authorization server metadata must support PKCE S256.");
  }
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: typeof metadata.registration_endpoint === "string" ? metadata.registration_endpoint : undefined,
    issuer: typeof metadata.issuer === "string" ? metadata.issuer : undefined,
    codeChallengeMethodsSupported,
  };
}

async function discoverResourceMetadataUrl(endpoint: string, fetchImpl: typeof fetch): Promise<string> {
  const challengeUrl = new URL(endpoint);
  assertTrustedEndpointUrl(challengeUrl, "MCP endpoint");
  const response = await fetchImpl(challengeUrl, { method: "GET" });
  const challenge = response.headers.get("www-authenticate");
  const fromChallenge = challenge ? parseBearerChallengeParam(challenge, "resource_metadata") : undefined;
  if (fromChallenge) {
    assertTrustedEndpointUrl(fromChallenge, "OAuth protected resource metadata URL");
    return fromChallenge;
  }
  const origin = new URL(endpoint).origin;
  const fallback = `${origin}/.well-known/oauth-protected-resource`;
  assertTrustedEndpointUrl(fallback, "OAuth protected resource metadata URL");
  return fallback;
}

export function parseBearerChallengeParam(header: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}="([^"]+)"`);
  return pattern.exec(header)?.[1];
}

async function exchangeToken(
  tokenEndpoint: string,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  assertTrustedEndpointUrl(tokenEndpoint, "OAuth token endpoint");
  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

type TokenContext = Partial<Pick<StoredTokenSet, "refreshToken" | "tokenType" | "expiresAt" | "scope" | "clientId" | "clientSecret">>
  & Partial<ClientRegistrationResult>;

function toStoredToken(
  endpoint: string,
  token: Record<string, unknown>,
  metadata: OAuthMetadata,
  previous?: TokenContext,
): StoredTokenSet {
  if (typeof token.access_token !== "string") {
    throw new Error("OAuth token response did not include access_token.");
  }
  const expiresIn = typeof token.expires_in === "number" ? token.expires_in : undefined;
  return {
    endpoint,
    accessToken: token.access_token,
    refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : previous?.refreshToken,
    tokenType: typeof token.token_type === "string" ? token.token_type : previous?.tokenType,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : previous?.expiresAt,
    scope: typeof token.scope === "string" ? token.scope : previous?.scope,
    clientId: previous?.clientId ?? "ainecto-cli",
    clientSecret: previous?.clientSecret,
    authorizationServer: metadata.issuer,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 로그인 콜백을 받는 loopback 서버. {@code host} 는 시험이 «바인딩 실패»를 만들 때만 바꾼다.
 */
export async function createLoopbackReceiver(expectedState: string, host = "127.0.0.1"): Promise<{
  redirectUri: string;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  codePromise.catch(() => undefined);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (error) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Ainecto CLI authorization failed. You can close this tab.");
      rejectCode(new Error(`OAuth authorization failed: ${error}`));
      return;
    }
    if (!state || state !== expectedState) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Ainecto CLI authorization state mismatch. You can close this tab.");
      rejectCode(new Error("OAuth state mismatch."));
      return;
    }
    if (!code) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Missing OAuth code.");
      rejectCode(new Error("OAuth redirect did not include a code."));
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Ainecto CLI authorization complete. You can close this tab.");
    resolveCode(code);
  });

  // ★바인딩이 막히면(에이전트 sandbox 등) 예전엔 error 리스너가 없어 처리되지 않은 예외로 죽었다
  //   (2026-09-29 코드 리뷰 P1). 사람이 할 일을 말하는 오류로 바꾼다.
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => reject(new OAuthLoginError(
      "CALLBACK_UNAVAILABLE",
      `Could not start the local sign-in callback on ${host} (${error.message}). `
      + "If this command runs in a sandbox, allow local network binding or run it outside the sandbox.",
    )));
    server.listen(0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback OAuth server did not bind to a TCP port.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: () => codePromise,
    close: () => new Promise<void>((resolve, reject) => {
      // Node 18 은 브라우저가 붙들고 있는 keep-alive 연결이 끝날 때까지 close 가 늦어진다.
      server.closeAllConnections?.();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  assertTrustedEndpointUrl(url, "OAuth metadata URL");
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch OAuth metadata from ${url}: HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export function getBrowserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  assertTrustedEndpointUrl(url, "OAuth authorization URL");
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "explorer.exe", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export interface LaunchBrowserDeps {
  platform?: NodeJS.Platform;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

/**
 * 기본 브라우저 열기. <b>여는 명령이 없거나(ENOENT) 0 이 아닌 코드로 끝나면 거절</b>한다.
 *
 * <p>★예전엔 {@code error} 리스너가 없어 명령이 없으면 처리되지 않은 오류로 죽었고, 명령은 있는데
 * 브라우저가 없으면({@code xdg-open} 비0 종료) 아무 말 없이 콜백을 영원히 기다렸다
 * (2026-09-29 독립 리뷰 P1-2).
 *
 * <p>⚠<b>Windows 는 종료 코드를 보지 않는다.</b> {@code explorer.exe} 는 성공해도 1 로 끝나는 것으로
 * 알려져 있어, 그 코드로 판정하면 정상 환경을 실패로 만든다 — 명령이 «떴다»는 것만 본다
 * (설계 §8-1, Windows 실측 V14 전까지 추정).
 */
export function launchBrowser(url: string, deps: LaunchBrowserDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const { command, args } = getBrowserOpenCommand(url, platform);
  const spawnImpl = deps.spawnImpl ?? spawn;
  return new Promise<void>((resolve, reject) => {
    const unavailable = (reason: string) => new OAuthLoginError(
      "BROWSER_UNAVAILABLE",
      `Could not open a browser on this machine (${command}: ${reason}). Sign-in needs a browser here.`,
    );
    let child: ChildProcess;
    try {
      child = spawnImpl(command, args, { stdio: "ignore", detached: true });
    } catch (error) {
      reject(unavailable(error instanceof Error ? error.message : String(error)));
      return;
    }
    child.once("error", (error) => reject(unavailable(error.message)));
    if (platform === "win32") {
      child.once("spawn", () => resolve());
    } else {
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(unavailable(code === null ? `stopped by ${signal ?? "a signal"}` : `exited with code ${code}`));
        }
      });
    }
    child.unref();
  });
}

function openBrowser(url: string): Promise<void> {
  return launchBrowser(url);
}

function assertEnvTokenEndpointAllowed(endpoint: string, envVars: NodeJS.ProcessEnv): void {
  if (envVars.AINECTO_ALLOW_CUSTOM_ENDPOINT_TOKEN === "1") {
    return;
  }
  if (isDefaultEndpoint(endpoint)) {
    return;
  }
  throw new Error("AINECTO_TOKEN can only be used with the default prod/dev endpoints. Set AINECTO_ALLOW_CUSTOM_ENDPOINT_TOKEN=1 only when you intentionally trust the custom endpoint.");
}
