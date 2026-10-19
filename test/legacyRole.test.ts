import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { parseMcpArgs } from "../src/adapters/mcp/args";
import { runConnector } from "../src/adapters/mcp/connector";
import { tokenKey } from "../src/core/auth/tokenStore";
import { LEGACY_ROLE_HEADER, LEGACY_ROLE_NOTICE } from "../src/core/harness/legacyRole";

/**
 * ★0.8.0 출시 관문(설계 §2-3 R1) — 세션 역할은 없어졌지만 옛 입력을 «거절하지 않는다».
 *
 * <p>0.7.x 의 init 이 쓴 저장소 설정은 {@code npx -y @ainecto/mcp --role design}(버전 고정 없음)이라
 * 게시 즉시 이 판이 뜬다. 여기서 {@code --role} 을 거절하면 그 저장소 전부의 연결이 끊긴다.
 * 받은 값은 검사하지 않고, stderr 안내 한 줄 + 같은 헤더(기록용)로만 쓴다.
 */
const ENDPOINT = "https://ainecto.com/mcp";
const HEADER = LEGACY_ROLE_HEADER.toLowerCase();

let home: string;
let work: string;
let originalHome: string | undefined;
let originalCwd: string;
let originalFetch: typeof fetch;
let originalEnvRole: string | undefined;
const sent: Array<Record<string, string>> = [];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ainecto-home-"));
  work = await mkdtemp(join(tmpdir(), "ainecto-work-"));
  originalHome = process.env.HOME;
  process.env.HOME = home;
  originalEnvRole = process.env.AINECTO_ROLE;
  delete process.env.AINECTO_ROLE;
  originalCwd = process.cwd();
  process.chdir(work);
  sent.length = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    sent.push((init?.headers ?? {}) as Record<string, string>);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  }) as unknown as typeof fetch;
  await mkdir(join(home, ".ainecto"), { recursive: true });
  await writeFile(join(home, ".ainecto", "tokens.json"), JSON.stringify({
    [tokenKey(ENDPOINT)]: {
      endpoint: ENDPOINT, accessToken: "seeded-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000,
    },
  }), "utf8");
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalEnvRole === undefined) delete process.env.AINECTO_ROLE; else process.env.AINECTO_ROLE = originalEnvRole;
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

describe("★브리지가 옛 --role 을 받아 뜬다 (출시 관문)", () => {
  it.each([["design"], ["foo"], ["Validation"]])("parseMcpArgs 는 --role %s 를 거절하지 않는다", (value) => {
    expect(parseMcpArgs(["--role", value]).legacyRole).toBe(value);
  });

  it("값 없이 끝난 --role 도 멈추지 않는다", () => {
    expect(parseMcpArgs(["--role"]).legacyRole).toBeUndefined();
    const parsed = parseMcpArgs(["--role", "--env", "dev"]);
    expect(parsed.env).toBe("dev");
    expect(parsed.legacyRole).toBeUndefined();
  });

  it.each([
    ["--role design", { legacyRoleFlag: "design", envVars: {} }, "design"],
    ["--role foo (모르는 값)", { legacyRoleFlag: "foo", envVars: {} }, "foo"],
    ["AINECTO_ROLE=x", { legacyRoleFlag: undefined, envVars: { AINECTO_ROLE: "x" } }, "x"],
  ])("%s → 안내 한 줄 + 모든 요청에 같은 헤더(기록용)", async (_label, legacy, expected) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const errors: string[] = [];
    const errorOutput = new PassThrough();
    errorOutput.on("data", (chunk) => errors.push(String(chunk)));
    input.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "claude-code" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ].join("\n") + "\n");

    await runConnector({ endpoint: ENDPOINT, ...legacy, input, output, errorOutput });

    expect(sent).toHaveLength(2);
    for (const headers of sent) {
      expect(headers[HEADER]).toBe(expected);
    }
    expect(errors.join("")).toContain(LEGACY_ROLE_NOTICE);
  });

  it("옛 입력이 없으면 헤더도 안내도 없다", async () => {
    const input = new PassThrough();
    const errors: string[] = [];
    const errorOutput = new PassThrough();
    errorOutput.on("data", (chunk) => errors.push(String(chunk)));
    input.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);

    await runConnector({ endpoint: ENDPOINT, envVars: {}, input, output: new PassThrough(), errorOutput });

    expect(Object.keys(sent[0]!)).not.toContain(HEADER);
    expect(errors.join("")).toBe("");
  });

  it("★실제 bin 프로세스 — `mcp --role foo` 가 뜨고, 입력이 끝나면 종료 0 으로 내려간다", async () => {
    const root = resolve(__dirname, "..");
    const child = spawn(process.execPath, ["--import", "tsx", join(root, "src/bin/mcp.ts"), "--role", "foo"], {
      cwd: root,
      env: { ...process.env, HOME: home, NODE_OPTIONS: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.stdin.end();
    const code = await new Promise<number | null>((done) => child.on("close", done));
    expect(stderr.join("")).toContain(LEGACY_ROLE_NOTICE);
    expect(code).toBe(0);
  }, 30_000);
});

describe("셸 명령의 옛 --role / AINECTO_ROLE", () => {
  const io = (errors: string[]) => ({
    stdout: { write: () => true },
    stderr: { write: (text: string) => { errors.push(text); return true; } },
    stdin: { on: () => undefined, resume: () => undefined },
  }) as unknown as Parameters<typeof runAinectoCli>[1];

  it("tools list --role design → 거절 없이 같은 헤더(기록용) + 안내 한 줄", async () => {
    const errors: string[] = [];
    expect(await runAinectoCli(["tools", "list", "--role", "design"], io(errors))).toBe(0);
    expect(sent[0]?.[HEADER]).toBe("design");
    expect(errors.join("")).toContain(LEGACY_ROLE_NOTICE);
  });

  it("AINECTO_ROLE 도 같다 — 모르는 값도 받는다", async () => {
    process.env.AINECTO_ROLE = "whatever";
    const errors: string[] = [];
    expect(await runAinectoCli(["tools", "list"], io(errors))).toBe(0);
    expect(sent[0]?.[HEADER]).toBe("whatever");
  });

  it("★저장소 설정은 명령을 막지 않는다 — --role 이 없는 우리 브리지 항목, 역할이 어긋난 두 설정 모두", async () => {
    await writeFile(join(work, ".mcp.json"), JSON.stringify({
      mcpServers: { ainecto: { command: "npx", args: ["-y", "@ainecto/mcp"] } },
    }));
    await mkdir(join(work, ".cursor"));
    await writeFile(join(work, ".cursor", "mcp.json"), JSON.stringify({
      mcpServers: { ainecto: { command: "npx", args: ["-y", "@ainecto/mcp", "--role", "test"] } },
    }));
    const errors: string[] = [];
    expect(await runAinectoCli(["tools", "list"], io(errors))).toBe(0);
    // 저장소의 --role 은 읽지 않는다 — 헤더도 안내도 없다.
    expect(Object.keys(sent[0]!)).not.toContain(HEADER);
    expect(errors.join("")).toBe("");
  });
});
