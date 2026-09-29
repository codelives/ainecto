import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { runConnector } from "../src/adapters/mcp/connector";
import { FileTokenStore, tokenKey } from "../src/core/auth/tokenStore";
import { findRepositoryRole } from "../src/core/harness/repositoryRole";
import { ROLE_HEADER } from "../src/core/harness/role";

/**
 * 0.4.2 — 저장소 역할 하나, 로그인은 서버마다 한 번(설계 repo-role-single-login §2).
 *
 * <p>역할은 init 이 저장소에 쓴 `--role` 에서 오고, 셸의 CLI 도 `--role` 없이 그 값을 헤더로 싣는다.
 * 토큰은 역할을 싣지 않는 한 칸이다. (2026-09-22 C1 — 「tools call 도 역할을 싣는다」는 그대로 지킨다.)
 */
describe("저장소 역할이 셸 CLI 에 실린다", () => {
  const ENDPOINT = "https://ai-erd.com/mcp";
  let home: string;
  let work: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let originalFetch: typeof fetch;
  let originalEnvRole: string | undefined;
  const sent: Array<Record<string, string>> = [];
  const errors: string[] = [];

  const io = {
    stdout: { write: () => true },
    stderr: { write: (text: string) => { errors.push(text); return true; } },
    stdin: { on: () => undefined, resume: () => undefined },
  } as unknown as Parameters<typeof runAinectoCli>[1];

  async function seedToken(scope = "mcp") {
    await mkdir(join(home, ".ainecto"), { recursive: true });
    const file: Record<string, unknown> = {};
    file[tokenKey(ENDPOINT)] = {
      endpoint: ENDPOINT,
      accessToken: "seeded-token",
      tokenType: "Bearer",
      scope,
      expiresAt: Date.now() + 3_600_000,
    };
    await writeFile(join(home, ".ainecto", "tokens.json"), JSON.stringify(file), "utf8");
  }

  /** init 이 쓰는 모양 그대로의 MCP 항목. */
  async function repo(dir: string, role: string | null, file = ".mcp.json") {
    await mkdir(join(dir, file, ".."), { recursive: true });
    const args = ["-y", "@ai-erd/mcp", ...(role ? ["--role", role] : [])];
    await writeFile(join(dir, file), JSON.stringify({ mcpServers: { "ai-erd": { command: "npx", args } } }), "utf8");
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ai-erd-home-"));
    work = await mkdtemp(join(tmpdir(), "ai-erd-work-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    originalEnvRole = process.env.AI_ERD_ROLE;
    delete process.env.AI_ERD_ROLE;
    originalCwd = process.cwd();
    process.chdir(work);
    sent.length = 0;
    errors.length = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      sent.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{}" }] },
      }));
    }) as unknown as typeof fetch;
    await seedToken();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalEnvRole === undefined) delete process.env.AI_ERD_ROLE; else process.env.AI_ERD_ROLE = originalEnvRole;
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  const roleHeader = () => sent[0]?.[ROLE_HEADER.toLowerCase()];

  it("★저장소 안에서는 --role 없이도 저장소 역할이 헤더로 간다 (토큰은 역할 없는 한 칸)", async () => {
    await repo(work, "development");

    const code = await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io);

    expect(code).toBe(0);
    expect(roleHeader()).toBe("development");
    expect(sent[0]!.authorization).toBe("Bearer seeded-token");
  });

  it("하위 폴더에서도 — cwd 에서 위로, ai-erd 항목이 있는 첫 폴더", async () => {
    await repo(work, "test");
    const deep = join(work, "packages", "api", "src");
    await mkdir(deep, { recursive: true });
    process.chdir(deep);

    expect(await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io)).toBe(0);
    expect(roleHeader()).toBe("test");
  });

  it("중첩 저장소는 가까운 쪽이 이긴다 (git 과 무관 — worktree·git 아닌 폴더도 같은 규칙)", async () => {
    await repo(work, "design");
    const inner = join(work, "vendor", "inner");
    await repo(inner, "validation", ".cursor/mcp.json");
    process.chdir(inner);

    expect(await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io)).toBe(0);
    expect(roleHeader()).toBe("validation");
  });

  it("★--role 이 저장소 역할과 다르면 거절한다 — 원격 호출 0", async () => {
    await repo(work, "development");

    const code = await runAinectoCli(["--role", "design", "tools", "call", "erd_apply_changes", "{}", "--json"], io);

    expect(code).toBe(1);
    expect(sent).toEqual([]);
    expect(errors.join("")).toContain("have the role development");
    expect(errors.join("")).toContain("ai-erd init --role <role>");
  });

  it("AI_ERD_ROLE 도 같은 규칙이다", async () => {
    await repo(work, "development");
    process.env.AI_ERD_ROLE = "design";

    expect(await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io)).toBe(1);
    expect(sent).toEqual([]);
    expect(errors.join("")).toContain("AI_ERD_ROLE=design does not match");
  });

  it("같은 역할을 명시하면 그대로 간다", async () => {
    await repo(work, "development");

    expect(await runAinectoCli(["--role", "development", "tools", "call", "list_projects", "{}", "--json"], io)).toBe(0);
    expect(roleHeader()).toBe("development");
  });

  it("저장소 밖은 역할 없음 = 제한 없음 (현행)", async () => {
    expect(await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io)).toBe(0);
    expect(Object.keys(sent[0]!)).not.toContain(ROLE_HEADER.toLowerCase());
  });

  it("저장소 밖에서 명시한 역할은 그대로 좁힌다", async () => {
    expect(await runAinectoCli(["--role", "test", "tools", "call", "list_projects", "{}", "--json"], io)).toBe(0);
    expect(roleHeader()).toBe("test");
  });

  it("★역할을 못 읽는 저장소(--role 없는 ai-erd 항목)는 «제한 없음»으로 떨어지지 않고 멈춘다", async () => {
    await repo(work, null);

    expect(await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io)).toBe(1);
    expect(sent).toEqual([]);
    expect(errors.join("")).toContain("Ask the user which role");
  });

  it("설정끼리 역할이 어긋나도 멈춘다", async () => {
    await repo(work, "design");
    await repo(work, "test", ".cursor/mcp.json");

    expect(await runAinectoCli(["tools", "call", "list_projects", "{}", "--json"], io)).toBe(1);
    expect(errors.join("")).toContain("disagree");
  });

  describe("★저장소 역할 판정은 mcp·init·auth 분기 «뒤»다 — 깨진 저장소에서도 막히지 않는다", () => {
    beforeEach(async () => {
      await repo(work, "design");
      await repo(work, "test", ".cursor/mcp.json");
    });

    it("auth status", async () => {
      expect(await runAinectoCli(["auth", "status", "--json"], io)).toBe(0);
      expect(errors.join("")).not.toContain("disagree");
    });

    it("mcp (브리지)", async () => {
      const input = new PassThrough();
      input.end();
      const cliIo = { ...io, stdin: input } as unknown as Parameters<typeof runAinectoCli>[1];
      expect(await runAinectoCli(["--role", "design", "mcp"], cliIo)).toBe(0);
      expect(errors.join("")).not.toContain("disagree");
    });

    it("init --role (역할을 맞추는 유일한 길)", async () => {
      const code = await runAinectoCli(["--role", "design", "init", "--dry-run", "--json"], io);
      // init 은 git 저장소 루트가 아니어도(임시 폴더) 진행한다. 역할 판정 오류로 멈추지 않는다.
      expect(errors.join("")).not.toContain("Cannot tell this repository's AI session role");
      expect([0, 1]).toContain(code);
    });
  });

  it("auth 에 --role 을 주면 알리고 진행한다 (로그인은 서버마다 한 번)", async () => {
    expect(await runAinectoCli(["--role", "design", "auth", "status", "--json"], io)).toBe(0);
    expect(errors.join("")).toContain("Sign-in is one per machine");
  });
});

