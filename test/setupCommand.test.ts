import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSetupCommand, type SetupCommandOptions } from "../src/adapters/cli/setupCommand";
import { OAuthClient } from "../src/core/auth/oauth";
import type { StoredTokenSet, TokenStore } from "../src/core/auth/tokenStore";
import type { McpRpcClient } from "../src/core/mcp/rpcClient";
import { systemCommandRunner } from "../src/core/setup/commandRunner";
import { installFakeAgents, type FakeAgents } from "./support/fakeAgentClis";

/**
 * `ainecto setup` — 임시 HOME + PATH 앞의 가짜 claude/codex(기록 스크립트)로 본다(설계 §7-3).
 * ★실 사용자 설정(~/.claude·~/.cursor·~/.codex)은 건드리지 않는다.
 */
const ENDPOINT = "https://ainecto.com/mcp";
/** 번들 밖 실행이라 판을 모른다 → 고정하지 않은 모양(고정 규칙은 harness.test). */
const OUR_BRIDGE = "npx -y @ainecto/mcp";

let home: string;
let fake: FakeAgents;
const out: string[] = [];
const err: string[] = [];

function accountClient(jobProfile: unknown = { title: "Founder & Product Lead" }): McpRpcClient {
  return {
    initialize: async () => ({}),
    toolsCall: async (name: string) => {
      const payload = name === "identity_get_self"
        ? { userId: "u-1", displayName: "Ryan", jobProfile }
        : { projects: [{ uuid: "p-1", name: "A" }, { uuid: "p-2", name: "B" }] };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    },
  } as unknown as McpRpcClient;
}

function options(argv: string[], extra: Partial<SetupCommandOptions> = {}): SetupCommandOptions {
  return {
    argv,
    endpoint: ENDPOINT,
    env: "prod",
    auth: { getAccessToken: async () => "t", login: async () => undefined },
    client: accountClient(),
    runner: systemCommandRunner({ cwd: home, env: fake.env }),
    home,
    json: true,
    io: {
      stdout: { write: (text: string) => { out.push(text); return true; } },
      stderr: { write: (text: string) => { err.push(text); return true; } },
    } as unknown as SetupCommandOptions["io"],
    ...extra,
  };
}

function result(): { setup: string; agents: Array<{ client: string; status: string; planned?: true; detail?: string }>; account: Record<string, unknown>; next: string[]; commands: Array<{ command: string; exitCode: number | null }> } {
  return JSON.parse(out.join("")).data;
}

