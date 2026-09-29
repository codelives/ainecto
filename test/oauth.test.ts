import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  OAuthClient,
  OAuthLoginError,
  createLoopbackReceiver,
  discoverOAuthMetadata,
  getBrowserOpenCommand,
  launchBrowser,
} from "../src/core/auth/oauth";
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
      endpoint: "https://dev.ai-erd.com/mcp",
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
      endpoint: "https://dev.ai-erd.com/mcp",
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
    await expect(discoverOAuthMetadata("https://dev.ai-erd.com/mcp", buildOAuthFetch({
      codeChallengeMethodsSupported: ["plain"],
    }))).rejects.toThrow("PKCE S256");
  });

  it("does not open the browser when S256 support is missing", async () => {
    const openBrowser = vi.fn();
    const client = new OAuthClient({
      endpoint: "https://dev.ai-erd.com/mcp",
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
    await expect(discoverOAuthMetadata("https://dev.ai-erd.com/mcp", buildOAuthFetch({
      resourceMetadataUrl: "http://auth.example/resource",
    }))).rejects.toThrow("must use https");

    await expect(discoverOAuthMetadata("https://dev.ai-erd.com/mcp", buildOAuthFetch({
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

/**
 * 2026-09-29 독립 리뷰 P1-2 — 비TTY(에이전트가 실행)에서의 로그인.
 * 예전엔 URL 을 어디에도 안 찍고, 한도가 없고, 브라우저를 못 열어도 몰랐다.
 */
describe("non-interactive sign-in", () => {
  const ENDPOINT = "https://dev.ai-erd.com/mcp";

  it("announces the authorize URL before it tries to open a browser", async () => {
    const order: string[] = [];
    let announced = "";
    let tokenRequestBody = "";
    const client = new OAuthClient({
      endpoint: ENDPOINT,
      tokenStore: new MemoryTokenStore(),
      fetchImpl: buildOAuthFetch({ onTokenRequest: (body) => { tokenRequestBody = body; } }),
      onAuthorizeUrl: (url) => { order.push("announce"); announced = url; },
      openBrowser: async (url) => {
        order.push("open");
        const authorize = new URL(url);
        await fetch(`${authorize.searchParams.get("redirect_uri")}?code=c&state=${authorize.searchParams.get("state")}`);
      },
    });

    await client.login();

    expect(order).toEqual(["announce", "open"]);
    expect(announced).toContain("https://auth.example/authorize?");
    // URL 에 담기는 것은 공개 값뿐이다 — 검증자(code_verifier)의 «값»은 프로세스 밖으로 안 나간다.
    const verifier = new URLSearchParams(tokenRequestBody).get("code_verifier");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(announced).not.toContain(verifier!);
    expect(announced).not.toContain("code_verifier");
  });

  it("gives up after the sign-in time limit instead of waiting forever", async () => {
    const store = new MemoryTokenStore();
    let redirectUri = "";
    const client = new OAuthClient({
      endpoint: ENDPOINT,
      tokenStore: store,
      fetchImpl: buildOAuthFetch(),
      onAuthorizeUrl: (url) => { redirectUri = new URL(url).searchParams.get("redirect_uri")!; },
      openBrowser: async () => undefined, // 열렸지만 사람이 승인하지 않는다
      loginTimeoutMs: 60,
    });

    const failure = await client.login().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OAuthLoginError);
    expect((failure as OAuthLoginError).code).toBe("LOGIN_TIMEOUT");
    expect((failure as Error).message).toContain("Nothing was saved");
    // ★말한 대로다: 토큰은 저장되지 않았고, 콜백 서버는 닫혀 늦게 온 승인도 받지 않는다.
    expect(store.token).toBeUndefined();
    await expect(fetch(`${redirectUri}?code=late&state=x`)).rejects.toThrow();
  });

  it("fails at once when the browser cannot be opened, without waiting for the time limit", async () => {
    const started = Date.now();
    const store = new MemoryTokenStore();
    let redirectUri = "";
    const client = new OAuthClient({
      endpoint: ENDPOINT,
      tokenStore: store,
      fetchImpl: buildOAuthFetch(),
      onAuthorizeUrl: (url) => { redirectUri = new URL(url).searchParams.get("redirect_uri")!; },
      openBrowser: async () => {
        throw new OAuthLoginError("BROWSER_UNAVAILABLE", "Could not open a browser on this machine (xdg-open: exited with code 3).");
      },
      loginTimeoutMs: 10_000,
    });

    await expect(client.login()).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(store.token).toBeUndefined();
    await expect(fetch(`${redirectUri}?code=late&state=x`)).rejects.toThrow();
  });

  it("★turns a blocked local callback port into an error that says what to do (no crash)", async () => {
    // 2026-09-29 코드 리뷰 P1 — sandbox 처럼 로컬 바인딩이 막힌 곳에서 listen 이 처리되지 않은
    // 예외로 죽었다. 192.0.2.1 은 문서용(TEST-NET-1) 주소라 이 기계에 없다 → 바인딩이 실패한다.
    const failure = await createLoopbackReceiver("state", "192.0.2.1").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OAuthLoginError);
    expect((failure as OAuthLoginError).code).toBe("CALLBACK_UNAVAILABLE");
    expect((failure as Error).message).toContain("sandbox");
  });

  it("does not wait for the opener to exit before accepting the callback", async () => {
    // 일부 여는 명령은 브라우저가 닫힐 때까지 안 끝난다. 순서대로 기다리면 교착한다.
    const client = new OAuthClient({
      endpoint: ENDPOINT,
      tokenStore: new MemoryTokenStore(),
      fetchImpl: buildOAuthFetch(),
      openBrowser: (url) => {
        const authorize = new URL(url);
        void fetch(`${authorize.searchParams.get("redirect_uri")}?code=c&state=${authorize.searchParams.get("state")}`);
        return new Promise<void>(() => undefined); // 영원히 안 끝나는 여는 명령
      },
      loginTimeoutMs: 5_000,
    });

    await expect(client.login()).resolves.toMatchObject({ accessToken: "access-token" });
  });
});

describe("launchBrowser", () => {
  const URL_ = "https://auth.example/authorize";

  function fakeSpawn(script: (child: EventEmitter) => void) {
    return vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => undefined;
      setImmediate(() => script(child));
      return child as unknown as ChildProcess;
    });
  }

  it("rejects when the opener exits non-zero (xdg-open with no browser)", async () => {
    const spawnImpl = fakeSpawn((child) => child.emit("exit", 3, null));
    await expect(launchBrowser(URL_, { platform: "linux", spawnImpl }))
      .rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    expect(spawnImpl).toHaveBeenCalledWith("xdg-open", [URL_], expect.anything());
  });

  it("rejects when the opener command does not exist (ENOENT) instead of crashing", async () => {
    const spawnImpl = fakeSpawn((child) => child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })));
    await expect(launchBrowser(URL_, { platform: "linux", spawnImpl }))
      .rejects.toThrow(/Could not open a browser.*ENOENT/);
  });

  it("resolves when the opener exits 0", async () => {
    const spawnImpl = fakeSpawn((child) => child.emit("exit", 0, null));
    await expect(launchBrowser(URL_, { platform: "darwin", spawnImpl })).resolves.toBeUndefined();
  });

  it("does not judge Windows by exit code — explorer.exe exits 1 on success", async () => {
    const spawnImpl = fakeSpawn((child) => { child.emit("spawn"); child.emit("exit", 1, null); });
    await expect(launchBrowser(URL_, { platform: "win32", spawnImpl })).resolves.toBeUndefined();
  });
});

describe("stored token expiry", () => {
  const ENDPOINT = "https://dev.ai-erd.com/mcp";

  function clientWith(token: Partial<StoredTokenSet>) {
    const store = new MemoryTokenStore();
    store.token = { endpoint: ENDPOINT, accessToken: "stored", updatedAt: "x", ...token };
    return new OAuthClient({ endpoint: ENDPOINT, tokenStore: store, envVars: {}, fetchImpl: buildOAuthFetch() });
  }

  it("★an expired token with no refresh token counts as signed out", async () => {
    await expect(clientWith({ expiresAt: Date.now() - 1_000 }).getAccessToken()).resolves.toBeUndefined();
  });

  it("a token inside the last minute but not yet expired is still used", async () => {
    await expect(clientWith({ expiresAt: Date.now() + 30_000 }).getAccessToken()).resolves.toBe("stored");
  });

  it("a token with no expiry is used as is", async () => {
    await expect(clientWith({}).getAccessToken()).resolves.toBe("stored");
  });

  it("★read-only (init --dry-run) never refreshes: an expired token is simply absent", async () => {
    const store = new MemoryTokenStore();
    store.token = { endpoint: ENDPOINT, accessToken: "stored", updatedAt: "x", expiresAt: Date.now() - 1_000, refreshToken: "r" };
    const fetchImpl = vi.fn();
    const client = new OAuthClient({ endpoint: ENDPOINT, tokenStore: store, envVars: {}, fetchImpl: fetchImpl as unknown as typeof fetch, readOnly: true });

    await expect(client.getAccessToken()).resolves.toBeUndefined();
    await expect(client.refreshAfterUnauthorized()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.token.accessToken).toBe("stored");
  });

  it("an expired token with a refresh token is refreshed", async () => {
    await expect(clientWith({ expiresAt: Date.now() - 1_000, refreshToken: "r" }).getAccessToken())
      .resolves.toBe("access-token");
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
    if (url === "https://dev.ai-erd.com/mcp") {
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
