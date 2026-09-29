import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ★브라우저는 절대 실제로 열지 않는다 — 여는 명령은 «브라우저 없음»(비0 종료)으로 끝난다.
 * 그래서 로그인은 URL 을 알린 뒤 BROWSER_UNAVAILABLE 로 끝나고, 연결부(ainectoCli)가 그 길을
 * 제대로 잇는지만 본다.
 */
const spawned: string[] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (command: string) => {
      spawned.push(command);
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => undefined;
      setImmediate(() => {
        child.emit("spawn");
        child.emit("exit", 3, null);
      });
      return child;
    },
  };
});

const { runAinectoCli } = await import("../src/adapters/cli/ainectoCli");

/**
 * init 의 «연결부»를 지나는 시험(2026-09-29 코드 리뷰 P2).
 * initCommand 시험은 login·accessToken 을 직접 주입하므로, ainectoCli 가 그것을 실제로 넘기는지는
 * 여기서만 보인다.
 */
describe("ai-erd init wiring (ainectoCli → OAuthClient)", () => {
  let home: string;
  let repo: string;
  let originalHome: string | undefined;
  let originalCwd: string;
  let originalToken: string | undefined;
  let originalFetch: typeof fetch;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetched: string[] = [];

  const io = {
    stdout: { write: (text: string) => { stdout.push(text); return true; } },
    stderr: { write: (text: string) => { stderr.push(text); return true; } },
    stdin: { on: () => undefined, resume: () => undefined },
  } as unknown as Parameters<typeof runAinectoCli>[1];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "ai-erd-home-"));
    repo = await mkdtemp(join(tmpdir(), "ai-erd-repo-"));
    originalHome = process.env.HOME;
    originalToken = process.env.AINECTO_TOKEN;
    delete process.env.AINECTO_TOKEN;
    process.env.HOME = home;
    originalCwd = process.cwd();
    process.chdir(repo);
    stdout.length = 0;
    stderr.length = 0;
    fetched.length = 0;
    spawned.length = 0;
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      if (url === "https://ai-erd.com/mcp") {
        return new Response("", {
          status: 401,
          headers: { "www-authenticate": 'Bearer resource_metadata="https://auth.example/resource"' },
        });
      }
      if (url === "https://auth.example/resource") {
        return new Response(JSON.stringify({ authorization_servers: ["https://auth.example"] }));
      }
      if (url === "https://auth.example/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify({
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          code_challenge_methods_supported: ["S256"],
        }));
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    if (originalToken === undefined) delete process.env.AINECTO_TOKEN; else process.env.AINECTO_TOKEN = originalToken;
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it("★토큰이 없으면 init 이 그 역할로 로그인을 시작하고, URL 을 stderr 에 먼저 알린다", async () => {
    const code = await runAinectoCli(["--role", "design", "init", "--json"], io);

    expect(code).toBe(1);
    const said = stderr.join("");
    expect(said).toContain("Opening your browser to sign in (role: design). If it does not open, visit:");
    expect(said).toContain("https://auth.example/authorize?");
    expect(said).toContain("scope=mcp+ai-erd%3Arole%3Adesign");
    // 브라우저 여는 명령이 불렸고, 그것이 실패하자 기다리지 않고 끝났다.
    expect(spawned).toHaveLength(1);
    expect(said).toContain('"code": "BROWSER_UNAVAILABLE"');
  });

  it("★dry-run 은 로그인을 시작하지 않는다 (브라우저도, 인증 서버 조회도 없다)", async () => {
    const code = await runAinectoCli(["--role", "design", "init", "--dry-run", "--json"], io);

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("--dry-run neither refreshes it nor opens a browser");
    expect(spawned).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it("★AINECTO_TOKEN 을 못 쓰는 주소라는 거절은 로그인으로 둔갑하지 않는다", async () => {
    process.env.AINECTO_TOKEN = "env-token";

    const code = await runAinectoCli(
      ["--role", "design", "--endpoint", "https://custom.example/mcp", "init", "--json"],
      io,
    );

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("AINECTO_TOKEN can only be used with the default prod/dev endpoints");
    expect(stderr.join("")).not.toContain("Opening your browser");
    expect(spawned).toEqual([]);
  });
});
