import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { URLSearchParams } from "node:url";
import type { StoredTokenSet, TokenStore } from "./tokenStore";
import { registerPublicClient, type ClientRegistrationResult } from "./clientRegistration";
import { assertTrustedEndpointUrl, isDefaultEndpoint } from "../config/endpoints";

export interface OAuthClientOptions {
  endpoint: string;
  tokenStore: TokenStore;
  fetchImpl?: typeof fetch;
  envVars?: NodeJS.ProcessEnv;
  openBrowser?: (url: string) => Promise<void>;
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

    const stored = await this.options.tokenStore.load(this.options.endpoint);
    if (!stored) {
      return undefined;
    }

    if (!shouldRefresh(stored)) {
      return stored.accessToken;
    }

    return this.refreshStoredToken(stored);
  }

  async refreshAfterUnauthorized(): Promise<string | undefined> {
    const stored = await this.options.tokenStore.load(this.options.endpoint);
    if (!stored?.refreshToken) {
      return undefined;
    }
    return this.refreshStoredToken(stored);
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

      assertTrustedEndpointUrl(authorizeUrl, "OAuth authorization URL");
      await this.openBrowserImpl(authorizeUrl.toString());
      const code = await loopback.waitForCode();
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
      await this.options.tokenStore.save(this.options.endpoint, stored);
      return stored;
    } finally {
      await loopback.close();
    }
  }

  async logout(): Promise<void> {
    await this.options.tokenStore.delete(this.options.endpoint);
  }

  private async refreshStoredToken(stored: StoredTokenSet): Promise<string | undefined> {
    if (!stored.refreshToken) {
      return stored.accessToken;
    }
    const metadata = await discoverOAuthMetadata(this.options.endpoint, this.fetchImpl);
    const token = await exchangeToken(metadata.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: stored.refreshToken,
      client_id: stored.clientId ?? "ainecto-cli",
      ...(stored.clientSecret ? { client_secret: stored.clientSecret } : {}),
      resource: this.options.endpoint,
    }, this.fetchImpl);
    const next = toStoredToken(this.options.endpoint, token, metadata, stored);
    await this.options.tokenStore.save(this.options.endpoint, next);
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

async function createLoopbackReceiver(expectedState: string): Promise<{
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Loopback OAuth server did not bind to a TCP port.");
  }
  return {
    redirectUri: `http://127.0.0.1:${address.port}/callback`,
    waitForCode: () => codePromise,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
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

async function openBrowser(url: string): Promise<void> {
  const { command, args } = getBrowserOpenCommand(url);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
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
