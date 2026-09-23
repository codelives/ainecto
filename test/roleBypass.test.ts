import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { tokenKey } from "../src/core/auth/tokenStore";
import { ROLE_HEADER } from "../src/core/harness/role";

/**
 * 2026-09-22 독립 리뷰 C1-②의 재현을 그대로 시험으로 고정한다.
 *
 * <p>그때: 브리지만 역할을 실었고 `ai-erd tools call ...` 은 «같은 토큰으로» 역할 없이
 * 서버에 닿았다. 셸을 쓸 수 있는 에이전트에게 그것은 제한을 우회하는 두 번째 문이었다.
 */
describe("역할이 CLI 의 모든 경로에 실린다", () => {
  const ENDPOINT = "https://ai-erd.com/mcp";
  let home: string;
  let originalHome: string | undefined;
  let originalFetch: typeof fetch;
  const sent: Array<Record<string, string>> = [];

  const io = {
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdin: { on: () => undefined, resume: () => undefined },
  } as unknown as Parameters<typeof runAinectoCli>[1];

  async function seedToken(role?: string) {
    await mkdir(join(home, ".ainecto"), { recursive: true });
    const file: Record<string, unknown> = {};
    file[tokenKey(ENDPOINT, role)] = {
      endpoint: ENDPOINT,
      accessToken: "seeded-token",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    await writeFile(join(home, ".ainecto", "tokens.json"), JSON.stringify(file), "utf8");
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ai-erd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    sent.length = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{}" }] },
      }));
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  });

  it("★tools call 도 역할 헤더를 보낸다 (예전에는 안 보냈다)", async () => {
    await seedToken("development");

    const code = await runAinectoCli(
      ["--role", "development", "tools", "call", "erd_apply_changes", "{}", "--json"],
      io,
    );

    expect(code).toBe(0);
    expect(sent[0]).toMatchObject({ [ROLE_HEADER.toLowerCase()]: "development" });
  });

  it("★역할마다 토큰이 다르다 — 다른 역할의 토큰으로는 붙지 못한다", async () => {
    // development 토큰만 있는 상태에서 design 으로 부르면 그 토큰을 못 찾는다.
    await seedToken("development");

    const code = await runAinectoCli(
      ["--role", "design", "tools", "call", "list_projects", "{}", "--json"],
      io,
    );

    // ★design 용 토큰이 없으므로 development 토큰을 «집어 쓰지 않는다».
    //   (실서버라면 여기서 401 → 브라우저 로그인으로 간다. 그 승인이 사람의 게이트다.)
    expect(code).toBe(0);
    expect(sent[0]).not.toHaveProperty("authorization");
    expect(sent[0]).toMatchObject({ [ROLE_HEADER.toLowerCase()]: "design" });
  });

  it("역할 없이 쓰던 사람은 종전 그대로다", async () => {
    await seedToken(undefined);

    const code = await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io);

    expect(code).toBe(0);
    expect(Object.keys(sent[0]!)).not.toContain(ROLE_HEADER.toLowerCase());
  });
});