const statusOf = (client: string) => result().agents.find((agent) => agent.client === client)?.status;
const cursorFile = () => join(home, ".cursor", "mcp.json");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ainecto-setup-home-"));
  fake = await installFakeAgents(home);
  await mkdir(join(home, ".cursor"));
  out.length = 0;
  err.length = 0;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("ainecto setup", () => {
  it("새 기기 — 세 클라이언트를 각각 연결하고 계정·직무를 보여 준다", async () => {
    expect(await executeSetupCommand(options([]))).toBe(0);

    expect(result().setup).toBe("complete");
    expect(statusOf("claude-code")).toBe("connected");
    expect(statusOf("cursor")).toBe("connected");
    expect(statusOf("codex")).toBe("connected");
    expect(await fake.log("claude")).toContain(`mcp add -s user ainecto -- ${OUR_BRIDGE}`);
    expect(await fake.state("codex")).toBe(`cmd|${OUR_BRIDGE}`);
    const cursor = JSON.parse(await readFile(cursorFile(), "utf8"));
    expect(cursor.mcpServers.ainecto).toEqual({ command: "npx", args: ["-y", "@ainecto/mcp"] });
    expect(result().account).toMatchObject({ signedIn: true, userId: "u-1", name: "Ryan", jobTitle: "Founder & Product Lead", projects: 2 });
    // ★이메일 칸이 없다.
    expect(JSON.stringify(result().account)).not.toMatch(/email|@/i);
    // 실행한 외부 명령이 «명령 + 종료 코드» 한 항목씩 남는다.
    expect(result().commands).toContainEqual({ command: "claude mcp get ainecto", exitCode: 1, error: expect.stringContaining("No MCP server") });
    expect(result().commands).toContainEqual({ command: `claude mcp add -s user ainecto -- ${OUR_BRIDGE}`, exitCode: 0 });
  });

  it("★옛 0.7.x 항목(--role)은 우리 것이다 — 걷고 다시 넣는다(updated)", async () => {
    await fake.seed("claude", "cmd|npx -y @ainecto/mcp --role design");
    await fake.seed("codex", "cmd|npx -y @ainecto/mcp --role development");
    await writeFile(cursorFile(), JSON.stringify({
      mcpServers: { other: { url: "https://x" }, ainecto: { command: "npx", args: ["-y", "@ainecto/mcp", "--role", "test"] } },
    }));

    expect(await executeSetupCommand(options([]))).toBe(0);

    expect(statusOf("claude-code")).toBe("updated");
    expect(statusOf("cursor")).toBe("updated");
    expect(statusOf("codex")).toBe("updated");
    expect(await fake.log("claude")).toEqual([
      "mcp get ainecto",
      "mcp remove -s user ainecto",
      `mcp add -s user ainecto -- ${OUR_BRIDGE}`,
    ]);
    expect(await fake.state("claude")).toBe(`cmd|${OUR_BRIDGE}`);
    expect(await fake.state("codex")).toBe(`cmd|${OUR_BRIDGE}`);
    const cursor = JSON.parse(await readFile(cursorFile(), "utf8"));
    expect(cursor.mcpServers.ainecto.args).toEqual(["-y", "@ainecto/mcp"]);
    expect(cursor.mcpServers.other).toEqual({ url: "https://x" });
  });

  it("★남의 ainecto 항목(원격 URL)은 건드리지 않고 «kept»로 알린다", async () => {
    await fake.seed("claude", "url|https://ainecto.com/mcp");
    await fake.seed("codex", "url|https://ainecto.com/mcp");
    const theirs = JSON.stringify({ mcpServers: { ainecto: { url: "https://ainecto.com/mcp" } } });
    await writeFile(cursorFile(), theirs);

    expect(await executeSetupCommand(options([]))).toBe(0);

    for (const client of ["claude-code", "cursor", "codex"]) {
      expect(statusOf(client)).toBe("kept");
    }
    expect(await fake.log("claude")).toEqual(["mcp get ainecto"]);
    expect(await fake.state("codex")).toBe("url|https://ainecto.com/mcp");
    expect(await readFile(cursorFile(), "utf8")).toBe(theirs);
  });

  it("이미 같은 항목이면 아무 명령도 더 돌리지 않는다", async () => {
    await fake.seed("claude", `cmd|${OUR_BRIDGE}`);

    await executeSetupCommand(options([]));

    expect(statusOf("claude-code")).toBe("connected");
    expect(await fake.log("claude")).toEqual(["mcp get ainecto"]);
  });

  it("설치 안 된 클라이언트는 «not installed» — 실패가 아니다", async () => {
    const noAgents = await installFakeAgents(await mkdtemp(join(tmpdir(), "ainecto-empty-")), []);
    await rm(join(home, ".cursor"), { recursive: true });

    expect(await executeSetupCommand(options([], { runner: systemCommandRunner({ cwd: home, env: noAgents.env }) }))).toBe(0);

    for (const client of ["claude-code", "cursor", "codex"]) {
      expect(statusOf(client)).toBe("not installed");
    }
  });

  it("★한 클라이언트가 실패하면 그것만 failed, 나머지는 계속 — «부분 완료», 종료 1", async () => {
    await fake.failAdds("claude");

    expect(await executeSetupCommand(options([]))).toBe(1);

    expect(result().setup).toBe("partial");
    expect(statusOf("claude-code")).toBe("failed");
    expect(result().agents.find((agent) => agent.client === "claude-code")?.detail).toContain("boom: add failed");
    expect(statusOf("cursor")).toBe("connected");
    expect(statusOf("codex")).toBe("connected");
  });

  it("★--dry-run 은 로그인하지 않고 아무것도 쓰지 않는다 — 할 일만 보인다", async () => {
    let logins = 0;
    const code = await executeSetupCommand(options(["--dry-run"], {
      auth: { getAccessToken: async () => undefined, login: async () => { logins += 1; } },
    }));

    expect(code).toBe(0);
    expect(logins).toBe(0);
    expect(result().account).toMatchObject({ signedIn: false });
    expect(result().agents.every((agent) => agent.status !== "connected" || agent.planned)).toBe(true);
    expect(result().agents.find((agent) => agent.client === "claude-code")?.detail)
      .toContain(`would run: claude mcp add -s user ainecto -- ${OUR_BRIDGE}`);
    expect(await fake.log("claude")).toEqual(["mcp get ainecto"]);
    expect(await fake.state("claude")).toBeUndefined();
    await expect(readFile(cursorFile(), "utf8")).rejects.toThrow();
  });

  it("토큰이 없으면 브라우저 로그인을 한 번 하고 이어서 간다", async () => {
    let logins = 0;
    let token: string | undefined;
    expect(await executeSetupCommand(options([], {
      auth: { getAccessToken: async () => token, login: async () => { logins += 1; token = "fresh"; } },
    }))).toBe(0);
    expect(logins).toBe(1);
    expect(err.join("")).toContain("Signed in.");
  });

  it("직무가 미설정이면 설정 화면 링크를 다음 할 일에 싣는다(막지 않는다)", async () => {
    expect(await executeSetupCommand(options([], { client: accountClient(null) }))).toBe(0);

    expect(result().account.jobTitle).toBe("not set — set it at https://ainecto.com/home/settings");
    expect(result().next.join("\n")).toContain("https://ainecto.com/home/settings");
    expect(result().next.join("\n")).toContain("does not change permissions");
  });

  it("계정 확인이 실패하면(401) 에이전트는 연결하되 «부분 완료»로 알린다", async () => {
    const { McpRpcError } = await import("../src/core/mcp/rpcClient");
    const failing = {
      initialize: async () => { throw new McpRpcError("MCP HTTP request failed with HTTP 401.", "MCP_HTTP_ERROR", { status: 401 }); },
    } as unknown as McpRpcClient;

    expect(await executeSetupCommand(options([], { client: failing }))).toBe(1);
    expect(result().account.problem).toContain("unauthorized");
    expect(statusOf("cursor")).toBe("connected");
  });
});

