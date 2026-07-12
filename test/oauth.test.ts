import { describe, expect, it, vi } from "vitest";
import { OAuthClient, discoverOAuthMetadata, getBrowserOpenCommand } from "../src/core/auth/oauth";
import type { StoredTokenSet, TokenStore } from "../src/core/auth/tokenStore";

class MemoryTokenStore implements TokenStore {
  token: StoredTokenSet | undefined;

  async load(): Promise<StoredTokenSet | undefined> {
    return this.token;
  }

  async save(_endpoint: string, token: StoredTokenSet): Promise<void> {
    this.token = token;
  }

  async delete(): Promise<void> {
    this.token = undefined;
  }
}

describe("OAuth PKCE login", () => {
  it("sends state and only accepts an exact state match on the loopback callback", async () => {
    const store = new MemoryTokenStore();
    let tokenRequestBody = "";
    const fetchImpl = buildOAuthFetch({
      onTokenRequest: (body) => {
        tokenRequestBody = body;
      },
    });
    const openBrowser = vi.fn(async (url: string) => {
      const authorizeUrl = new URL(url);
      const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
      const state = authorizeUrl.searchParams.get("state");
      expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(redirectUri).toBeTruthy();
      await fetch(`${redirectUri}?code=auth-code&state=${state}`);
    });
    const client = new OAuthClient({
      endpoint: "https://dev.ainecto.com/mcp",
      tokenStore: store,
      fetchImpl,
      openBrowser,
    });

    await expect(client.login()).resolves.toMatchObject({ accessToken: "access-token" });
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(tokenRequestBody).toContain("code_verifier=");
    expect(store.token?.accessToken).toBe("access-token");
  });

  it("rejects loopback callbacks with missing or mismatched state", async () => {
    const tokenEndpointCalls: string[] = [];
    const client = new OAuthClient({
      endpoint: "https://dev.ainecto.com/mcp",
      tokenStore: new MemoryTokenStore(),
      fetchImpl: buildOAuthFetch({
        onTokenRequest: (body) => tokenEndpointCalls.push(body),
      }),
      openBrowser: async (url: string) => {
        const authorizeUrl = new URL(url);
        const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
        await fetch(`${redirectUri}?code=auth-code&state=wrong-state`);
      },
    });

    await expect(client.login()).rejects.toThrow("OAuth state mismatch.");
    expect(tokenEndpointCalls).toEqual([]);
  });

  it("fails discovery when authorization metadata does not advertise PKCE S256", async () => {
    await expect(discoverOAuthMetadata("https://dev.ainecto.com/mcp", buildOAuthFetch({
      codeChallengeMethodsSupported: ["plain"],
    }))).rejects.toThrow("PKCE S256");
  });

  it("does not open the browser when S256 support is missing", async () => {
    const openBrowser = vi.fn();
    const client = new OAuthClient({
      endpoint: "https://dev.ainecto.com/mcp",
      tokenStore: new MemoryTokenStore(),
      fetchImpl: buildOAuthFetch({ codeChallengeMethodsSupported: [] }),
      openBrowser,
    });

    await expect(client.login()).rejects.toThrow("PKCE S256");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("refuses to use AINECTO_TOKEN with custom endpoints unless explicitly allowed", async () => {
    const blocked = new OAuthClient({
      endpoint: "https://evil.example/mcp",
      tokenStore: new MemoryTokenStore(),
      envVars: { AINECTO_TOKEN: "env-token" },
    });
    await expect(blocked.getAccessToken()).rejects.toThrow("AINECTO_TOKEN can only be used");

    const allowed = new OAuthClient({
      endpoint: "https://evil.example/mcp",
      tokenStore: new MemoryTokenStore(),
      envVars: {
        AINECTO_TOKEN: "env-token",
        AINECTO_ALLOW_CUSTOM_ENDPOINT_TOKEN: "1",
      },
    });
    await expect(allowed.getAccessToken()).resolves.toBe("env-token");
  });

  it("rejects non-https OAuth metadata endpoints unless they are loopback", async () => {
    await expect(discoverOAuthMetadata("https://dev.ainecto.com/mcp", buildOAuthFetch({
      resourceMetadataUrl: "http://auth.example/resource",
    }))).rejects.toThrow("must use https");

    await expect(discoverOAuthMetadata("https://dev.ainecto.com/mcp", buildOAuthFetch({
      authorizationServer: "http://127.0.0.1:9000",
      metadataBaseUrl: "http://127.0.0.1:9000",
    }))).resolves.toMatchObject({
      authorizationEndpoint: "http://127.0.0.1:9000/authorize",
      tokenEndpoint: "http://127.0.0.1:9000/token",
    });
  });

  it("builds a Windows browser opener without cmd shell mediation", () => {
    expect(getBrowserOpenCommand("https://auth.example/authorize", "win32")).toEqual({
      command: "explorer.exe",
      args: ["https://auth.example/authorize"],
    });
    expect(() => getBrowserOpenCommand("http://auth.example/authorize", "win32")).toThrow("must use https");
  });
});

function buildOAuthFetch(options: {
  codeChallengeMethodsSupported?: string[];
  onTokenRequest?: (body: string) => void;
  resourceMetadataUrl?: string;
  authorizationServer?: string;
  metadataBaseUrl?: string;
} = {}): typeof fetch {
  const methods = options.codeChallengeMethodsSupported ?? ["S256"];
  const resourceMetadataUrl = options.resourceMetadataUrl ?? "https://auth.example/resource";
  const authorizationServer = options.authorizationServer ?? "https://auth.example";
  const metadataBaseUrl = options.metadataBaseUrl ?? "https://auth.example";
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://dev.ainecto.com/mcp") {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
        },
      });
    }
    if (url === resourceMetadataUrl) {
      return new Response(JSON.stringify({
        authorization_servers: [authorizationServer],
      }));
    }
    if (url === `${metadataBaseUrl}/.well-known/oauth-authorization-server`) {
      return new Response(JSON.stringify({
        issuer: metadataBaseUrl,
        authorization_endpoint: `${metadataBaseUrl}/authorize`,
        token_endpoint: `${metadataBaseUrl}/token`,
        code_challenge_methods_supported: methods,
      }));
    }
    if (url === `${metadataBaseUrl}/token`) {
      options.onTokenRequest?.(String(init?.body));
      return new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }));
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  }) as typeof fetch;
}
