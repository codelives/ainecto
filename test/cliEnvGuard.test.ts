import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir as isolationTmpdir } from "node:os";
import { join as isolationJoin } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { runAinectoCli } from "../src/adapters/cli/ainectoCli";
import { parseMcpArgs } from "../src/adapters/mcp/args";

describe("CLI env flag guards", () => {
  // ★저장소 역할 탐색(0.4.2)은 cwd 에서 위로 올라간다. 이 저장소의 조상 폴더에 사람의 설정이 있어도
  //   시험이 흔들리지 않게, 아무 설정도 없는 임시 폴더에서 돈다.
  let isolatedCwd: string;
  let previousCwd: string;
  beforeEach(() => {
    previousCwd = process.cwd();
    isolatedCwd = mkdtempSync(isolationJoin(isolationTmpdir(), "ainecto-cwd-"));
    process.chdir(isolatedCwd);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AINECTO_TOKEN;
    process.chdir(previousCwd);
    rmSync(isolatedCwd, { recursive: true, force: true });
  });

  it("rejects ainecto --env without a value before resolving the default prod endpoint", async () => {
    const io = createIo();

    await expect(runAinectoCli(["tools", "list", "--env"], io)).resolves.toBe(1);
    expect(io.stderrText()).toContain("--env requires a value.");
    expect(io.stdoutText()).toBe("");
  });

  it("rejects mcp --env without a value", () => {
    expect(() => parseMcpArgs(["--env"])).toThrow("--env requires a value.");
  });

  // ★카탈로그는 서버의 지금 목록이 먼저다 — 스냅샷만 보여 주면 서버에 열린 html 을 에이전트가 «없다»고 읽었다
  //   (2026-10-10). 시험은 네트워크를 막아(진짜 토큰·서버에 기대지 않게) 두 갈래를 다 본다.
  it("shows the server's live tool list — a type the snapshot lacks (html) is visible without a new CLI release", async () => {
    process.env.AINECTO_TOKEN = "redacted";
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{
        name: "create_documents",
        description: "Create documents.",
        inputSchema: { type: "object", properties: { type: { type: "string", enum: ["erd", "markdown", "diagram", "openapi", "html"] } } },
      }] } }));
    }));
    const io = createIo();

    await expect(runAinectoCli(["tools", "catalog", "--env", "dev", "--json"], io)).resolves.toBe(0);
    const output = JSON.parse(io.stdoutText()) as { data?: Array<{ mcpName: string; inputSchema: unknown }>; warnings?: string[] };
    expect(output.data?.map((tool) => tool.mcpName)).toEqual(["create_documents"]);
    expect(JSON.stringify(output.data)).toContain("\"html\"");
    expect(output.warnings ?? []).toEqual([]);
  });

  it("falls back to the checked-in snapshot when the live list cannot be read, and says why", async () => {
    process.env.AINECTO_TOKEN = "redacted";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const io = createIo();

    await expect(runAinectoCli(["tools", "catalog", "--env", "dev", "--json"], io)).resolves.toBe(0);
    const output = JSON.parse(io.stdoutText()) as { data?: unknown[]; warnings?: string[] };
    expect(output.data?.length).toBeGreaterThan(1);
    expect(output.warnings?.join("\n")).toContain("Could not read the live tool list");
    expect(output.warnings?.join("\n")).toContain("dev catalog checked in when this CLI version was built");
  });
});

function createIo() {
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough();
  stdin.end();
  return {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}