describe("ainecto setup --undo", () => {
  it("우리 항목만 지운다 — 남의 항목은 남긴다, 로그인은 그대로", async () => {
    await fake.seed("claude", `cmd|${OUR_BRIDGE}@0.8.0`);
    await fake.seed("codex", "url|https://ainecto.com/mcp");
    await writeFile(cursorFile(), JSON.stringify({ mcpServers: { other: { url: "https://x" }, ainecto: { command: "npx", args: ["-y", "@ainecto/mcp@0.8.0"] } } }));

    expect(await executeSetupCommand(options(["--undo"]))).toBe(0);

    expect(statusOf("claude-code")).toBe("removed");
    expect(statusOf("cursor")).toBe("removed");
    expect(statusOf("codex")).toBe("kept");
    expect(await fake.state("claude")).toBeUndefined();
    expect(await fake.state("codex")).toBe("url|https://ainecto.com/mcp");
    expect(JSON.parse(await readFile(cursorFile(), "utf8")).mcpServers).toEqual({ other: { url: "https://x" } });
    expect(JSON.stringify(JSON.parse(out.join("")).data.notes)).toContain("ainecto auth logout");
  });

  it("연결이 없으면 «not connected»", async () => {
    await executeSetupCommand(options(["--undo"]));
    expect(statusOf("claude-code")).toBe("not connected");
    expect(statusOf("codex")).toBe("not connected");
  });
});

/**
 * ★리뷰 #6 F2 — 만료된 access + 서버가 폐기한 refresh 가 저장된 사용자. «실제» OAuthClient 로 본다:
 * token endpoint 가 refresh 에 invalid_grant 를 돌려주게 통제하고, 로그인은 loopback 콜백까지 실제로 돈다.
 */