describe("토큰 칸 — 역할 scope 토큰은 저장하지 않는다 (리뷰 P0-1 가드)", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "ai-erd-store-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("★scope 에 ai-erd:role: 이 든 토큰은 거절한다 — 들어가면 모든 저장소에서 토큰 역할이 헤더를 이긴다", async () => {
    const store = new FileTokenStore(dir);
    const token = { endpoint: "https://ai-erd.com/mcp", accessToken: "t", updatedAt: "x" };

    await expect(store.save(token.endpoint, { ...token, scope: "mcp ai-erd:role:design" })).rejects.toThrow(/role-scoped/);
    expect(await store.load(token.endpoint)).toBeUndefined();
    await store.save(token.endpoint, { ...token, scope: "mcp" });
    expect((await store.load(token.endpoint))?.accessToken).toBe("t");
  });
});

describe("findRepositoryRole", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ai-erd-find-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("★홈 폴더 자체는 보지 않는다 — ~/.cursor/mcp.json 은 Cursor 전역 설정이다", async () => {
    // 실측(2026-09-29): 사람의 ~/.cursor/mcp.json 에 역할 없는 ai-erd 항목이 있었고, 홈을 보면 모든 폴더가 멈췄다.
    await mkdir(join(root, ".cursor"), { recursive: true });
    await writeFile(join(root, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { "ai-erd": { url: "https://ai-erd.com/mcp" } } }), "utf8");
    const project = join(root, "projects", "x");
    await mkdir(project, { recursive: true });

    expect(await findRepositoryRole(project, root)).toEqual({ kind: "none" });
  });

  it("저장소 밖을 가리키는 링크는 읽지 않고 멈춘다", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ai-erd-outside-"));
    await writeFile(join(outside, "mcp.json"), JSON.stringify({ mcpServers: {} }), "utf8");
    const project = join(root, "p");
    await mkdir(project, { recursive: true });
    await symlink(join(outside, "mcp.json"), join(project, ".mcp.json"));

    const found = await findRepositoryRole(project, "/nonexistent-home");
    expect(found.kind).toBe("conflict");
    await rm(outside, { recursive: true, force: true });
  });

  it("JSON 이 아니면 멈춘다", async () => {
    await writeFile(join(root, ".mcp.json"), "{ not json", "utf8");
    expect((await findRepositoryRole(root, "/nonexistent-home")).kind).toBe("conflict");
  });
});

describe("역할 없는 브리지 경고 (리뷰 P1-b)", () => {
  let root: string;
  let home: string;
  let originalHome: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ai-erd-bridge-"));
    home = await mkdtemp(join(tmpdir(), "ai-erd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    await writeFile(join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { "ai-erd": { command: "npx", args: ["-y", "@ai-erd/mcp", "--role", "design"] } },
    }), "utf8");
  });
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  async function bridge(role: "design" | null) {
    const input = new PassThrough();
    input.end();
    const said: string[] = [];
    await runConnector({
      endpoint: "https://ai-erd.com/mcp",
      role,
      input,
      output: new PassThrough(),
      errorOutput: { write: (text: string) => { said.push(text); return true; } } as unknown as NodeJS.WritableStream as never,
      cwd: root,
    });
    return said.join("");
  }

  it("★역할이 걸린 저장소 안에서 역할 없이 붙으면 한 줄 경고한다 — 가림 진단", async () => {
    const said = await bridge(null);
    expect(said).toContain("this MCP connection has no role");
    expect(said).toContain("sets the role design");
    expect(said).toContain("claude mcp get ai-erd");
  });

  it("역할이 있으면 경고하지 않는다", async () => {
    expect(await bridge("design")).toBe("");
  });
});
