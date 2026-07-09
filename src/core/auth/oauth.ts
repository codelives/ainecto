import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { URLSearchParams } from "node:url";
import type { StoredTokenSet, TokenStore } from "./tokenStore";
import { registerPublicClient, type ClientRegistrationResult } from "./clientRegistration";

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
    const loopback = await createLoopbackReceiver();

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

export function shouldRefresh(token: Pick<StoredTokenSet, "expiresAt">, now = Date.now()): boolean {
  if (!token.expiresAt) {
    return false;
  }
  return token.expiresAt - now < 60_000;
}

export async function discoverOAuthMetadata(endpoint: string, fetchImpl: typeof fetch = fetch): Promise<OAuthMetadata> {
  const resourceMetadataUrl = await discoverResourceMetadataUrl(endpoint, fetchImpl);
  const resourceMetadata = await fetchJson<Record<string, unknown>>(resourceMetadataUrl, fetchImpl);
  const authorizationServers = resourceMetadata.authorization_servers;
  if (!Array.isArray(authorizationServers) || typeof authorizationServers[0] !== "string") {
    throw new Error("OAuth protected resource metadata did not include authorization_servers.");
  }
  const authServer = authorizationServers[0];
  const metadataUrl = authServer.includes("/.well-known/")
    ? authServer
    : `${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
  const metadata = await fetchJson<Record<string, unknown>>(metadataUrl, fetchImpl);
  if (typeof metadata.authorization_endpoint !== "string" || typeof metadata.token_endpoint !== "string") {
    throw new Error("OAuth authorization server metadata is missing authorization_endpoint or token_endpoint.");
  }
  return {
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: typeof metadata.registration_endpoint === "string" ? metadata.registration_endpoint : undefined,
    issuer: typeof metadata.issuer === "string" ? metadata.issuer : undefined,
  };
}

async function discoverResourceMetadataUrl(endpoint: string, fetchImpl: typeof fetch): Promise<string> {
  const challengeUrl = new URL(endpoint);
  const response = await fetchImpl(challengeUrl, { method: "GET" });
  const challenge = response.headers.get("www-authenticate");
  const fromChallenge = challenge ? parseBearerChallengeParam(challenge, "resource_metadata") : undefined;
  if (fromChallenge) {
    return fromChallenge;
  }
  const origin = new URL(endpoint).origin;
  return `${origin}/.well-known/oauth-protected-resource`;
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

async function createLoopbackReceiver(): Promise<{
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Ainecto CLI authorization failed. You can close this tab.");
      rejectCode(new Error(`OAuth authorization failed: ${error}`));
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

async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch OAuth metadata from ${url}: HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

async function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.unref();
}