describe("ainecto setup — 저장 로그인이 거절된 사용자 (실제 OAuthClient)", () => {
  type TokenMode = "invalid_grant" | "network";
  const AUTH = "https://auth.example";

  function storeWithRevokedRefresh(): TokenStore & { token: StoredTokenSet | undefined } {
    const store = {
      token: {
        endpoint: ENDPOINT,
        accessToken: "expired-access",
        refreshToken: "revoked-refresh",
        expiresAt: Date.now() - 60_000,
        clientId: "ainecto-cli",
        updatedAt: "x",
      } as StoredTokenSet | undefined,
      async load() { return store.token; },
      async save(_endpoint: string, token: StoredTokenSet) { store.token = token; },
      async delete() { store.token = undefined; },
    };
    return store;
  }

  function oauthFetch(mode: TokenMode, grants: string[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === ENDPOINT) {
        return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${AUTH}/resource"` } });
      }
      if (url === `${AUTH}/resource`) {
        return new Response(JSON.stringify({ authorization_servers: [AUTH] }));
      }
      if (url === `${AUTH}/.well-known/oauth-authorization-server`) {
        return new Response(JSON.stringify({
          issuer: AUTH,
          authorization_endpoint: `${AUTH}/authorize`,
          token_endpoint: `${AUTH}/token`,
          code_challenge_methods_supported: ["S256"],
        }));
      }
      if (url === `${AUTH}/token`) {
        const grant = new URLSearchParams(String(init?.body)).get("grant_type") ?? "";
        grants.push(grant);
        if (grant === "refresh_token") {
          if (mode === "network") throw new TypeError("fetch failed");
          return new Response(JSON.stringify({ error: "invalid_grant", error_description: "refresh_token unknown or expired" }), { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }));
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as typeof fetch;
  }

  /** 브라우저 대신 loopback 콜백을 직접 부른다 — 사람이 승인한 것과 같은 길. */
  const approveInBrowser = async (url: string) => {
    const authorize = new URL(url);
    await fetch(`${authorize.searchParams.get("redirect_uri")}?code=c&state=${authorize.searchParams.get("state")}`);
  };

  function realAuth(store: TokenStore, fetchImpl: typeof fetch, extra: { readOnly?: boolean; envVars?: NodeJS.ProcessEnv; endpoint?: string } = {}) {
    let logins = 0;
    const client = new OAuthClient({
      endpoint: extra.endpoint ?? ENDPOINT,
      tokenStore: store,
      fetchImpl,
      envVars: extra.envVars ?? {},
      readOnly: extra.readOnly,
      openBrowser: approveInBrowser,
      loginTimeoutMs: 5_000,
    });
    const auth = {
      getAccessToken: () => client.getAccessToken(),
      login: async () => { logins += 1; return client.login(); },
    };
    return { auth, logins: () => logins };
  }

  it("★invalid_grant 면 로그인 1회 후 정상 연결 — 새 토큰이 저장된다", async () => {
    const store = storeWithRevokedRefresh();
    const grants: string[] = [];
    const { auth, logins } = realAuth(store, oauthFetch("invalid_grant", grants));

    expect(await executeSetupCommand(options([], { auth }))).toBe(0);

    expect(logins()).toBe(1);
    expect(grants).toEqual(["refresh_token", "authorization_code"]);
    expect(store.token?.accessToken).toBe("fresh-access");
    expect(result().setup).toBe("complete");
    expect(result().account).toMatchObject({ signedIn: true });
    expect(statusOf("claude-code")).toBe("connected");
    expect(err.join("")).toContain("Signed in.");
  });

  it("★--dry-run 은 같은 상태에서도 로그인 0회 · 갱신 요청 0회 · 토큰 그대로", async () => {
    const store = storeWithRevokedRefresh();
    const grants: string[] = [];
    // ainectoCli 는 setup --dry-run 에 readOnly 를 건다 — 같은 조건.
    const { auth, logins } = realAuth(store, oauthFetch("invalid_grant", grants), { readOnly: true });

    expect(await executeSetupCommand(options(["--dry-run"], { auth }))).toBe(0);

    expect(logins()).toBe(0);
    expect(grants).toEqual([]);
    expect(store.token?.accessToken).toBe("expired-access");
    expect(result().account).toMatchObject({ signedIn: false });
  });

  it("★네트워크 장애는 로그인으로 삼키지 않는다 — 원인 그대로 끝난다", async () => {
    const store = storeWithRevokedRefresh();
    const { auth, logins } = realAuth(store, oauthFetch("network", []));

    await expect(executeSetupCommand(options([], { auth }))).rejects.toThrow("fetch failed");
    expect(logins()).toBe(0);
    expect(store.token?.accessToken).toBe("expired-access");
  });

  it("★불신 주소의 AINECTO_TOKEN 은 계속 거절 — 로그인으로 둔갑하지 않는다", async () => {
    const store = storeWithRevokedRefresh();
    const { auth, logins } = realAuth(store, oauthFetch("invalid_grant", []), {
      endpoint: "https://custom.example/mcp",
      envVars: { AINECTO_TOKEN: "env-token" },
    });

    await expect(executeSetupCommand(options([], { auth })))
      .rejects.toThrow("AINECTO_TOKEN can only be used with the default prod/dev endpoints");
    expect(logins()).toBe(0);
  });
});
